import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Order pipeline end-to-end on real PostgreSQL: preview → risk → step-up approval → paper fill / manual live ticket,
 * ledger posting, idempotency, kill switch. Includes the docs/06 §3 worked example through the HTTP API.
 * Clock fixed to Monday 2026-11-16 10:00 PKT (PSX session open). Opt-in: RUN_INTEGRATION=1.
 */
describe('trading (integration, real PostgreSQL)', () => {
  const NOW = new Date('2026-11-16T05:00:00Z');
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: Record<string, string>;
  let stepUp: Record<string, string>;
  let paperId: string;
  let liveId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', { env: process.env, stdio: 'pipe' });
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/bootstrap.js');
    const { RedisHealth } = await import('../src/redis/redis.module.js');
    const { PrismaService: PS } = await import('../src/prisma/prisma.service.js');
    const { CLOCK } = await import('../src/common/clock.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisHealth)
      .useValue({ ping: async () => true, onModuleInit: () => undefined, onModuleDestroy: async () => undefined })
      .overrideProvider(getOptionsToken())
      .useValue({ throttlers: [{ name: 'default', ttl: 60_000, limit: 1000 }], skipIf: () => true })
      .overrideProvider(CLOCK)
      .useValue({ now: () => new Date(NOW) })
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PS);

    const reg = await http().post('/api/v1/auth/register').send({ email: 'o@example.com', password: 'a long owner passphrase', displayName: 'O' }).expect(201);
    auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    const su = await http().post('/api/v1/auth/step-up').set(auth).send({ password: 'a long owner passphrase' }).expect(200);
    stepUp = { 'X-Step-Up-Token': su.body.stepUpToken };

    await prisma.stock.createMany({ data: [{ symbol: 'HUBC', name: 'Hub Power Company' }, { symbol: 'OGDC', name: 'Oil & Gas Development Company' }] });
    await setQuote('HUBC', '150.00', 'SIMULATED');
    await setQuote('OGDC', '250.00', 'PROVIDER');

    const paper = await http().post('/api/v1/portfolios').set(auth).send({ name: 'Paper', initialCash: '1000000' }).expect(201);
    paperId = paper.body.id;

    const user = await prisma.user.findFirstOrThrow();
    const broker = await prisma.brokerAccount.create({ data: { userId: user.id, brokerCode: 'KTRADE', displayName: 'My KTrade' } });
    const live = await prisma.portfolio.create({
      data: {
        userId: user.id,
        brokerAccountId: broker.id,
        name: 'KTrade live',
        kind: 'LIVE',
        riskLimit: { create: { maxOrderValue: '100000', maxOrderQty: '1000', maxDailyTradedValue: '500000', maxDailyOrders: 10, maxPositionPct: '100', priceBandPct: '10', maxDailyLossPct: '5', allowMarketOrders: false } },
      },
    });
    liveId = live.id;
    await prisma.cashMovement.create({ data: { portfolioId: liveId, type: 'DEPOSIT', amount: '100000', valueDate: NOW, source: 'USER_REPORTED' } });
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  async function setQuote(symbol: string, last: string, source: 'SIMULATED' | 'PROVIDER') {
    const stock = await prisma.stock.findUniqueOrThrow({ where: { symbol } });
    await prisma.stockQuote.upsert({
      where: { stockId: stock.id },
      create: { stockId: stock.id, last, asOf: NOW, providerKey: 'test', source },
      update: { last, asOf: NOW, source },
    });
  }

  const preview = (body: Record<string, unknown>, key: string = randomUUID()) =>
    http().post('/api/v1/orders/preview').set(auth).set('Idempotency-Key', key).send(body);
  const approve = (o: { id: string; previewHash: string }) =>
    http().post(`/api/v1/orders/${o.id}/approve`).set(auth).set(stepUp).send({ previewHash: o.previewHash });

  it('paper: preview shows fees + all risk checks, approval fills against the simulated price and posts the ledger', async () => {
    const p = await preview({ portfolioId: paperId, symbol: 'HUBC', side: 'BUY', type: 'MARKET', quantity: '100' }).expect(201);
    expect(p.body.status).toBe('PREVIEWED');
    expect(p.body.executionPath).toBe('PAPER_AUTO');
    expect(p.body.riskChecks.length).toBeGreaterThanOrEqual(12);
    expect(p.body.riskChecks.every((r: { passed: boolean }) => r.passed)).toBe(true);
    expect(p.body.feeBreakdown).toEqual(
      expect.arrayContaining([
        { component: 'COMMISSION', amount: '45.00', source: 'ESTIMATED' }, // max(0.3% × 15,000 = 45, 0.06 × 100 = 6)
        { component: 'SST_ON_COMMISSION', amount: '6.75', source: 'ESTIMATED' },
      ]),
    );

    await http().post(`/api/v1/orders/${p.body.id}/approve`).set(auth).send({ previewHash: p.body.previewHash }).expect(403); // no step-up
    const a = await approve(p.body).expect(200);
    expect(a.body.status).toBe('FILLED');
    expect(a.body.statusSource).toBe('SIMULATED');
    expect(a.body.executions).toHaveLength(1);
    expect(a.body.events.map((e: { to: string }) => e.to)).toEqual(['PREVIEWED', 'APPROVED', 'ACCEPTED', 'FILLED']);

    const h = await http().get(`/api/v1/portfolios/${paperId}/holdings`).set(auth).expect(200);
    expect(h.body).toHaveLength(1);
    expect(h.body[0]).toMatchObject({ symbol: 'HUBC', quantity: '100' });
    expect(h.body[0].lastPrice.source).toBe('SIMULATED');
  });

  it('idempotency: replaying the same key returns the same order and creates nothing', async () => {
    const key = randomUUID();
    const body = { portfolioId: paperId, symbol: 'HUBC', side: 'BUY', type: 'MARKET', quantity: '10' };
    const first = await preview(body, key).expect(201);
    const again = await preview(body, key).expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(await prisma.order.count({ where: { idempotencyKey: key } })).toBe(1);
    await preview(body, undefined as unknown as string).set('Idempotency-Key', '').expect(422);
  });

  it('approval is bound to the preview hash and expires', async () => {
    const p = await preview({ portfolioId: paperId, symbol: 'HUBC', side: 'BUY', type: 'MARKET', quantity: '5' }).expect(201);
    const bad = await approve({ id: p.body.id, previewHash: 'f'.repeat(64) }).expect(409);
    expect(bad.body.code).toBe('PREVIEW_MISMATCH');
    await prisma.order.update({ where: { id: p.body.id }, data: { previewExpiresAt: new Date(NOW.getTime() - 1) } });
    const exp = await approve(p.body).expect(409);
    expect(exp.body.code).toBe('PREVIEW_EXPIRED');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: p.body.id } })).status).toBe('EXPIRED');
  });

  it('risk: selling more than held is rejected and never reaches the ledger', async () => {
    const p = await preview({ portfolioId: paperId, symbol: 'HUBC', side: 'SELL', type: 'MARKET', quantity: '5000' }).expect(201);
    expect(p.body.status).toBe('REJECTED_BY_RISK');
    expect(p.body.riskChecks.find((r: { rule: string }) => r.rule === 'HOLDING_QTY').passed).toBe(false);
    await approve({ id: p.body.id, previewHash: 'a'.repeat(64) }).expect(409);
  });

  it('live: blocked while the kill switch is OFF (default), and refuses simulated prices', async () => {
    const p = await preview({ portfolioId: liveId, symbol: 'OGDC', side: 'BUY', type: 'LIMIT', quantity: '10', limitPrice: '250.00' }).expect(201);
    expect(p.body.status).toBe('REJECTED_BY_RISK');
    expect(p.body.riskChecks.find((r: { rule: string }) => r.rule === 'KILL_SWITCH').passed).toBe(false);

    await http().put('/api/v1/admin/kill-switch').set(auth).send({ liveTradingEnabled: true, reason: 'test' }).expect(403); // needs step-up
    await http().put('/api/v1/admin/kill-switch').set(auth).set(stepUp).send({ liveTradingEnabled: true, reason: 'integration test' }).expect(200);

    const sim = await preview({ portfolioId: liveId, symbol: 'HUBC', side: 'BUY', type: 'LIMIT', quantity: '10', limitPrice: '150.00' }).expect(201);
    expect(sim.body.status).toBe('REJECTED_BY_RISK');
    expect(sim.body.riskChecks.find((r: { rule: string }) => r.rule === 'PRICE_SOURCE').passed).toBe(false);
    const mkt = await preview({ portfolioId: liveId, symbol: 'OGDC', side: 'BUY', type: 'MARKET', quantity: '1' }).expect(201);
    expect(mkt.body.status).toBe('REJECTED_BY_RISK'); // market orders disabled for this live portfolio
  });

  /** docs/06 §3 worked example, end-to-end through the manual live path (fills USER_REPORTED, fees ESTIMATED). */
  it('live manual ticket: approve → AWAITING_MANUAL_PLACEMENT → placed → fill; reproduces the WAC worked example', async () => {
    const trade = async (side: 'BUY' | 'SELL', qty: string, price: string) => {
      await setQuote('OGDC', price, 'PROVIDER');
      const p = await preview({ portfolioId: liveId, symbol: 'OGDC', side, type: 'LIMIT', quantity: qty, limitPrice: price }).expect(201);
      expect(p.body.status, JSON.stringify(p.body.riskChecks.filter((r: { passed: boolean }) => !r.passed))).toBe('PREVIEWED');
      expect(p.body.executionPath).toBe('MANUAL_TICKET');
      const a = await approve(p.body).expect(200);
      expect(a.body.status).toBe('AWAITING_MANUAL_PLACEMENT'); // never "executed" without a fill
      if (side === 'SELL') {
        // Recording a fill directly implies placement (explicit PLACED_BY_USER event is still logged).
        const f = await http().post(`/api/v1/orders/${p.body.id}/fills`).set(auth).send({ quantity: qty, price, executedAt: NOW.toISOString() }).expect(200);
        expect(f.body.events.map((e: { to: string }) => e.to)).toEqual(['PREVIEWED', 'APPROVED', 'AWAITING_MANUAL_PLACEMENT', 'PLACED_BY_USER', 'FILLED']);
        expect(f.body.events[3].reason).toBe('implied by recorded fill');
      } else {
        await http().post(`/api/v1/orders/${p.body.id}/mark-placed`).set(auth).send({ brokerOrderRef: `KT-${qty}` }).expect(200);
        await http().post(`/api/v1/orders/${p.body.id}/mark-placed`).set(auth).send({}).expect(409); // not twice
        const over = await http().post(`/api/v1/orders/${p.body.id}/fills`).set(auth).send({ quantity: '100000', price, executedAt: NOW.toISOString() }).expect(422);
        expect(over.body.code).toBe('OVERFILL');
        const f = await http().post(`/api/v1/orders/${p.body.id}/fills`).set(auth).send({ quantity: qty, price, executedAt: NOW.toISOString() }).expect(200);
        expect(f.body).toMatchObject({ status: 'FILLED', statusSource: 'USER_REPORTED' });
      }
    };
    await trade('BUY', '100', '250.00');
    await trade('BUY', '50', '270.00');
    await trade('SELL', '60', '280.00');

    const ogdc = await prisma.stock.findUniqueOrThrow({ where: { symbol: 'OGDC' } });
    const holding = await prisma.holding.findUniqueOrThrow({ where: { portfolioId_stockId: { portfolioId: liveId, stockId: ogdc.id } } });
    expect(holding.quantity.toString()).toBe('90');
    expect(holding.totalCost.toFixed(4)).toBe('23179.6980');
    expect(holding.avgCost.toFixed(6)).toBe('257.552200');
    expect(holding.realizedPnl.toFixed(4)).toBe('1288.9080');
    const sell = await prisma.transaction.findFirstOrThrow({ where: { portfolioId: liveId, type: 'SELL' } });
    expect(sell.netAmount.toFixed(4)).toBe('16742.0400');
    expect(sell.source).toBe('USER_REPORTED');

    const summary = await http().get(`/api/v1/dashboard/summary?portfolioId=${liveId}`).set(auth).expect(200);
    expect(summary.body.realizedPnl.value).toBe('1288.9080');
    expect(summary.body.unrealizedPnl.source).toBe('ESTIMATED');
    expect(summary.body.activeHoldings).toBe(1);
  });

  it('every order transition is in the append-only event log and audited', async () => {
    expect(await prisma.orderEvent.count()).toBeGreaterThan(10);
    await expect(prisma.orderEvent.deleteMany({})).rejects.toThrow(/append-only/);
    const actions = new Set((await prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action));
    for (const a of ['order.previewed', 'order.approved', 'order.rejected_by_risk', 'order.placed_manually', 'order.fill_recorded', 'killswitch.toggled']) {
      expect(actions, a).toContain(a);
    }
  });
});
