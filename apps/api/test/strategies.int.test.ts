import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKTEST_DISCLAIMER } from '@ktrade/finance-core';
import { ARGON2_OPTIONS } from '../src/auth/password-policy.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { TradingService } from '../src/trading/trading.service.js';

/**
 * Strategies, signals and backtests (Phase 9) on real PostgreSQL with SIMULATED seeded history.
 * Clock fixed to Monday 2026-11-16 10:00 PKT (last completed session: Friday 2026-11-13). Opt-in: RUN_INTEGRATION=1.
 */
describe('strategies & backtests (integration, real PostgreSQL)', () => {
  const NOW = new Date('2026-11-16T05:00:00Z');
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let trading: TradingService;
  let auth: Record<string, string>;
  let stepUp: Record<string, string>;
  let other: Record<string, string>;
  let ownerId: string;
  let paperId: string;
  let liveId: string;
  const http = () => request(app.getHttpServer());

  const ALWAYS = { gt: [{ field: 'close' }, { const: '0' }] };
  const MA = { type: 'MA_CROSSOVER', parameters: { fastPeriod: 5, slowPeriod: 20, maType: 'SMA' } };
  const RANGE = { from: '2025-12-01', to: '2026-11-13', initialCapital: '1000000', slippageBps: '5' };

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', { env: process.env, stdio: 'pipe' });
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/bootstrap.js');
    const { RedisHealth } = await import('../src/redis/redis.module.js');
    const { PrismaService: PS } = await import('../src/prisma/prisma.service.js');
    const { TradingService: TS } = await import('../src/trading/trading.service.js');
    const { CLOCK } = await import('../src/common/clock.js');
    const { seedMarketData } = await import('../src/seed/stocks.js');
    const clock = { now: () => new Date(NOW) };
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
    trading = app.get(TS);
    await seedMarketData(prisma, clock, { years: 1 });

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

    // A second, unrelated OWNER account for isolation checks.
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
        valueDate: NOW,
        source: 'USER_REPORTED',
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  const createStrategy = (body: Record<string, unknown>, headers = auth) =>
    http()
      .post('/api/v1/strategies')
      .set(headers)
      .send({ portfolioId: paperId, symbol: 'HUBC', maxInvestment: '100000', ...body });

  // ── templates ──────────────────────────────────────────────────────────────

  it('lists built-in templates with parameter schemas and compiled rules', async () => {
    const res = await http().get('/api/v1/strategies/templates').set(auth).expect(200);
    const types = res.body.map((t: { type: string }) => t.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'MA_CROSSOVER',
        'RSI',
        'MACD',
        'STOP_LOSS',
        'TAKE_PROFIT',
        'TRAILING_STOP',
        'PRICE_ALERT',
        'CUSTOM_RULES',
      ]),
    );
    const ma = res.body.find((t: { type: string }) => t.type === 'MA_CROSSOVER');
    expect(ma.params.map((p: { name: string }) => p.name)).toEqual(['fastPeriod', 'slowPeriod', 'maType']);
    expect(ma.paramsJsonSchema.properties.fastPeriod).toMatchObject({ type: 'integer', default: 9 });
    expect(ma.rules.entryRules).toEqual({
      crossesAbove: [
        { ind: 'EMA', period: '$fastPeriod' },
        { ind: 'EMA', period: '$slowPeriod' },
      ],
    });
  });

  // ── CRUD & isolation ───────────────────────────────────────────────────────

  it('creates from a template, persists parameters, bumps version on definition edits only, and isolates owners', async () => {
    const c = await createStrategy({ name: 'MA 5/20', ...MA, stopLossPct: '5' }).expect(201);
    expect(c.body).toMatchObject({
      type: 'MA_CROSSOVER',
      mode: 'PAPER',
      symbol: 'HUBC',
      version: 1,
      isActive: false,
      autoExecute: false,
      stopLossPct: '5',
      parameters: { fastPeriod: 5, slowPeriod: 20, maType: 'SMA' },
    });
    expect(c.body.entryRules).toEqual({
      crossesAbove: [
        { ind: 'SMA', period: '$fastPeriod' },
        { ind: 'SMA', period: '$slowPeriod' },
      ],
    });
    expect(await prisma.strategyParameter.count({ where: { strategyId: c.body.id } })).toBe(3);

    const renamed = await http()
      .patch(`/api/v1/strategies/${c.body.id}`)
      .set(auth)
      .send({ name: 'MA fast' })
      .expect(200);
    expect(renamed.body.version).toBe(1);
    const edited = await http()
      .patch(`/api/v1/strategies/${c.body.id}`)
      .set(auth)
      .send({ parameters: { fastPeriod: 7, slowPeriod: 30 } })
      .expect(200);
    expect(edited.body.version).toBe(2);
    expect(edited.body.parameters).toEqual({ fastPeriod: 7, slowPeriod: 30, maType: 'EMA' });

    await createStrategy({ name: 'MA fast', ...MA }).expect(409); // unique name per user

    // Another user cannot see or touch it (404, ids not disclosed).
    await http().get(`/api/v1/strategies/${c.body.id}`).set(other).expect(404);
    await http().patch(`/api/v1/strategies/${c.body.id}`).set(other).send({ name: 'mine' }).expect(404);
    await http().post(`/api/v1/strategies/${c.body.id}/activate`).set(other).expect(404);
    await http().delete(`/api/v1/strategies/${c.body.id}`).set(other).expect(404);
    expect((await http().get('/api/v1/strategies').set(other).expect(200)).body).toEqual([]);
    // ...nor create one on this user's portfolio.
    await createStrategy({ name: 'intruder', ...MA }, other).expect(404);

    const tmp = await createStrategy({ name: 'to delete', type: 'RSI' }).expect(201);
    await http().delete(`/api/v1/strategies/${tmp.body.id}`).set(auth).expect(204);
    await http().get(`/api/v1/strategies/${tmp.body.id}`).set(auth).expect(404);
    const audits = await prisma.auditLog.findMany({ where: { action: { startsWith: 'strategy.' } } });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['strategy.created', 'strategy.updated', 'strategy.deleted']),
    );
  });

  it('rejects invalid DSL and template parameters with 422 and JSON paths', async () => {
    const bad = await createStrategy({
      name: 'bad dsl',
      type: 'CUSTOM_RULES',
      entryRules: { all: [{ gt: [{ ind: 'NOPE', period: 5 }, { const: '1' }] }] },
    }).expect(422);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect(bad.body.errors[0].path).toMatch(/^\$\.entryRules\.all\[0\]/);

    const params = await http()
      .post('/api/v1/strategies/validate')
      .set(auth)
      .send({ type: 'MA_CROSSOVER', parameters: { fastPeriod: 30, slowPeriod: 10 } })
      .expect(422);
    expect(params.body.errors.map((e: { path: string }) => e.path)).toContain('$.parameters.slowPeriod');

    const missing = await http()
      .post('/api/v1/strategies/validate')
      .set(auth)
      .send({
        type: 'CUSTOM_RULES',
        parameters: {},
        entryRules: { gt: [{ field: 'close' }, { const: '$level' }] },
      })
      .expect(422);
    expect(missing.body.errors[0].path).toMatch(/^\$\.entryRules/);

    await createStrategy({ name: 'rules on template', ...MA, entryRules: ALWAYS }).expect(422);
    await createStrategy({ name: 'bad pct', ...MA, stopLossPct: 'abc' }).expect(422);
    expect(await prisma.tradingStrategy.count({ where: { name: { in: ['bad dsl', 'bad pct'] } } })).toBe(0);
  });

  it('validate: dry-runs over the last N completed bars with explanation traces and persists nothing', async () => {
    const before = await prisma.strategySignal.count();
    const res = await http()
      .post('/api/v1/strategies/validate')
      .set(auth)
      .send({ ...MA, symbol: 'HUBC', bars: 120 })
      .expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.warmupBars).toBeGreaterThanOrEqual(20);
    expect(res.body.dryRun).toMatchObject({ symbol: 'HUBC', bars: 120, dataSource: 'SIMULATED' });
    expect(res.body.dryRun.to).toBe('2026-11-13T04:30:00.000Z'); // Friday's session; Monday's bar is not complete
    expect(res.body.dryRun.disclaimer).toBe(BACKTEST_DISCLAIMER);
    expect(res.body.dryRun.signals.length).toBeGreaterThan(0);
    const sig = res.body.dryRun.signals[0];
    expect(sig.type).toBe('ENTRY');
    expect(sig.summary).toMatch(/SMA\(5\)/);
    expect(sig.trace.rule.result).toBe(true);
    expect(await prisma.strategySignal.count()).toBe(before);
  });

  // ── activation rules ───────────────────────────────────────────────────────

  it('activation: LIVE needs step-up, LIVE autoExecute is refused, one active strategy per portfolio+stock+type', async () => {
    const liveAuto = await createStrategy({
      name: 'live auto',
      portfolioId: liveId,
      type: 'CUSTOM_RULES',
      entryRules: ALWAYS,
      autoExecute: true,
    }).expect(422);
    expect(liveAuto.body.code).toBe('LIVE_AUTO_EXECUTION_FORBIDDEN');

    const live = await createStrategy({
      name: 'live rsi',
      portfolioId: liveId,
      type: 'RSI',
    }).expect(201);
    expect(live.body.mode).toBe('LIVE');
    const patched = await http()
      .patch(`/api/v1/strategies/${live.body.id}`)
      .set(auth)
      .send({ autoExecute: true })
      .expect(422);
    expect(patched.body.code).toBe('LIVE_AUTO_EXECUTION_FORBIDDEN');

    const noStepUp = await http().post(`/api/v1/strategies/${live.body.id}/activate`).set(auth).expect(403);
    expect(noStepUp.body.code).toBe('STEP_UP_REQUIRED');
    await http()
      .post(`/api/v1/strategies/${live.body.id}/activate`)
      .set(auth)
      .set({ 'X-Step-Up-Token': 'not-a-token' })
      .expect(403);
    const on = await http()
      .post(`/api/v1/strategies/${live.body.id}/activate`)
      .set(auth)
      .set(stepUp)
      .expect(200);
    expect(on.body.isActive).toBe(true);
    await http().post(`/api/v1/strategies/${live.body.id}/deactivate`).set(auth).expect(200);

    // PAPER activation needs no step-up; a second active RSI strategy on the same portfolio+stock → 409.
    const a = await createStrategy({ name: 'rsi a', type: 'RSI' }).expect(201);
    const b = await createStrategy({ name: 'rsi b', type: 'RSI', parameters: { rsiPeriod: 10 } }).expect(201);
    await http().post(`/api/v1/strategies/${a.body.id}/activate`).set(auth).expect(200);
    const dup = await http().post(`/api/v1/strategies/${b.body.id}/activate`).set(auth).expect(409);
    expect(dup.body.code).toBe('ACTIVE_STRATEGY_EXISTS');
    await http().delete(`/api/v1/strategies/${a.body.id}`).set(auth).expect(409); // deactivate first
    await http().post(`/api/v1/strategies/${a.body.id}/deactivate`).set(auth).expect(200);
    await http().post(`/api/v1/strategies/${b.body.id}/activate`).set(auth).expect(200);
    await http().post(`/api/v1/strategies/${b.body.id}/deactivate`).set(auth).expect(200);
    const actions = (await prisma.auditLog.findMany({ where: { entityId: live.body.id } })).map(
      (x) => x.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['strategy.activated', 'strategy.deactivated']));
  });

  // ── backtests ──────────────────────────────────────────────────────────────

  let maStrategyId: string;

  it('backtest: deterministic, real fees, SIMULATED provenance, disclaimer, trades persisted', async () => {
    maStrategyId = (await createStrategy({ name: 'bt ma', ...MA }).expect(201)).body.id;
    const first = await http()
      .post('/api/v1/backtests')
      .set(auth)
      .send({ strategyId: maStrategyId, ...RANGE })
      .expect(201);
    const second = await http()
      .post('/api/v1/backtests')
      .set(auth)
      .send({ strategyId: maStrategyId, ...RANGE })
      .expect(201);
    expect(first.body.status).toBe('SUCCEEDED');
    expect(first.body.id).not.toBe(second.body.id);
    expect(second.body.metrics).toEqual(first.body.metrics);
    expect(second.body.equityCurve).toEqual(first.body.equityCurve);
    expect(first.body.dataSource).toBe('SIMULATED');
    expect(first.body.disclaimer).toBe(BACKTEST_DISCLAIMER);
    expect(first.body.symbol).toBe('HUBC');
    const m = first.body.metrics;
    expect(m.tradeCount).toBeGreaterThan(0);
    expect(Number.parseFloat(m.feesTotal)).toBeGreaterThan(0);
    for (const k of ['sortino', 'annualizedReturnPct', 'sharpe', 'buyAndHoldReturnPct', 'maxDrawdownPct'])
      expect(m[k]).toMatch(/^-?\d+(\.\d+)?$/);
    expect(first.body.benchmark.totalReturnPct).toBe(m.buyAndHoldReturnPct);
    expect(first.body.params.fees.engine).toBe('finance-core computeTradeFees');

    const trades = await http().get(`/api/v1/backtests/${first.body.id}/trades`).set(auth).expect(200);
    expect(trades.body.disclaimer).toBe(BACKTEST_DISCLAIMER);
    expect(trades.body.data.filter((t: { open: boolean }) => !t.open)).toHaveLength(m.tradeCount);
    expect(trades.body.data.every((t: { fees: string }) => Number.parseFloat(t.fees) > 0)).toBe(true);

    const list = await http().get('/api/v1/backtests').set(auth).expect(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);
    expect(list.body.disclaimer).toBe(BACKTEST_DISCLAIMER);
    const one = await http().get(`/api/v1/backtests/${first.body.id}`).set(auth).expect(200);
    expect(one.body.disclaimer).toBe(BACKTEST_DISCLAIMER);
    await http().get(`/api/v1/backtests/${first.body.id}`).set(other).expect(404);
    await http().get(`/api/v1/backtests/${first.body.id}/trades`).set(other).expect(404);
    await http()
      .post('/api/v1/backtests')
      .set(other)
      .send({ strategyId: maStrategyId, ...RANGE })
      .expect(404);
    expect(await prisma.auditLog.count({ where: { action: 'backtest.completed' } })).toBe(2);
  });

  it('backtest: no look-ahead — a signal on bar t fills at the open of bar t+1', async () => {
    const res = await http()
      .post('/api/v1/backtests')
      .set(auth)
      .send({ definition: { type: 'CUSTOM_RULES', entryRules: ALWAYS }, symbol: 'OGDC', ...RANGE })
      .expect(201);
    // "close > 0" signals on the very first bar; the earliest possible fill is the next bar's open.
    const firstSignalBar = res.body.params.firstBarTs as string;
    const trades = await http().get(`/api/v1/backtests/${res.body.id}/trades`).set(auth).expect(200);
    const firstTrade = trades.body.data[0];
    expect(Date.parse(firstTrade.entryTs)).toBeGreaterThan(Date.parse(firstSignalBar));
    expect(firstTrade.entryTs).toBe(res.body.equityCurve[1].t);
    const bar1 = await prisma.stockPrice.findFirstOrThrow({
      where: { stock: { symbol: 'OGDC' }, interval: 'D1', ts: new Date(res.body.equityCurve[1].t) },
    });
    // filled at bar 1's OPEN plus 5 bps adverse slippage
    expect(Number.parseFloat(firstTrade.entryPrice)).toBeCloseTo(
      Number.parseFloat(bar1.open.toString()) * 1.0005,
      5,
    );
    expect(res.body.strategyId).toBeNull();
    expect(res.body.strategyType).toBe('CUSTOM_RULES');
  });

  it('backtest: validates the range (≤ 10 years) and the inline definition', async () => {
    const big = await http()
      .post('/api/v1/backtests')
      .set(auth)
      .send({ strategyId: maStrategyId, ...RANGE, from: '2010-01-01' })
      .expect(422);
    expect(big.body.code).toBe('RANGE_TOO_LARGE');
    await http()
      .post('/api/v1/backtests')
      .set(auth)
      .send({ strategyId: maStrategyId, ...RANGE, from: '2026-11-13', to: '2026-01-01' })
      .expect(422);
    await http()
      .post('/api/v1/backtests')
      .set(auth)
      .send({ definition: { type: 'CUSTOM_RULES', entryRules: { bogus: 1 } }, symbol: 'HUBC', ...RANGE })
      .expect(422);
    const empty = await http()
      .post('/api/v1/backtests')
      .set(auth)
      .send({ strategyId: maStrategyId, ...RANGE, from: '2020-01-01', to: '2020-06-01' })
      .expect(422);
    expect(empty.body.code).toBe('INSUFFICIENT_DATA');
  });

  it('compare: metrics per strategy plus the buy-and-hold benchmark on the same bars', async () => {
    const res = await http()
      .post('/api/v1/backtests/compare')
      .set(auth)
      .send({
        strategyIds: [maStrategyId],
        definitions: [{ label: 'RSI default', type: 'RSI' }],
        ...RANGE,
      })
      .expect(200);
    expect(res.body.symbol).toBe('HUBC');
    expect(res.body.dataSource).toBe('SIMULATED');
    expect(res.body.disclaimer).toBe(BACKTEST_DISCLAIMER);
    expect(res.body.rows.map((r: { label: string }) => r.label)).toEqual(['bt ma', 'RSI default']);
    expect(res.body.benchmark.totalReturnPct).toMatch(/^-?\d+(\.\d+)?$/);
    // Same strategy, same inputs → same metrics as the persisted backtest.
    const bt = await http()
      .post('/api/v1/backtests')
      .set(auth)
      .send({ strategyId: maStrategyId, ...RANGE })
      .expect(201);
    expect(res.body.rows[0].metrics).toEqual(bt.body.metrics);
    await http()
      .post('/api/v1/backtests/compare')
      .set(auth)
      .send({ ...RANGE })
      .expect(422);
  });

  // ── evaluation ─────────────────────────────────────────────────────────────

  it('evaluate (PAPER, autoExecute): one signal per bar and a FILLED paper order with origin STRATEGY', async () => {
    const s = await createStrategy({
      name: 'paper auto',
      type: 'CUSTOM_RULES',
      entryRules: ALWAYS,
      autoExecute: true,
    }).expect(201);
    await http().post(`/api/v1/strategies/${s.body.id}/evaluate`).set(auth).expect(409); // inactive
    await http().post(`/api/v1/strategies/${s.body.id}/activate`).set(auth).expect(200);

    const ev = await http().post(`/api/v1/strategies/${s.body.id}/evaluate`).set(auth).expect(200);
    expect(ev.body.execution.status).toBe('SUCCEEDED');
    expect(ev.body.execution.barTs).toBe('2026-11-13T04:30:00.000Z');
    expect(ev.body.signal).toMatchObject({
      type: 'ENTRY',
      side: 'BUY',
      status: 'AUTO_EXECUTED_PAPER',
      mode: 'PAPER',
      barTs: '2026-11-13T04:30:00.000Z',
    });
    expect(ev.body.signal.price.source).toBe('SIMULATED');
    expect(ev.body.signal.trace.summary).toMatch(/close/);
    expect(ev.body.order.status).toBe('FILLED');

    const order = await http().get(`/api/v1/orders/${ev.body.order.id}`).set(auth).expect(200);
    expect(order.body).toMatchObject({
      origin: 'STRATEGY',
      mode: 'PAPER',
      status: 'FILLED',
      statusSource: 'SIMULATED',
    });
    expect(order.body.quantity).toBe(ev.body.signal.suggestedQty);
    expect(order.body.riskChecks.every((r: { passed: boolean }) => r.passed)).toBe(true);
    const approvedEvent = order.body.events.find((e: { to: string }) => e.to === 'APPROVED');
    expect(approvedEvent.actorType).toBe('STRATEGY');
    expect(
      await prisma.auditLog.count({
        where: { action: 'order.auto_approved_paper', entityId: ev.body.order.id },
      }),
    ).toBe(1);

    // Re-evaluating the same bar creates nothing new.
    const again = await http().post(`/api/v1/strategies/${s.body.id}/evaluate`).set(auth).expect(200);
    expect(again.body.execution.status).toBe('SUCCEEDED');
    expect(await prisma.strategySignal.count({ where: { strategyId: s.body.id } })).toBe(1);
    expect(await prisma.order.count({ where: { strategyId: s.body.id } })).toBe(1);

    const listed = await http().get(`/api/v1/strategies/${s.body.id}/signals`).set(auth).expect(200);
    expect(listed.body).toHaveLength(1);
    const byStatus = await http().get('/api/v1/signals?status=AUTO_EXECUTED_PAPER').set(auth).expect(200);
    expect(byStatus.body.map((x: { id: string }) => x.id)).toContain(ev.body.signal.id);
    expect((await http().get('/api/v1/signals').set(other).expect(200)).body).toEqual([]);
    await http().get(`/api/v1/signals/${ev.body.signal.id}`).set(other).expect(404);
    const execs = await http().get(`/api/v1/strategies/${s.body.id}/executions`).set(auth).expect(200);
    expect(execs.body).toHaveLength(2);
    await http().post(`/api/v1/strategies/${s.body.id}/deactivate`).set(auth).expect(200);
  });

  it('evaluate (PAPER, manual): idempotent per bar, no order', async () => {
    const s = await createStrategy({
      name: 'paper manual',
      symbol: 'OGDC',
      type: 'CUSTOM_RULES',
      entryRules: ALWAYS,
    }).expect(201);
    await http().post(`/api/v1/strategies/${s.body.id}/activate`).set(auth).expect(200);
    const first = await http().post(`/api/v1/strategies/${s.body.id}/evaluate`).set(auth).expect(200);
    expect(first.body.duplicate).toBe(false);
    expect(first.body.signal.status).toBe('NEW');
    expect(first.body.order).toBeNull();
    const second = await http().post(`/api/v1/strategies/${s.body.id}/evaluate`).set(auth).expect(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.signal.id).toBe(first.body.signal.id);
    expect(await prisma.strategySignal.count({ where: { strategyId: s.body.id } })).toBe(1);
    expect(await prisma.order.count({ where: { strategyId: s.body.id } })).toBe(0);
    await http().post(`/api/v1/strategies/${s.body.id}/deactivate`).set(auth).expect(200);
  });

  it('evaluate (LIVE): records a signal only — never creates or approves an order', async () => {
    const s = await createStrategy({
      name: 'live signal',
      portfolioId: liveId,
      type: 'CUSTOM_RULES',
      entryRules: ALWAYS,
    }).expect(201);
    await http().post(`/api/v1/strategies/${s.body.id}/activate`).set(auth).set(stepUp).expect(200);
    const ev = await http().post(`/api/v1/strategies/${s.body.id}/evaluate`).set(auth).expect(200);
    expect(ev.body.signal).toMatchObject({ type: 'ENTRY', mode: 'LIVE', status: 'NEW' });
    expect(ev.body.order).toBeNull();
    expect(ev.body.note).toMatch(/LIVE/);
    expect(await prisma.order.count({ where: { strategyId: s.body.id } })).toBe(0);
    expect(await prisma.order.count({ where: { portfolioId: liveId, status: 'APPROVED' } })).toBe(0);
  });

  it('system PAPER approval is impossible for LIVE orders and for non-strategy orders', async () => {
    const meta = {};
    const live = await trading.preview(
      ownerId,
      {
        portfolioId: liveId,
        symbol: 'HUBC',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '1',
        limitPrice: '100',
        origin: 'STRATEGY',
      },
      `live-${randomUUID()}`,
      meta,
      'STRATEGY',
    );
    expect(live.mode).toBe('LIVE');
    // Force it into an approvable state so only the PAPER-only guard can stop it.
    await prisma.order.update({ where: { id: live.id }, data: { status: 'PREVIEWED' } });
    const hash = (await prisma.order.findUniqueOrThrow({ where: { id: live.id } })).previewHash!;
    await expect(trading.approveSystemPaper(ownerId, live.id, hash, meta)).rejects.toMatchObject({
      response: { code: 'SYSTEM_APPROVAL_FORBIDDEN' },
    });
    const after = await prisma.order.findUniqueOrThrow({ where: { id: live.id } });
    expect(after.status).toBe('PREVIEWED');
    expect(after.approvedAt).toBeNull();

    const manual = await trading.preview(
      ownerId,
      { portfolioId: paperId, symbol: 'HUBC', side: 'BUY', type: 'MARKET', quantity: '1', origin: 'MANUAL' },
      `manual-${randomUUID()}`,
      meta,
    );
    expect(manual.status).toBe('PREVIEWED');
    await expect(
      trading.approveSystemPaper(ownerId, manual.id, manual.previewHash!, meta),
    ).rejects.toMatchObject({
      response: { code: 'SYSTEM_APPROVAL_FORBIDDEN' },
    });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: manual.id } })).status).toBe('PREVIEWED');
  });
});
