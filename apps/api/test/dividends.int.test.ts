import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { d } from '@ktrade/finance-core';
import type { LedgerService } from '../src/ledger/ledger.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Dividends on real PostgreSQL: declarations, entitlements computed from real ledger postings (T+1, PSX calendar,
 * bonus), WHT only from verified tax_rates, mark-paid → one DIVIDEND cash movement + dashboard, reconcile,
 * immutability of paid rows, owner isolation and audit. Fixed clock: Thu 2026-12-10 12:00 PKT. RUN_INTEGRATION=1.
 */
describe('dividends (integration, real PostgreSQL)', () => {
  const now = new Date('2026-12-10T07:00:00Z');
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let auth: Record<string, string>;
  let viewer: Record<string, string>;
  let other: Record<string, string>;
  let ownerId: string;
  let portfolioId: string;
  const stockIds: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', { env: process.env, stdio: 'pipe' });
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/bootstrap.js');
    const { RedisHealth } = await import('../src/redis/redis.module.js');
    const { PrismaService: PS } = await import('../src/prisma/prisma.service.js');
    const { LedgerService: LS } = await import('../src/ledger/ledger.service.js');
    const { CLOCK } = await import('../src/common/clock.js');
    const { ARGON2_OPTIONS } = await import('../src/auth/password-policy.js');
    const argon2 = await import('argon2');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisHealth)
      .useValue({
        ping: async () => true,
        onModuleInit: () => undefined,
        onModuleDestroy: async () => undefined,
      })
      .overrideProvider(getOptionsToken())
      .useValue({ throttlers: [{ name: 'default', ttl: 60_000, limit: 1000 }], skipIf: () => true })
      .overrideProvider(CLOCK)
      .useValue({ now: () => new Date(now) })
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PS);
    ledger = app.get(LS, { strict: false });

    const reg = await http()
      .post('/api/v1/auth/register')
      .send({ email: 'o@example.com', password: 'a long owner passphrase', displayName: 'O' })
      .expect(201);
    auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    ownerId = (await prisma.user.findFirstOrThrow({ where: { email: 'o@example.com' } })).id;
    const login = async (email: string, role: 'VIEWER' | 'OWNER') => {
      await prisma.user.create({
        data: {
          email,
          passwordHash: await argon2.hash('another-password-1', ARGON2_OPTIONS),
          displayName: email,
          role,
        },
      });
      const r = await http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'another-password-1' })
        .expect(200);
      return { Authorization: `Bearer ${r.body.accessToken}` };
    };
    viewer = await login('v@example.com', 'VIEWER');
    other = await login('x@example.com', 'OWNER');

    for (const symbol of ['DIVA', 'DIVB', 'DIVC']) {
      stockIds[symbol] = (
        await prisma.stock.create({ data: { symbol, name: `Test ${symbol}`, isActive: false } })
      ).id;
    }
    const p = await http()
      .post('/api/v1/portfolios')
      .set(auth)
      .send({ name: 'Paper', initialCash: '1000000' })
      .expect(201);
    portfolioId = p.body.id;

    // Real ledger postings (LedgerService.postTrade: transaction + cash movement + projection replay).
    const post = (symbol: string, side: 'BUY' | 'SELL', quantity: string, tradeDate: string) =>
      prisma.$transaction((tx) =>
        ledger.postTrade(tx, {
          portfolioId,
          stockId: stockIds[symbol]!,
          side,
          quantity: d(quantity),
          price: d('100'),
          tradeDate,
          fees: [],
          source: 'USER_REPORTED',
        }),
      );
    // DIVA, book closure Wed 2026-11-25, T+1 → last cum date Mon 23.
    await post('DIVA', 'BUY', '1000', '2026-11-02');
    await post('DIVA', 'SELL', '200', '2026-11-20'); // settles Mon 23 → reduces
    await post('DIVA', 'BUY', '500', '2026-11-23'); // T-2: settles Tue 24 → eligible
    await post('DIVA', 'BUY', '300', '2026-11-24'); // T-1: settles Wed 25 → NOT eligible
    // DIVB: 1000 bought, then a 1-for-10 bonus credited Mon 16 → 1100 eligible.
    await post('DIVB', 'BUY', '1000', '2026-11-02');
    const ca = await prisma.corporateAction.create({
      data: {
        stockId: stockIds.DIVB!,
        type: 'BONUS',
        bookClosureFrom: new Date('2026-11-13T00:00:00Z'),
        ratioNumerator: '1',
        ratioDenominator: '10',
        source: 'USER_REPORTED',
      },
    });
    await prisma.$transaction(async (tx) => {
      await tx.transaction.create({
        data: {
          portfolioId,
          stockId: stockIds.DIVB!,
          type: 'BONUS_IN',
          tradeDate: new Date('2026-11-16T00:00:00Z'),
          quantity: '100',
          price: '0',
          grossAmount: '0',
          netAmount: '0',
          source: 'USER_REPORTED',
          corporateActionId: ca.id,
        },
      });
      await ledger.rebuildSymbol(tx, portfolioId, stockIds.DIVB!);
    });
    const holdingB = await prisma.holding.findFirstOrThrow({
      where: { portfolioId, stockId: stockIds.DIVB! },
    });
    expect(holdingB.quantity.toString()).toBe('1100');
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  const declare = (body: Record<string, unknown>) => http().post('/api/v1/dividends').set(auth).send(body);

  it('declaration CRUD with validation, roles and uniqueness', async () => {
    const base = {
      symbol: 'DIVA',
      announcementDate: '2026-11-10',
      bookClosureFrom: '2026-11-25',
      bookClosureTo: '2026-11-30',
      paymentDate: '2026-12-08',
      dividendPerShare: '2.5',
    };
    for (const dps of ['0', '-1', 'abc', '1.1234567', '']) {
      await declare({ ...base, dividendPerShare: dps }).expect(422);
    }
    await declare({ ...base, bookClosureTo: '2026-11-24' }).expect(422);
    await declare({ ...base, paymentDate: '2026-11-29' }).expect(422);
    await declare({ ...base, announcementDate: '2026-11-26' }).expect(422);
    await declare({ ...base, bookClosureFrom: '2026-02-30' }).expect(422);
    await declare({ ...base, source: 'PROVIDER' }).expect(422);
    await declare({ ...base, symbol: 'NOPE' }).expect(404);
    await http().post('/api/v1/dividends').set(viewer).send(base).expect(403);

    const a = await declare(base).expect(201);
    expect(a.body).toMatchObject({
      symbol: 'DIVA',
      dividendPerShare: '2.5',
      source: 'USER_REPORTED',
      locked: false,
    });
    ids.divA = a.body.id;
    await declare(base).expect(409);

    const b = await declare({
      symbol: 'DIVB',
      bookClosureFrom: '2026-11-25',
      paymentDate: '2026-12-09',
      dividendPerShare: '1.2345',
    }).expect(201);
    ids.divB = b.body.id;
    // Before the portfolio held DIVA → outside holding history; DIVC never held.
    ids.divOld = (
      await declare({
        ...base,
        announcementDate: null,
        bookClosureFrom: '2026-10-01',
        bookClosureTo: null,
        paymentDate: null,
      }).expect(201)
    ).body.id;
    ids.divC = (
      await declare({ symbol: 'DIVC', bookClosureFrom: '2026-11-25', dividendPerShare: '9' }).expect(201)
    ).body.id;
    // Future book closure (after the clock) → provisional.
    ids.divFuture = (
      await declare({ symbol: 'DIVA', bookClosureFrom: '2026-12-21', dividendPerShare: '1' }).expect(201)
    ).body.id;

    // PATCH: merged dates validated
    await http()
      .patch(`/api/v1/dividends/${ids.divOld}`)
      .set(auth)
      .send({ bookClosureTo: '2026-09-30' })
      .expect(422);
    await http().patch(`/api/v1/dividends/${ids.divOld}`).set(auth).send({}).expect(422);
    await http()
      .patch(`/api/v1/dividends/${ids.divOld}`)
      .set(auth)
      .send({ dividendPerShare: '0' })
      .expect(422);
    const patched = await http()
      .patch(`/api/v1/dividends/${ids.divOld}`)
      .set(auth)
      .send({ dividendPerShare: '3.75' })
      .expect(200);
    expect(patched.body.dividendPerShare).toBe('3.75');
    // Moving it onto DIVA's existing book-closure date collides with the unique key.
    await http()
      .patch(`/api/v1/dividends/${ids.divOld}`)
      .set(auth)
      .send({ bookClosureFrom: '2026-11-25' })
      .expect(409);

    const tmp = await declare({
      symbol: 'DIVC',
      bookClosureFrom: '2026-12-01',
      dividendPerShare: '1',
    }).expect(201);
    await http().delete(`/api/v1/dividends/${tmp.body.id}`).set(viewer).expect(403);
    await http().delete(`/api/v1/dividends/${tmp.body.id}`).set(auth).expect(200);
    await http().get(`/api/v1/dividends/${tmp.body.id}`).set(auth).expect(404);

    const list = await http().get('/api/v1/dividends').set(viewer).expect(200);
    expect(list.body.map((x: { id: string }) => x.id).sort()).toEqual(
      [ids.divA, ids.divB, ids.divOld, ids.divC, ids.divFuture].sort(),
    );
    const onlyB = await http().get('/api/v1/dividends?symbol=divb').set(auth).expect(200);
    expect(onlyB.body).toHaveLength(1);
  });

  it('computes entitlements from settled ledger holdings; WHT NOT_CONFIGURED without verified rates', async () => {
    await http()
      .post(`/api/v1/portfolios/${portfolioId}/dividend-entitlements/compute`)
      .set(viewer)
      .expect(403);
    const res = await http()
      .post(`/api/v1/portfolios/${portfolioId}/dividend-entitlements/compute`)
      .set(auth)
      .expect(200);
    expect(res.body.settlement).toMatchObject({ days: 1, basis: 'DEFAULT' });
    expect(res.body.settlement.note).toMatch(/owner must confirm/);
    expect(res.body.filerStatus).toBe('UNKNOWN');
    expect(res.body.counts).toMatchObject({ created: 3, updated: 0, unchanged: 0, skippedSettled: 0 });

    const bySymbolDate = (rows: Array<Record<string, unknown>>, sym: string, bc: string) =>
      rows.find((r) => r.symbol === sym && r.bookClosureFrom === bc)!;
    const a = bySymbolDate(res.body.data, 'DIVA', '2026-11-25');
    // 1000 − 200 + 500 = 1300 settled before Wed 25 (the T-1 buy of 300 is excluded). 1300 × 2.5 = 3250.
    expect(a).toMatchObject({
      sharesEligible: '1300',
      grossAmount: '3250.0000',
      whtRate: null,
      whtAmount: null,
      netAmount: null,
      netBeforeWht: '3250.0000',
      taxStatus: 'NOT_CONFIGURED',
      status: 'ENTITLED',
      source: 'ESTIMATED',
      provisional: false,
    });
    expect(a.taxNote).toMatch(/UNKNOWN/);
    // bonus: 1100 × 1.2345 = 1357.95
    expect(bySymbolDate(res.body.data, 'DIVB', '2026-11-25')).toMatchObject({
      sharesEligible: '1100',
      grossAmount: '1357.9500',
      taxStatus: 'NOT_CONFIGURED',
    });
    // future book closure: all 1600 DIVA shares settled by then → provisional
    expect(bySymbolDate(res.body.data, 'DIVA', '2026-12-21')).toMatchObject({
      sharesEligible: '1600',
      grossAmount: '1600.0000',
      provisional: true,
    });
    const stored = await prisma.dividendEntitlement.findMany({ where: { portfolioId } });
    expect(stored).toHaveLength(3); // nothing for the pre-history DIVA dividend nor never-held DIVC
    const storedA = stored.find((s) => s.dividendId === ids.divA)!;
    // NOT NULL columns hold a 0 placeholder, flagged in every response — never an invented rate.
    expect(storedA.whtRate.toString()).toBe('0');
    ids.entA = storedA.id;
    ids.entB = stored.find((s) => s.dividendId === ids.divB)!.id;

    // FILER with no / only unverified rate → still NOT_CONFIGURED (NO_VERIFIED_RATE).
    await prisma.userSettings.upsert({
      where: { userId: ownerId },
      create: { userId: ownerId, taxFilerStatus: 'FILER' },
      update: { taxFilerStatus: 'FILER' },
    });
    await prisma.taxRate.create({
      data: {
        taxType: 'DIVIDEND_WITHHOLDING',
        filerStatus: 'FILER',
        rate: '0.2',
        effectiveFrom: new Date('2026-07-01T00:00:00Z'),
        verified: false,
        sourceNote: 'test: unverified must be ignored',
      },
    });
    const list = await http()
      .get(`/api/v1/portfolios/${portfolioId}/dividend-entitlements`)
      .set(auth)
      .expect(200);
    const la = list.body.data.find((r: { id: string }) => r.id === ids.entA);
    expect(la).toMatchObject({ taxStatus: 'NOT_CONFIGURED', netAmount: null });
    expect(la.taxNote).toMatch(/No verified dividend WHT rate for FILER/);
  });

  it('with a test-inserted verified rate: correct WHT/net; recompute is idempotent', async () => {
    await prisma.taxRate.create({
      data: {
        taxType: 'DIVIDEND_WITHHOLDING',
        filerStatus: 'FILER',
        rate: '0.15',
        effectiveFrom: new Date('2026-07-01T00:00:00Z'),
        verified: true,
        sourceNote: 'test-only rate',
      },
    });
    const before = await http()
      .get(`/api/v1/portfolios/${portfolioId}/dividend-entitlements`)
      .set(auth)
      .expect(200);
    expect(before.body.data.find((r: { id: string }) => r.id === ids.entA).taxStatus).toBe(
      'RECOMPUTE_REQUIRED',
    );

    const res = await http()
      .post(`/api/v1/portfolios/${portfolioId}/dividend-entitlements/compute`)
      .set(auth)
      .expect(200);
    expect(res.body.counts).toMatchObject({ created: 0, updated: 3, unchanged: 0 });
    const a = res.body.data.find((r: { id: string }) => r.id === ids.entA);
    // 3250 × 0.15 = 487.50 → net 2762.50
    expect(a).toMatchObject({
      taxStatus: 'CONFIGURED',
      whtRate: '0.15000000',
      whtAmount: '487.5000',
      netAmount: '2762.5000',
    });
    // 1357.95 × 0.15 = 203.6925 → 203.69 → net 1154.26
    expect(res.body.data.find((r: { id: string }) => r.id === ids.entB)).toMatchObject({
      whtAmount: '203.6900',
      netAmount: '1154.2600',
    });

    const snapshot = await prisma.dividendEntitlement.findMany({
      where: { portfolioId },
      orderBy: { id: 'asc' },
    });
    const again = await http()
      .post(`/api/v1/portfolios/${portfolioId}/dividend-entitlements/compute`)
      .set(auth)
      .expect(200);
    expect(again.body.counts).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    const after = await prisma.dividendEntitlement.findMany({
      where: { portfolioId },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(snapshot); // same ids, same values, not even updatedAt touched
  });

  it('mark-paid creates exactly one DIVIDEND cash movement, notifies, and updates the dashboard', async () => {
    const dash0 = await http()
      .get(`/api/v1/dashboard/summary?portfolioId=${portfolioId}`)
      .set(auth)
      .expect(200);
    expect(dash0.body.dividendsReceived.value).toBe('0.0000');
    const cash0 = d(dash0.body.cash.ledger.value);

    await http()
      .post(`/api/v1/dividend-entitlements/${ids.entA}/mark-paid`)
      .set(viewer)
      .send({ paidAt: '2026-12-08', netAmount: '2762.50', whtAmount: '487.50' })
      .expect(403);
    for (const body of [
      { paidAt: '2026-12-08', netAmount: '0' },
      { paidAt: '2026-12-08', netAmount: 'x' },
      { paidAt: '2026-12-08', netAmount: '1.00001' },
      { paidAt: '2026-12-08', netAmount: '10', whtAmount: '-1' },
    ]) {
      await http()
        .post(`/api/v1/dividend-entitlements/${ids.entA}/mark-paid`)
        .set(auth)
        .send(body)
        .expect(422);
    }
    await http()
      .post(`/api/v1/dividend-entitlements/${ids.entA}/mark-paid`)
      .set(auth)
      .send({ paidAt: '2026-12-11', netAmount: '2762.50', whtAmount: '487.50' })
      .expect(422); // future (body otherwise valid)

    const paid = await http()
      .post(`/api/v1/dividend-entitlements/${ids.entA}/mark-paid`)
      .set(auth)
      .send({ paidAt: '2026-12-08', netAmount: '2762.50', whtAmount: '487.50' })
      .expect(200);
    expect(paid.body.entitlement).toMatchObject({
      status: 'PAID',
      source: 'USER_REPORTED',
      paidAt: '2026-12-08',
      netAmount: '2762.5000',
      whtAmount: '487.5000',
      taxStatus: 'AS_PAID',
    });
    expect(paid.body.whtBasis).toBe('REPORTED');
    expect(paid.body.differences).toEqual({
      netAmount: '0.0000',
      whtAmount: '0.0000',
      grossAmount: '0.0000',
    });

    const movements = await prisma.cashMovement.findMany({ where: { portfolioId, type: 'DIVIDEND' } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ source: 'USER_REPORTED', id: paid.body.cashMovementId });
    expect(movements[0]!.amount.toFixed(4)).toBe('2762.5000');
    expect(movements[0]!.valueDate.toISOString().slice(0, 10)).toBe('2026-12-08');

    // Second mark-paid is refused and creates nothing.
    await http()
      .post(`/api/v1/dividend-entitlements/${ids.entA}/mark-paid`)
      .set(auth)
      .send({ paidAt: '2026-12-08', netAmount: '2762.50', whtAmount: '487.50' })
      .expect(409);
    expect(await prisma.cashMovement.count({ where: { portfolioId, type: 'DIVIDEND' } })).toBe(1);

    const n = await prisma.notification.findMany({ where: { userId: ownerId, channel: 'IN_APP' } });
    expect(n.filter((x) => (x.data as { type?: string }).type === 'DIVIDEND_RECEIVED')).toHaveLength(1);

    const dash1 = await http()
      .get(`/api/v1/dashboard/summary?portfolioId=${portfolioId}`)
      .set(auth)
      .expect(200);
    expect(dash1.body.dividendsReceived.value).toBe('2762.5000');
    expect(d(dash1.body.cash.ledger.value).minus(cash0).toFixed(4)).toBe('2762.5000');

    // DIVB: withholding is required (never inferred from cash received).
    const missingWht = await http()
      .post(`/api/v1/dividend-entitlements/${ids.entB}/mark-paid`)
      .set(auth)
      .send({ paidAt: '2026-12-09', netAmount: '1150.00' })
      .expect(422);
    expect(missingWht.body.code).toBe('VALIDATION_FAILED');
    // Received 4.26 less than gross − WHT: surfaced as an unexplained difference, NOT booked as extra tax.
    const pb = await http()
      .post(`/api/v1/dividend-entitlements/${ids.entB}/mark-paid`)
      .set(auth)
      .send({ paidAt: '2026-12-09', netAmount: '1150.00', whtAmount: '203.69' })
      .expect(200);
    expect(pb.body.whtBasis).toBe('REPORTED');
    expect(pb.body.entitlement.whtAmount).toBe('203.6900');
    expect(pb.body.unexplainedDifference).toBe('4.2600'); // 1357.95 − 203.69 − 1150
    expect(pb.body.warnings[0]).toMatch(/check the share count/);
    // Actual gross paid = received + withheld = 1353.69, i.e. 4.26 below the expected gross — the same 4.26 as unexplainedDifference.
    expect(pb.body.differences).toEqual({
      netAmount: '-4.2600',
      whtAmount: '0.0000',
      grossAmount: '-4.2600',
    });
    const dash2 = await http()
      .get(`/api/v1/dashboard/summary?portfolioId=${portfolioId}`)
      .set(auth)
      .expect(200);
    expect(dash2.body.dividendsReceived.value).toBe('3912.5000');
  });

  it('PAID rows and their declarations are immutable', async () => {
    const before = await prisma.dividendEntitlement.findUniqueOrThrow({ where: { id: ids.entA } });
    const res = await http()
      .post(`/api/v1/portfolios/${portfolioId}/dividend-entitlements/compute`)
      .set(auth)
      .expect(200);
    expect(res.body.counts).toMatchObject({ skippedSettled: 2, unchanged: 1 });
    expect(await prisma.dividendEntitlement.findUniqueOrThrow({ where: { id: ids.entA } })).toEqual(before);

    await http().patch(`/api/v1/dividends/${ids.divA}`).set(auth).send({ dividendPerShare: '3' }).expect(409);
    await http().delete(`/api/v1/dividends/${ids.divA}`).set(auth).expect(409);
    expect((await http().get(`/api/v1/dividends/${ids.divA}`).set(auth).expect(200)).body.locked).toBe(true);
  });

  it('reconcile: PAID → RECONCILED / BROKER_CONFIRMED (manual), only once', async () => {
    const unpaid = await prisma.dividendEntitlement.findFirstOrThrow({
      where: { portfolioId, dividendId: ids.divFuture },
    });
    await http().post(`/api/v1/dividend-entitlements/${unpaid.id}/reconcile`).set(auth).send({}).expect(409);
    await http().post(`/api/v1/dividend-entitlements/${ids.entA}/reconcile`).set(viewer).send({}).expect(403);
    const r = await http()
      .post(`/api/v1/dividend-entitlements/${ids.entA}/reconcile`)
      .set(auth)
      .send({ statementRef: 'CDC-2026-12' })
      .expect(200);
    expect(r.body).toMatchObject({
      status: 'RECONCILED',
      source: 'BROKER_CONFIRMED',
      netAmount: '2762.5000',
    });
    expect(r.body.reconciledAt).toBe(now.toISOString());
    const cm = await prisma.cashMovement.findUniqueOrThrow({ where: { id: r.body.cashMovementId } });
    expect(cm.source).toBe('BROKER_CONFIRMED');
    await http().post(`/api/v1/dividend-entitlements/${ids.entA}/reconcile`).set(auth).send({}).expect(409);
    const dash = await http()
      .get(`/api/v1/dashboard/summary?portfolioId=${portfolioId}`)
      .set(auth)
      .expect(200);
    expect(dash.body.dividendsReceived.value).toBe('3912.5000'); // RECONCILED still counted, not doubled
  });

  it('editing an unpaid declaration clears its estimates; owner isolation', async () => {
    const patched = await http()
      .patch(`/api/v1/dividends/${ids.divFuture}`)
      .set(auth)
      .send({ dividendPerShare: '1.5' })
      .expect(200);
    expect(patched.body.estimatedEntitlementsCleared).toBe(1);
    expect(await prisma.dividendEntitlement.count({ where: { dividendId: ids.divFuture } })).toBe(0);

    await http().get(`/api/v1/portfolios/${portfolioId}/dividend-entitlements`).set(other).expect(404);
    await http()
      .post(`/api/v1/portfolios/${portfolioId}/dividend-entitlements/compute`)
      .set(other)
      .expect(404);
    await http().post(`/api/v1/dividend-entitlements/${ids.entB}/reconcile`).set(other).send({}).expect(404);
    await http()
      .post(`/api/v1/dividend-entitlements/${ids.entB}/mark-paid`)
      .set(other)
      .send({ paidAt: '2026-12-08', netAmount: '1', whtAmount: '0' })
      .expect(404);
    await http().get(`/api/v1/portfolios/${portfolioId}/dividend-entitlements`).set(viewer).expect(404);
  });

  it('every write is audited', async () => {
    const rows = await prisma.auditLog.findMany({ where: { action: { startsWith: 'dividend' } } });
    const count = (a: string) => rows.filter((r) => r.action === a).length;
    expect(count('dividend.declared')).toBe(6);
    expect(count('dividend.updated')).toBe(2);
    expect(count('dividend.deleted')).toBe(1);
    expect(count('dividend_entitlements.computed')).toBe(4);
    expect(count('dividend_entitlement.paid')).toBe(2);
    expect(count('dividend_entitlement.reconciled')).toBe(1);
    expect(rows.every((r) => r.actorUserId === ownerId)).toBe(true);
    const paid = rows.find((r) => r.action === 'dividend_entitlement.paid' && r.entityId === ids.entA)!;
    expect(paid.metadata).toMatchObject({ whtBasis: 'REPORTED' });
  });
});
