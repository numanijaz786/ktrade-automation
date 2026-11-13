import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { d } from '@ktrade/finance-core';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Phase 10 on real PostgreSQL: daily snapshots (hand-computed against stored SIMULATED D1 closes), performance,
 * snapshot-backed dashboard P&L, alerts (CRUD, isolation, firing, cooldown, dedupe, triggerOnce) and notifications.
 * The clock is mutable and starts Monday 2026-11-16 10:00 PKT (session open). Opt-in: RUN_INTEGRATION=1.
 */
describe('snapshots, performance, alerts & notifications (integration, real PostgreSQL)', () => {
  let now = new Date('2026-11-16T05:00:00Z');
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: Record<string, string>;
  let stepUp: Record<string, string>;
  let viewer: Record<string, string>;
  let portfolioId: string;
  let ownerId: string;
  let tradeCosts: ReturnType<typeof d>; // capitalised fees + taxes of the one BUY
  const http = () => request(app.getHttpServer());

  // SIMULATED D1 closes stored for the test stock (bars are stamped at session open 09:30 PKT = 04:30Z).
  const CLOSES: Record<string, string> = {
    '2026-11-11': '100',
    '2026-11-12': '100',
    '2026-11-13': '100',
    '2026-11-16': '102',
    '2026-11-17': '99',
    '2026-11-18': '101',
  };

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', { env: process.env, stdio: 'pipe' });
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/bootstrap.js');
    const { RedisHealth } = await import('../src/redis/redis.module.js');
    const { PrismaService: PS } = await import('../src/prisma/prisma.service.js');
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

    const reg = await http()
      .post('/api/v1/auth/register')
      .send({ email: 'o@example.com', password: 'a long owner passphrase', displayName: 'O' })
      .expect(201);
    auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    ownerId = (await prisma.user.findFirstOrThrow({ where: { email: 'o@example.com' } })).id;
    const su = await http()
      .post('/api/v1/auth/step-up')
      .set(auth)
      .send({ password: 'a long owner passphrase' })
      .expect(200);
    stepUp = { 'X-Step-Up-Token': su.body.stepUpToken };
    await prisma.user.create({
      data: {
        email: 'v@example.com',
        passwordHash: await argon2.hash('viewer-password-1', ARGON2_OPTIONS),
        displayName: 'V',
        role: 'VIEWER',
      },
    });
    viewer = {
      Authorization: `Bearer ${(await http().post('/api/v1/auth/login').send({ email: 'v@example.com', password: 'viewer-password-1' }).expect(200)).body.accessToken}`,
    };

    // Inactive so the background quote refresh (simulated provider) never overwrites the quotes this test sets.
    const stock = await prisma.stock.create({ data: { symbol: 'TSTA', name: 'Test A', isActive: false } });
    await prisma.stockPrice.createMany({
      data: Object.entries(CLOSES).map(([date, close]) => ({
        stockId: stock.id,
        interval: 'D1' as const,
        ts: new Date(`${date}T04:30:00Z`),
        open: close,
        high: close,
        low: close,
        close,
        volume: 100_000n,
        providerKey: 'simulated',
        source: 'SIMULATED' as const,
      })),
    });
    await setQuote('100.00');

    const p = await http()
      .post('/api/v1/portfolios')
      .set(auth)
      .send({ name: 'Paper', initialCash: '1000000' })
      .expect(201);
    portfolioId = p.body.id;
    // createPaper stamps the deposit with the wall-clock date; pin it to Friday 2026-11-13 for hand-computed numbers.
    await prisma.cashMovement.updateMany({
      where: { portfolioId },
      data: { valueDate: new Date('2026-11-13T00:00:00Z') },
    });
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  async function setQuote(last: string) {
    const stock = await prisma.stock.findUniqueOrThrow({ where: { symbol: 'TSTA' } });
    await prisma.stockQuote.upsert({
      where: { stockId: stock.id },
      create: {
        stockId: stock.id,
        last,
        asOf: now,
        providerKey: 'test',
        source: 'SIMULATED',
        volume: 50_000n,
      },
      update: { last, asOf: now, source: 'SIMULATED' },
    });
  }

  it('a paper fill through the order pipeline creates an ORDER_EXECUTED notification', async () => {
    const pv = await http()
      .post('/api/v1/orders/preview')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ portfolioId, symbol: 'TSTA', side: 'BUY', type: 'MARKET', quantity: '1000' })
      .expect(201);
    const a = await http()
      .post(`/api/v1/orders/${pv.body.id}/approve`)
      .set(auth)
      .set(stepUp)
      .send({ previewHash: pv.body.previewHash })
      .expect(200);
    expect(a.body.status).toBe('FILLED');
    const tx = await prisma.transaction.findFirstOrThrow({ where: { portfolioId } });
    expect(tx.tradeDate.toISOString().slice(0, 10)).toBe('2026-11-16');
    expect(tx.price.toString()).toBe('100.05'); // 100 + 5 bps paper slippage
    expect(tx.grossAmount.toFixed(4)).toBe('100050.0000');
    tradeCosts = d(tx.feesTotal.toString()).plus(tx.taxesTotal.toString());
    expect(tradeCosts.gt(0)).toBe(true);

    const n = await prisma.notification.findMany({ where: { userId: ownerId, channel: 'IN_APP' } });
    expect(n).toHaveLength(1);
    expect(n[0]!.data).toMatchObject({ type: 'ORDER_EXECUTED', orderId: pv.body.id, status: 'FILLED' });
    expect(n[0]!.dedupeKey).toBe(`order:${pv.body.id}:FILLED`);
  });

  it('backfill values each close from the replayed ledger and stored D1 closes (hand-computed)', async () => {
    now = new Date('2026-11-18T12:00:00Z'); // Wed 17:00 PKT: the 18th has closed
    await http()
      .post(`/api/v1/portfolios/${portfolioId}/snapshots/backfill`)
      .set(viewer)
      .send({})
      .expect(403);
    const res = await http()
      .post(`/api/v1/portfolios/${portfolioId}/snapshots/backfill`)
      .set(auth)
      .send({})
      .expect(200);
    expect(res.body).toMatchObject({
      from: '2026-11-13',
      to: '2026-11-18',
      tradingDays: 4,
      unpricedSymbols: [],
    });

    const rows = await prisma.portfolioSnapshot.findMany({
      where: { portfolioId },
      orderBy: { date: 'asc' },
    });
    const view = rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      mv: r.marketValue.toFixed(4),
      cash: r.cashBalance.toFixed(4),
      total: r.totalValue.toFixed(4),
      pnl: r.dailyPnl.toFixed(4),
      contrib: r.netContributions.toFixed(4),
      src: r.priceSource,
    }));
    const cashAfter = d('1000000').minus('100050').minus(tradeCosts); // deposit − gross − fees − taxes
    const m = (x: ReturnType<typeof d>) => x.toFixed(4);
    expect(view).toEqual([
      {
        date: '2026-11-13',
        mv: '0.0000',
        cash: '1000000.0000',
        total: '1000000.0000',
        pnl: '0.0000',
        contrib: '1000000.0000',
        src: 'SIMULATED',
      },
      {
        date: '2026-11-16',
        mv: '102000.0000',
        cash: m(cashAfter),
        total: m(cashAfter.plus('102000')),
        pnl: m(d('1950').minus(tradeCosts)),
        contrib: '1000000.0000',
        src: 'SIMULATED',
      },
      {
        date: '2026-11-17',
        mv: '99000.0000',
        cash: m(cashAfter),
        total: m(cashAfter.plus('99000')),
        pnl: '-3000.0000',
        contrib: '1000000.0000',
        src: 'SIMULATED',
      },
      {
        date: '2026-11-18',
        mv: '101000.0000',
        cash: m(cashAfter),
        total: m(cashAfter.plus('101000')),
        pnl: '2000.0000',
        contrib: '1000000.0000',
        src: 'SIMULATED',
      },
    ]);
    expect(rows[0]!.dailyReturn.toString()).toBe('0'); // V_{t−1} = 0: undefined, stored as 0
    expect(rows[1]!.investedCost.toFixed(4)).toBe(
      m(d('100050').plus(tradeCosts.minus(rows[1]!.taxesCum.toString()))),
    );
    expect(rows[3]!.feesCum.plus(rows[3]!.taxesCum).toFixed(4)).toBe(m(tradeCosts));

    // Idempotent: a second backfill rewrites identical rows, no extras.
    await http().post(`/api/v1/portfolios/${portfolioId}/snapshots/backfill`).set(auth).send({}).expect(200);
    const again = await prisma.portfolioSnapshot.findMany({
      where: { portfolioId },
      orderBy: { date: 'asc' },
    });
    expect(again.map((r) => [r.date.toISOString(), r.totalValue.toString(), r.dailyPnl.toString()])).toEqual(
      rows.map((r) => [r.date.toISOString(), r.totalValue.toString(), r.dailyPnl.toString()]),
    );
    await http()
      .post(`/api/v1/portfolios/${portfolioId}/snapshots/backfill`)
      .set(auth)
      .send({ from: '2026-11-20' })
      .expect(400); // after the last completed session
  });

  it('performance: TWR, drawdown, monthly P&L, XIRR — provenance SIMULATED', async () => {
    const r = await http()
      .get(`/api/v1/portfolios/${portfolioId}/performance?range=1M`)
      .set(viewer)
      .expect(404); // not theirs
    expect(r.body.code).toBe('NOT_FOUND');
    const res = await http()
      .get(`/api/v1/portfolios/${portfolioId}/performance?range=1M`)
      .set(auth)
      .expect(200);
    const b = res.body;
    const cashAfter = d('1000000').minus('100050').minus(tradeCosts);
    const v16 = cashAfter.plus('102000');
    const v18 = cashAfter.plus('101000');
    expect(b.source).toBe('SIMULATED');
    expect(b.series.map((x: { date: string }) => x.date)).toEqual([
      '2026-11-13',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
    ]);
    expect(b.series[0].twrIndex).toBe('1.0000000000');
    // No flows after the base: TWR = V_18 / V_13 − 1
    expect(b.twr).toMatchObject({
      valuePct: v18.div('1000000').minus(1).times(100).toDecimalPlaces(4).toFixed(4),
      source: 'SIMULATED',
    });
    expect(b.maxDrawdown).toMatchObject({
      valuePct: d('3000').div(v16).times(100).toDecimalPlaces(4).toFixed(4),
      peakDate: '2026-11-16',
      troughDate: '2026-11-17',
      recoveryDate: null,
    });
    expect(b.monthly).toEqual([
      { month: '2026-11', pnl: d('950').minus(tradeCosts).toFixed(4), days: 4, source: 'SIMULATED' },
    ]);
    expect(b.simpleReturn.valuePct).toBe(b.twr.valuePct); // single deposit at the base
    expect(b.xirr.valuePct).not.toBeNull();
    expect(b.xirr.source).toBe('SIMULATED');
    await http().get(`/api/v1/portfolios/${portfolioId}/performance?range=2W`).set(auth).expect(422);
  });

  it('dashboard summary: today/month P&L from snapshots after the close, live vs previous close during the session', async () => {
    const closed = await http()
      .get(`/api/v1/dashboard/summary?portfolioId=${portfolioId}`)
      .set(auth)
      .expect(200);
    expect(closed.body.todayPnl).toMatchObject({
      value: '2000.0000',
      basis: 'SNAPSHOT',
      tradingDate: '2026-11-18',
      previousCloseDate: '2026-11-17',
      source: 'SIMULATED',
    });
    expect(closed.body.monthPnl).toMatchObject({
      value: d('950').minus(tradeCosts).toFixed(4),
      month: '2026-11',
      basis: 'SNAPSHOTS',
    });
    expect(closed.body.twrPct.value).not.toBeNull();
    expect(closed.body.realizedPnl.value).toBe('0.0000'); // existing fields intact

    now = new Date('2026-11-19T05:00:00Z'); // Thu 10:00 PKT, session open
    await setQuote('103.00');
    const live = await http()
      .get(`/api/v1/dashboard/summary?portfolioId=${portfolioId}`)
      .set(auth)
      .expect(200);
    expect(live.body.todayPnl).toMatchObject({
      value: '2000.0000', // 1000 × (103 − 101)
      basis: 'LIVE_VS_PREVIOUS_SNAPSHOT',
      tradingDate: '2026-11-19',
      previousCloseDate: '2026-11-18',
    });
    expect(live.body.monthPnl).toMatchObject({
      value: d('2950').minus(tradeCosts).toFixed(4),
      basis: 'SNAPSHOTS_PLUS_LIVE_TODAY',
    });
  });

  describe('alerts', () => {
    let priceAlertId: string;

    it('validates typed params per alert type', async () => {
      await http()
        .post('/api/v1/alerts')
        .set(auth)
        .send({ type: 'PRICE_ABOVE', symbol: 'TSTA', params: { price: 'abc' } })
        .expect(422);
      await http()
        .post('/api/v1/alerts')
        .set(auth)
        .send({ type: 'POSITION_STOP_LOSS', symbol: 'TSTA', portfolioId, params: { pct: '150' } })
        .expect(422);
      await http()
        .post('/api/v1/alerts')
        .set(auth)
        .send({ type: 'PRICE_ABOVE', symbol: 'TSTA', params: { pct: '1' } })
        .expect(422);
      await http().post('/api/v1/alerts').set(auth).send({ type: 'ORDER_EXECUTED', params: {} }).expect(422);
      await http()
        .post('/api/v1/alerts')
        .set(auth)
        .send({ type: 'PRICE_ABOVE', symbol: 'NOPE', params: { price: '1' } })
        .expect(404);
    });

    it('CRUD is owner-scoped and audited; viewers cannot write or see others’ alerts', async () => {
      const c = await http()
        .post('/api/v1/alerts')
        .set(auth)
        .send({
          type: 'PRICE_ABOVE',
          symbol: 'tsta',
          params: { price: '102' },
          channels: ['IN_APP', 'EMAIL'],
        })
        .expect(201);
      priceAlertId = c.body.id;
      expect(c.body).toMatchObject({
        symbol: 'TSTA',
        threshold: '102',
        channels: ['IN_APP', 'EMAIL'],
        cooldownMinutes: 60,
        isActive: true,
      });
      await http()
        .post('/api/v1/alerts')
        .set(viewer)
        .send({ type: 'PRICE_ABOVE', symbol: 'TSTA', params: { price: '1' } })
        .expect(403);
      expect((await http().get('/api/v1/alerts').set(viewer).expect(200)).body).toEqual([]);
      await http().get(`/api/v1/alerts/${priceAlertId}`).set(viewer).expect(404);
      expect((await http().get('/api/v1/alerts').set(auth).expect(200)).body).toHaveLength(1);

      const tmp = await http()
        .post('/api/v1/alerts')
        .set(auth)
        .send({ type: 'PORTFOLIO_DAILY_LOSS', portfolioId, params: { pct: '50' } })
        .expect(201);
      const patched = await http()
        .patch(`/api/v1/alerts/${tmp.body.id}`)
        .set(auth)
        .send({ params: { pct: '40' }, cooldownMinutes: 30 })
        .expect(200);
      expect(patched.body).toMatchObject({ threshold: '40', cooldownMinutes: 30 });
      await http()
        .patch(`/api/v1/alerts/${tmp.body.id}`)
        .set(auth)
        .send({ params: { price: '1' } })
        .expect(422);
      await http().delete(`/api/v1/alerts/${tmp.body.id}`).set(auth).expect(204);
      await http().get(`/api/v1/alerts/${tmp.body.id}`).set(auth).expect(404);
      const actions = (await prisma.auditLog.findMany({ where: { entityType: 'alert' } })).map(
        (a) => a.action,
      );
      expect(actions).toEqual(expect.arrayContaining(['alert.created', 'alert.updated', 'alert.deleted']));
    });

    const alertNotes = (channel: 'IN_APP' | 'EMAIL') =>
      prisma.notification.findMany({
        where: { alertId: priceAlertId, channel },
        orderBy: { createdAt: 'asc' },
      });

    it('price alert fires once, respects its cooldown, and the email channel never sends', async () => {
      const first = await http().post('/api/v1/alerts/evaluate').set(auth).expect(200);
      expect(first.body.fired).toEqual([
        expect.objectContaining({ alertId: priceAlertId, observed: '103', notificationsCreated: 2 }),
      ]);
      const again = await http().post('/api/v1/alerts/evaluate').set(auth).expect(200);
      expect(again.body.fired).toEqual([]);
      expect(again.body.skipped.COOLDOWN).toBe(1);
      expect(await alertNotes('IN_APP')).toHaveLength(1);

      const email = await alertNotes('EMAIL');
      expect(email).toHaveLength(1);
      expect(email[0]).toMatchObject({
        status: 'FAILED',
        error: 'channel not configured',
        sentAt: null,
        attempts: 0,
      });

      now = new Date(now.getTime() + 61 * 60_000); // cooldown elapsed, condition still true
      const later = await http().post('/api/v1/alerts/evaluate').set(auth).expect(200);
      expect(later.body.fired).toHaveLength(1);
      expect(await alertNotes('IN_APP')).toHaveLength(2);
      await http().post('/api/v1/alerts/evaluate').set(viewer).expect(403);
    });

    it('dedupe: concurrent or replayed evaluations in one window never duplicate notifications', async () => {
      // Simulate a crash between claim and notify by clearing lastTriggeredAt: the window's dedupe key still holds.
      await prisma.alert.update({ where: { id: priceAlertId }, data: { lastTriggeredAt: null } });
      const results = await Promise.all(
        [1, 2, 3].map(() => http().post('/api/v1/alerts/evaluate').set(auth).expect(200)),
      );
      expect(
        results
          .flatMap((r) => r.body.fired)
          .reduce((s: number, f: { notificationsCreated: number }) => s + f.notificationsCreated, 0),
      ).toBe(0);
      expect(await alertNotes('IN_APP')).toHaveLength(2);
    });

    it('triggerOnce fires once and is then deactivated', async () => {
      const c = await http()
        .post('/api/v1/alerts')
        .set(auth)
        .send({
          type: 'PRICE_BELOW',
          symbol: 'TSTA',
          params: { price: '200' },
          triggerOnce: true,
          cooldownMinutes: 1,
        })
        .expect(201);
      const r1 = await http().post('/api/v1/alerts/evaluate').set(auth).expect(200);
      expect(r1.body.fired.map((f: { alertId: string }) => f.alertId)).toContain(c.body.id);
      now = new Date(now.getTime() + 10 * 60_000);
      const r2 = await http().post('/api/v1/alerts/evaluate').set(auth).expect(200);
      expect(r2.body.fired.map((f: { alertId: string }) => f.alertId)).not.toContain(c.body.id);
      expect((await http().get(`/api/v1/alerts/${c.body.id}`).set(auth).expect(200)).body.isActive).toBe(
        false,
      );
      expect(await prisma.notification.count({ where: { alertId: c.body.id } })).toBe(1);
    });

    it('position stop-loss and volume spike evaluate against holdings and the 20-day average', async () => {
      const stop = await http()
        .post('/api/v1/alerts')
        .set(auth)
        .send({ type: 'POSITION_STOP_LOSS', portfolioId, symbol: 'TSTA', params: { pct: '1' } })
        .expect(201);
      const vol = await http()
        .post('/api/v1/alerts')
        .set(auth)
        .send({ type: 'VOLUME_SPIKE', symbol: 'TSTA', params: { multiple: '0.4' } })
        .expect(201);
      const r = await http().post('/api/v1/alerts/evaluate').set(auth).expect(200);
      const fired = r.body.fired.map((f: { alertId: string }) => f.alertId);
      expect(fired).not.toContain(stop.body.id); // 103 is above avg cost × 0.99
      expect(fired).toContain(vol.body.id); // 50,000 ≥ 0.4 × 100,000
      await setQuote('90.00'); // below avg cost (≈100.1) × 0.99
      now = new Date(now.getTime() + 2 * 60 * 60_000);
      const r2 = await http().post('/api/v1/alerts/evaluate').set(auth).expect(200);
      expect(r2.body.fired.map((f: { alertId: string }) => f.alertId)).toContain(stop.body.id);
    });
  });

  describe('notifications', () => {
    it('lists the in-app inbox with unread filter and cursor pagination', async () => {
      const all = await http().get('/api/v1/notifications?limit=2').set(auth).expect(200);
      expect(all.body.data).toHaveLength(2);
      expect(all.body.nextCursor).not.toBeNull();
      expect(all.body.data.every((n: { channel: string }) => n.channel === 'IN_APP')).toBe(true);
      const next = await http()
        .get(`/api/v1/notifications?limit=2&cursor=${all.body.nextCursor}`)
        .set(auth)
        .expect(200);
      expect(next.body.data[0].id).not.toBe(all.body.data[1].id);
      expect(all.body.unreadCount).toBeGreaterThanOrEqual(5);
    });

    it('marks one and all as read; viewers may mark only their own', async () => {
      const unread = await http().get('/api/v1/notifications?unread=true').set(auth).expect(200);
      const id = unread.body.data[0].id;
      await http().post(`/api/v1/notifications/${id}/read`).set(viewer).expect(404);
      const one = await http().post(`/api/v1/notifications/${id}/read`).set(auth).expect(200);
      expect(one.body).toMatchObject({ id, status: 'READ' });
      const after = await http().get('/api/v1/notifications?unread=true').set(auth).expect(200);
      expect(after.body.unreadCount).toBe(unread.body.unreadCount - 1);
      expect((await http().post('/api/v1/notifications/read-all').set(viewer).expect(200)).body).toEqual({
        updated: 0,
      });
      const all = await http().post('/api/v1/notifications/read-all').set(auth).expect(200);
      expect(all.body.updated).toBe(after.body.unreadCount);
      expect((await http().get('/api/v1/notifications?unread=true').set(auth).expect(200)).body.data).toEqual(
        [],
      );
    });

    it('nothing was ever sent on an external channel', async () => {
      const external = await prisma.notification.findMany({
        where: { channel: { in: ['EMAIL', 'TELEGRAM'] } },
      });
      expect(external.length).toBeGreaterThan(0);
      expect(
        external.every(
          (n) => n.status === 'FAILED' && n.sentAt === null && n.error === 'channel not configured',
        ),
      ).toBe(true);
    });
  });
});
