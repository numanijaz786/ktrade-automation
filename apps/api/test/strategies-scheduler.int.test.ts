import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARGON2_OPTIONS } from '../src/auth/password-policy.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { StrategyScheduler, StrategyTickSummary } from '../src/strategies/strategy.scheduler.js';

/**
 * Signal actions (prepare-order, dismiss, expiry) and the StrategyScheduler on real PostgreSQL with SIMULATED
 * seeded history. The clock is mutable; it starts on Friday 2026-11-13 16:00 PKT (after the close, so Friday's
 * bar is complete). Opt-in: RUN_INTEGRATION=1.
 */
describe('signal actions & strategy scheduler (integration, real PostgreSQL)', () => {
  const FRI_AFTER_CLOSE = new Date('2026-11-13T11:00:00Z'); // Fri 16:00 PKT
  const FRI_BEFORE_CLOSE = new Date('2026-11-13T10:00:00Z'); // Fri 15:00 PKT
  const FRI_BAR = '2026-11-13T04:30:00.000Z';
  const SAT = new Date('2026-11-14T12:00:00Z'); // Sat 17:00 PKT
  const MON_AFTER_CLOSE = new Date('2026-11-16T11:00:00Z'); // Mon 16:00 PKT
  const MON_BAR = '2026-11-16T04:30:00.000Z';
  let now = FRI_AFTER_CLOSE;
  const clock = { now: () => new Date(now) };

  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduler: StrategyScheduler;
  let secondScheduler: StrategyScheduler;
  let seed: () => Promise<unknown>;
  let auth: Record<string, string>;
  let stepUp: Record<string, string>;
  let other: Record<string, string>;
  let ownerId: string;
  let paperId: string;
  let liveId: string;
  const http = () => request(app.getHttpServer());
  const ALWAYS = { gt: [{ field: 'close' }, { const: '0' }] };

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', { env: process.env, stdio: 'pipe' });
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/bootstrap.js');
    const { RedisHealth } = await import('../src/redis/redis.module.js');
    const { PrismaService: PS } = await import('../src/prisma/prisma.service.js');
    const { CLOCK } = await import('../src/common/clock.js');
    const { AppConfig } = await import('../src/config/config.module.js');
    const { MarketCalendarService } = await import('../src/market-data/market-calendar.service.js');
    const { StrategiesService } = await import('../src/strategies/strategies.service.js');
    const { StrategyDataService } = await import('../src/strategies/strategy-data.service.js');
    const { StrategyScheduler: SS } = await import('../src/strategies/strategy.scheduler.js');
    const { seedMarketData } = await import('../src/seed/stocks.js');
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
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PS);
    scheduler = app.get(SS);
    // A second scheduler instance stands in for another API process (or a restart racing the old one).
    secondScheduler = new SS(
      app.get(AppConfig),
      prisma,
      app.get(StrategiesService),
      app.get(StrategyDataService),
      app.get(MarketCalendarService, { strict: false }),
      clock,
    );
    seed = () => seedMarketData(prisma, clock, { years: 1 });
    await seed();

    const reg = await http()
      .post('/api/v1/auth/register')
      .send({ email: 'o@example.com', password: 'a long owner passphrase', displayName: 'O' })
      .expect(201);
    auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    stepUp = {
      'X-Step-Up-Token': (
        await http()
          .post('/api/v1/auth/step-up')
          .set(auth)
          .send({ password: 'a long owner passphrase' })
          .expect(200)
      ).body.stepUpToken,
    };
    ownerId = (await prisma.user.findFirstOrThrow({ where: { email: 'o@example.com' } })).id;

    await prisma.user.create({
      data: {
        email: 'x@example.com',
        passwordHash: await argon2.hash('other-owner-password', ARGON2_OPTIONS),
        displayName: 'X',
        role: 'OWNER',
      },
    });
    other = {
      Authorization: `Bearer ${(await http().post('/api/v1/auth/login').send({ email: 'x@example.com', password: 'other-owner-password' }).expect(200)).body.accessToken}`,
    };

    paperId = (
      await http()
        .post('/api/v1/portfolios')
        .set(auth)
        .send({ name: 'Paper', initialCash: '1000000' })
        .expect(201)
    ).body.id;
    const broker = await prisma.brokerAccount.create({
      data: { userId: ownerId, brokerCode: 'KTRADE', displayName: 'My KTrade' },
    });
    liveId = (
      await prisma.portfolio.create({
        data: {
          userId: ownerId,
          brokerAccountId: broker.id,
          name: 'KTrade live',
          kind: 'LIVE',
          riskLimit: {
            create: {
              maxOrderValue: '100000',
              maxOrderQty: '1000',
              maxDailyTradedValue: '500000',
              maxDailyOrders: 10,
              maxPositionPct: '100',
              priceBandPct: '10',
              maxDailyLossPct: '5',
              allowMarketOrders: false,
            },
          },
        },
      })
    ).id;
    await prisma.cashMovement.create({
      data: {
        portfolioId: liveId,
        type: 'DEPOSIT',
        amount: '1000000',
        valueDate: FRI_AFTER_CLOSE,
        source: 'USER_REPORTED',
      },
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  const createStrategy = async (body: Record<string, unknown>) => {
    const res = await http()
      .post('/api/v1/strategies')
      .set(auth)
      .send({ maxInvestment: '50000', type: 'CUSTOM_RULES', entryRules: ALWAYS, ...body })
      .expect(201);
    const live = res.body.mode === 'LIVE';
    await http()
      .post(`/api/v1/strategies/${res.body.id}/activate`)
      .set(auth)
      .set(live ? stepUp : {})
      .expect(200);
    return res.body.id as string;
  };

  /** An active "always enter" strategy, evaluated manually once → its NEW signal; then deactivated. */
  const newSignal = async (name: string, portfolioId: string, symbol: string) => {
    const strategyId = await createStrategy({ name, portfolioId, symbol });
    const ev = await http().post(`/api/v1/strategies/${strategyId}/evaluate`).set(auth).expect(200);
    expect(ev.body.signal).toMatchObject({ status: 'NEW', barTs: FRI_BAR });
    await http().post(`/api/v1/strategies/${strategyId}/deactivate`).set(auth).expect(200);
    return { strategyId, signalId: ev.body.signal.id as string };
  };

  const prepare = (signalId: string, headers = auth) =>
    http().post(`/api/v1/signals/${signalId}/prepare-order`).set(headers);

  // ── prepare-order ──────────────────────────────────────────────────────────

  it('prepare-order (PAPER): exactly one PREVIEWED order on repeat and concurrently, never approved', async () => {
    const { strategyId, signalId } = await newSignal('paper prep', paperId, 'HUBC');
    const [a, b] = await Promise.all([prepare(signalId), prepare(signalId)]);
    const c = await prepare(signalId);
    for (const r of [a, b, c]) expect(r.status).toBe(200);
    expect(new Set([a.body.order.id, b.body.order.id, c.body.order.id]).size).toBe(1);
    expect(a.body.order.status).toBe('PREVIEWED');
    expect(c.body.signal).toMatchObject({ id: signalId, status: 'ORDER_PREPARED', orderId: a.body.order.id });

    const orders = await prisma.order.findMany({ where: { strategyId }, include: { events: true } });
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    expect(order).toMatchObject({ status: 'PREVIEWED', origin: 'STRATEGY', mode: 'PAPER', approvedAt: null });
    expect(order.quantity.toString()).toBe(c.body.signal.suggestedQty);
    expect(order.events.map((e) => e.toStatus)).toEqual(['PREVIEWED']);
    expect(
      await prisma.auditLog.count({
        where: { action: 'strategy.signal_order_prepared', entityId: signalId },
      }),
    ).toBe(1);

    // The owner still approves it through the normal flow (step-up) — prepare-order did not.
    const approved = await http()
      .post(`/api/v1/orders/${order.id}/approve`)
      .set(auth)
      .set(stepUp)
      .send({ previewHash: order.previewHash })
      .expect(200);
    expect(approved.body.status).toBe('FILLED');
    // Preparing again after approval just replays the same order.
    const again = await prepare(signalId).expect(200);
    expect(again.body.order.id).toBe(order.id);
    expect(await prisma.order.count({ where: { strategyId } })).toBe(1);
  });

  it('prepare-order (LIVE): kill switch OFF → REJECTED_BY_RISK and the signal is BLOCKED_BY_RISK', async () => {
    const { strategyId, signalId } = await newSignal('live prep', liveId, 'OGDC');
    const res = await prepare(signalId).expect(200);
    expect(res.body.order).toMatchObject({ status: 'REJECTED_BY_RISK', mode: 'LIVE' });
    expect(res.body.signal).toMatchObject({ status: 'BLOCKED_BY_RISK', orderId: res.body.order.id });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
    expect(order.rejectionReason).toMatch(/KILL_SWITCH/);
    expect(order.type).toBe('LIMIT');
    expect(order.origin).toBe('STRATEGY');

    const repeat = await prepare(signalId).expect(200);
    expect(repeat.body.order.id).toBe(res.body.order.id);
    expect(await prisma.order.count({ where: { strategyId } })).toBe(1);
    expect(
      await prisma.order.count({ where: { portfolioId: liveId, status: { in: ['APPROVED', 'FILLED'] } } }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'strategy.signal_blocked_by_risk', entityId: signalId },
      }),
    ).toBe(1);
  });

  // ── dismiss & isolation ────────────────────────────────────────────────────

  it('dismiss: NEW → DISMISSED (idempotent), then not actionable; other users get 404', async () => {
    const { strategyId, signalId } = await newSignal('to dismiss', paperId, 'PPL');
    await prepare(signalId, other).expect(404);
    await http().post(`/api/v1/signals/${signalId}/dismiss`).set(other).expect(404);
    await http().get(`/api/v1/signals/${signalId}`).set(other).expect(404);

    const d1 = await http().post(`/api/v1/signals/${signalId}/dismiss`).set(auth).expect(200);
    expect(d1.body).toMatchObject({ id: signalId, status: 'DISMISSED', orderId: null });
    await http().post(`/api/v1/signals/${signalId}/dismiss`).set(auth).expect(200);
    const blocked = await prepare(signalId).expect(409);
    expect(blocked.body.code).toBe('SIGNAL_NOT_ACTIONABLE');
    expect(await prisma.order.count({ where: { strategyId } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { action: 'strategy.signal_dismissed', entityId: signalId } }),
    ).toBe(1);
    // A prepared signal cannot be dismissed.
    const prepared = await prisma.strategySignal.findFirstOrThrow({ where: { status: 'ORDER_PREPARED' } });
    expect(
      (await http().post(`/api/v1/signals/${prepared.id}/dismiss`).set(auth).expect(409)).body.code,
    ).toBe('SIGNAL_NOT_ACTIONABLE');
  });

  // ── scheduler ──────────────────────────────────────────────────────────────

  let paperAuto: string;
  let liveSig: string;

  it('scheduler: skips non-trading days and the time before 15:35 PKT', async () => {
    paperAuto = await createStrategy({
      name: 'sched paper auto',
      portfolioId: paperId,
      symbol: 'MARI',
      autoExecute: true,
    });
    liveSig = await createStrategy({ name: 'sched live', portfolioId: liveId, symbol: 'ENGRO' });

    now = FRI_BEFORE_CLOSE;
    expect(await scheduler.tick()).toMatchObject({ ran: false, reason: 'before 15:35 PKT' });
    now = SAT;
    expect(await scheduler.tick()).toMatchObject({ ran: false, reason: 'not a PSX trading day' });
    expect(
      await prisma.strategyExecution.count({ where: { strategyId: { in: [paperAuto, liveSig] } } }),
    ).toBe(0);
    expect(await prisma.strategySignal.count({ where: { strategyId: { in: [paperAuto, liveSig] } } })).toBe(
      0,
    );
  });

  it('scheduler: once per completed bar across repeated and concurrent ticks; LIVE never gets an order', async () => {
    now = FRI_AFTER_CLOSE;
    const results: StrategyTickSummary[] = await Promise.all([
      scheduler.tick(),
      scheduler.tick(),
      secondScheduler.tick(),
    ]);
    results.push(await scheduler.tick(), await secondScheduler.tick());
    expect(results.reduce((n, r) => n + r.evaluated, 0)).toBe(2);
    expect(results.some((r) => r.reason === 'a tick is already running')).toBe(true);
    expect(results.every((r) => r.failed === 0)).toBe(true);

    for (const id of [paperAuto, liveSig]) {
      expect(await prisma.strategySignal.count({ where: { strategyId: id } })).toBe(1);
      expect(
        await prisma.strategyExecution.count({
          where: { strategyId: id, status: 'SUCCEEDED', barTs: new Date(FRI_BAR) },
        }),
      ).toBe(1);
    }
    // PAPER + autoExecute behaves as before: system paper approval → one FILLED paper order.
    const paperSignal = await prisma.strategySignal.findFirstOrThrow({ where: { strategyId: paperAuto } });
    expect(paperSignal.status).toBe('AUTO_EXECUTED_PAPER');
    const paperOrders = await prisma.order.findMany({ where: { strategyId: paperAuto } });
    expect(paperOrders.map((o) => o.status)).toEqual(['FILLED']);
    // LIVE: a NEW signal and a notification, never an order.
    const liveSignal = await prisma.strategySignal.findFirstOrThrow({ where: { strategyId: liveSig } });
    expect(liveSignal).toMatchObject({ status: 'NEW', mode: 'LIVE', orderId: null });
    expect(await prisma.order.count({ where: { strategyId: liveSig } })).toBe(0);
    expect(
      await prisma.notification.count({ where: { userId: ownerId, dedupeKey: `signal:${liveSignal.id}` } }),
    ).toBeGreaterThan(0);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'strategy.evaluated', entityId: liveSig },
    });
    expect(audit.actorType).toBe('SYSTEM');
    // Strategies already evaluated manually for this bar (and deactivated ones) were not re-run.
    const others = await prisma.strategyExecution.count({
      where: { strategyId: { notIn: [paperAuto, liveSig] } },
    });
    expect(others).toBe(3); // the three manual evaluations above
  });

  it('scheduler: the next completed bar is evaluated once; stale NEW signals expire', async () => {
    now = MON_AFTER_CLOSE;
    await seed(); // Monday's bar is now complete
    const first = await scheduler.tick();
    expect(first).toMatchObject({ ran: true, evaluated: 2, failed: 0 });
    expect(first.expiredSignals).toBeGreaterThanOrEqual(1);
    expect(await scheduler.tick()).toMatchObject({ ran: true, evaluated: 0, skipped: 2 });

    for (const id of [paperAuto, liveSig]) {
      const execs = await prisma.strategyExecution.findMany({
        where: { strategyId: id, status: 'SUCCEEDED' },
      });
      expect(execs.map((e) => e.barTs?.toISOString()).sort()).toEqual([FRI_BAR, MON_BAR]);
    }
    const liveSignals = await prisma.strategySignal.findMany({
      where: { strategyId: liveSig },
      orderBy: { barTs: 'asc' },
    });
    expect(liveSignals.map((s) => [s.barTs.toISOString(), s.status])).toEqual([
      [FRI_BAR, 'EXPIRED'], // Friday's signal was actionable until Monday's 15:30 close
      [MON_BAR, 'NEW'],
    ]);
    expect(await prisma.order.count({ where: { strategyId: liveSig } })).toBe(0);
    expect(
      await prisma.order.count({ where: { portfolioId: liveId, status: { notIn: ['REJECTED_BY_RISK'] } } }),
    ).toBe(0);

    // An expired signal cannot be prepared; acted-on signals were not expired.
    const expired = await prepare(liveSignals[0]!.id).expect(409);
    expect(expired.body.code).toBe('SIGNAL_EXPIRED');
    expect(await prisma.strategySignal.count({ where: { status: 'ORDER_PREPARED' } })).toBe(1);
    expect(await prisma.strategySignal.count({ where: { status: 'DISMISSED' } })).toBe(1);
    expect(await prisma.strategySignal.count({ where: { status: 'BLOCKED_BY_RISK' } })).toBe(1);
  });

  it('listing expires stale NEW signals', async () => {
    // Monday's LIVE signal is actionable until Tuesday's close; list it after that.
    now = new Date('2026-11-17T11:00:00Z'); // Tue 16:00 PKT
    const listed = await http().get(`/api/v1/strategies/${liveSig}/signals`).set(auth).expect(200);
    expect(listed.body.map((s: { status: string }) => s.status)).toEqual(['EXPIRED', 'EXPIRED']);
    expect(
      await prisma.auditLog.count({ where: { action: 'strategy.signal_expired' } }),
    ).toBeGreaterThanOrEqual(2);
  });
});
