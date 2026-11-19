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
import type { AdvisorScheduler } from '../src/advisor/advisor.scheduler.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Advisor on real PostgreSQL. Two data sets, never mixed up:
 *  - the seeded SIMULATED history (must never produce a recommendation);
 *  - SYNTHETIC TEST BARS inserted below as USER_REPORTED purely to exercise the rules. They are invented by a
 *    deterministic formula, are not market data, and must never be read as real prices.
 * Clock: Friday 2026-11-13 16:00 PKT (after the close), later moved to Monday 2026-11-16 16:00 PKT.
 * Opt-in: RUN_INTEGRATION=1.
 */
const FRI = new Date('2026-11-13T11:00:00Z');
const MON = new Date('2026-11-16T11:00:00Z');
const SIM_REASON = 'simulated data — not for investment decisions';
const WAVE = [0, 1, 2, 1, 0, -1, -2, -1] as const;

/** Weekday dates ascending, ending at `end` inclusive. */
function weekdays(end: string, n: number): string[] {
  const out: string[] = [];
  const t = new Date(`${end}T00:00:00Z`);
  while (out.length < n) {
    const wd = t.getUTCDay();
    if (wd !== 0 && wd !== 6) out.unshift(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() - 1);
  }
  return out;
}

interface SynthBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
/** SYNTHETIC: close_i = start + slope*i + wave; open = previous close. */
function synthetic(end: string, n: number, start: number, slope: number, volume: number): SynthBar[] {
  const dates = weekdays(end, n);
  let prev = start;
  return dates.map((date, i) => {
    const c = Math.round((start + slope * i + (WAVE[i % 8] as number)) * 100) / 100;
    const o = i === 0 ? c : prev;
    prev = c;
    return {
      date,
      o,
      h: Math.round((Math.max(o, c) + 0.5) * 100) / 100,
      l: Math.round((Math.min(o, c) - 0.5) * 100) / 100,
      c,
      v: Math.round((volume * (20 + (i % 5))) / 20),
    };
  });
}

describe('advisor (integration, real PostgreSQL)', () => {
  let now = FRI;
  const clock = { now: () => new Date(now) };
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduler: AdvisorScheduler;
  let auth: Record<string, string>;
  let other: Record<string, string>;
  let viewer: Record<string, string>;
  let ownerId: string;
  let portfolioId: string;
  let otherPortfolioId: string;
  const ids: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const get = (path: string, h = auth) => http().get(`/api/v1/advisor${path}`).set(h);
  const post = (path: string, body: unknown, h = auth) =>
    http()
      .post(`/api/v1/advisor${path}`)
      .set(h)
      .send(body as object);
  const report = (horizon = 'SWING', h = auth, pid = portfolioId) =>
    get(`/daily-report?portfolioId=${pid}&horizon=${horizon}`, h);

  async function insertBars(symbol: string, bars: SynthBar[]) {
    await prisma.stockPrice.createMany({
      data: bars.map((b) => ({
        stockId: ids[symbol]!,
        interval: 'D1' as const,
        ts: new Date(`${b.date}T04:30:00.000Z`),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: BigInt(b.v),
        providerKey: 'synthetic-test',
        source: 'USER_REPORTED' as const,
      })),
      skipDuplicates: true,
    });
  }
  async function setQuote(symbol: string, last: number, asOf: Date) {
    const data = {
      last,
      asOf,
      delayMinutes: 0,
      providerKey: 'synthetic-test',
      source: 'USER_REPORTED' as const,
    };
    await prisma.stockQuote.upsert({
      where: { stockId: ids[symbol]! },
      create: { stockId: ids[symbol]!, ...data },
      update: data,
    });
  }
  async function addFinancials(
    symbol: string,
    eps: number,
    revenue: number,
    priorRevenue: number,
    priorEps: number,
  ) {
    const base = {
      stockId: ids[symbol]!,
      periodType: 'ANNUAL' as const,
      currency: 'PKR',
      source: 'USER_REPORTED' as const,
      sourceRef: 'SYNTHETIC TEST FIXTURE (not a real filing)',
    };
    await prisma.companyFinancial.createMany({
      data: [
        {
          ...base,
          periodEnd: new Date('2025-12-31T00:00:00Z'),
          publishedAt: new Date('2026-02-15T00:00:00Z'),
          revenue,
          netProfit: eps * 10,
          eps,
          totalAssets: 2000,
          totalEquity: 800,
          totalDebt: 300,
          sharesOutstanding: 10,
          dividendPerShare: 4,
        },
        {
          ...base,
          periodEnd: new Date('2024-12-31T00:00:00Z'),
          publishedAt: new Date('2025-02-15T00:00:00Z'),
          revenue: priorRevenue,
          netProfit: priorEps * 10,
          eps: priorEps,
          totalAssets: 1900,
          totalEquity: 700,
          totalDebt: 300,
          sharesOutstanding: 10,
        },
      ],
    });
  }

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', { env: process.env, stdio: 'pipe' });
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/bootstrap.js');
    const { RedisHealth } = await import('../src/redis/redis.module.js');
    const { PrismaService: PS } = await import('../src/prisma/prisma.service.js');
    const { CLOCK } = await import('../src/common/clock.js');
    const { AdvisorScheduler: AS } = await import('../src/advisor/advisor.scheduler.js');
    const { seedMarketData } = await import('../src/seed/stocks.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisHealth)
      .useValue({
        ping: async () => true,
        onModuleInit: () => undefined,
        onModuleDestroy: async () => undefined,
      })
      .overrideProvider(getOptionsToken())
      .useValue({ throttlers: [{ name: 'default', ttl: 60_000, limit: 5000 }], skipIf: () => true })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PS);
    scheduler = app.get(AS);
    await seedMarketData(prisma, clock, { years: 1 }); // SIMULATED history only

    const reg = await http()
      .post('/api/v1/auth/register')
      .send({ email: 'o@example.com', password: 'a long owner passphrase', displayName: 'O' })
      .expect(201);
    auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    ownerId = (await prisma.user.findFirstOrThrow({ where: { email: 'o@example.com' } })).id;
    for (const [email, role] of [
      ['x@example.com', 'OWNER'],
      ['v@example.com', 'VIEWER'],
    ] as const) {
      await prisma.user.create({
        data: {
          email,
          passwordHash: await argon2.hash('other-user-password', ARGON2_OPTIONS),
          displayName: email,
          role,
        },
      });
    }
    const login = async (email: string) => ({
      Authorization: `Bearer ${(await http().post('/api/v1/auth/login').send({ email, password: 'other-user-password' }).expect(200)).body.accessToken}`,
    });
    other = await login('x@example.com');
    viewer = await login('v@example.com');

    portfolioId = (
      await http()
        .post('/api/v1/portfolios')
        .set(auth)
        .send({ name: 'Paper', initialCash: '1000000' })
        .expect(201)
    ).body.id;
    otherPortfolioId = (
      await http()
        .post('/api/v1/portfolios')
        .set(other)
        .send({ name: 'Other paper', initialCash: '500000' })
        .expect(201)
    ).body.id;

    // A holding on a SIMULATED-priced stock (ledger-shaped row: qty, fee-inclusive avg cost, total cost).
    const ogdc = await prisma.stock.findUniqueOrThrow({ where: { symbol: 'OGDC' } });
    ids.OGDC = ogdc.id;
    await prisma.holding.create({
      data: { portfolioId, stockId: ogdc.id, quantity: 100, avgCost: 200, totalCost: 20000, realizedPnl: 0 },
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  // ───────────────────────── access & settings ─────────────────────────

  it('requires authentication; only the OWNER may run or change settings', async () => {
    await http().get('/api/v1/advisor/settings').expect(401);
    await http().get(`/api/v1/advisor/daily-report?portfolioId=${portfolioId}`).expect(401);
    await post('/run', { portfolioId }, viewer).expect(403);
    await http().put('/api/v1/advisor/settings').set(viewer).send({ riskPerTradePct: '2' }).expect(403);
    await get('/settings', viewer).expect(200);
  });

  it('risk per trade defaults to a conservative 1 and is validated', async () => {
    expect((await get('/settings').expect(200)).body).toEqual({ riskPerTradePct: '1', isDefault: true });
    const put = (body: unknown) =>
      http()
        .put('/api/v1/advisor/settings')
        .set(auth)
        .send(body as object);
    for (const bad of ['0', '-1', '6', 'abc', '1.234', '', 1])
      await put({ riskPerTradePct: bad }).expect(422);
    await put({ riskPerTradePct: '1', extra: true }).expect(422);
    expect((await put({ riskPerTradePct: '0.5' }).expect(200)).body).toEqual({
      riskPerTradePct: '0.5',
      isDefault: false,
    });
    expect((await get('/settings').expect(200)).body.riskPerTradePct).toBe('0.5');
    expect((await get('/settings', other).expect(200)).body.isDefault).toBe(true); // per user
    await put({ riskPerTradePct: '1' }).expect(200);
    const prefs = (await prisma.userSettings.findUniqueOrThrow({ where: { userId: ownerId } })).preferences;
    expect(prefs).toMatchObject({ advisor: { riskPerTradePct: '1' } });
  });

  // ───────────────────────── only SIMULATED data ─────────────────────────

  describe('with only seeded SIMULATED data', () => {
    it('the daily report says there is not enough verified data and gives no targets', async () => {
      const r = (await report().expect(200)).body;
      expect(r.headline).toBe('Not enough verified data to recommend anything');
      expect(r.dataQuality.sources).toEqual({ SIMULATED: expect.any(Number) });
      expect(r.dataQuality.simulatedShare).toBe('100.00');
      expect(r.dataQuality.missingFundamentalsCount).toBeGreaterThan(0);
      expect(r.notEnoughData.reasons[0].reason).toBe(SIM_REASON);
      expect(r.notEnoughData.summary).toContain('SIMULATED');
      for (const k of ['topBuys', 'avoidOrSell', 'holds', 'opportunities']) expect(r[k]).toEqual([]);
      expect(JSON.stringify(r)).not.toMatch(/"targets":\[\{/);
      expect(r.whatChanged.baseline).toBe(false);
      // holdings P&L facts are still present, labelled with their source
      const h = r.holdingsAdvice[0];
      expect(h.symbol).toBe('OGDC');
      expect(h.advice).toBeNull();
      expect(h.pnl.priceSource).toBe('SIMULATED');
      expect(h.pnl.unrealizedGross).toBeDefined();
      expect(h.pnl.estimatedSellFees).toBeDefined();
      expect(r.portfolioNotes.map((n: { kind: string }) => n.kind)).toContain('SIMULATED_PRICES');
    });

    it('a run stores every result as NOT_ACTIONABLE with the simulated reason and no levels', async () => {
      const run = (await post('/run', { portfolioId }).expect(200)).body;
      expect(run.stored).toBe(run.evaluated);
      expect(run.failed).toEqual([]);
      expect(run.actionable).toBe(0);
      const rows = await prisma.recommendation.findMany({ where: { userId: ownerId } });
      expect(rows.length).toBe(run.stored);
      for (const r of rows) {
        expect(r.status).toBe('NOT_ACTIONABLE');
        expect(r.priceSource).toBe('SIMULATED');
        expect(r.target1 ?? r.target2 ?? r.target3 ?? r.stop ?? r.entryLow).toBeNull();
        expect((r.components as { notActionableReasons: string[] }).notActionableReasons[0]).toBe(SIM_REASON);
      }
    });

    it('holdings, scanner and the stock report refuse to advise on simulated data', async () => {
      const h = (await get(`/holdings?portfolioId=${portfolioId}`).expect(200)).body.holdings[0];
      expect(h.status).toBe('NOT_ACTIONABLE');
      expect(h.notActionableReasons[0]).toBe(SIM_REASON);
      expect(h.pnl.unrealizedNet).toBeDefined();
      const sc = (await get('/scanner?filter=momentum').expect(200)).body;
      expect(sc.results).toEqual([]);
      expect(sc.note).toContain('No stock has verified');
      const s = (await get('/stocks/OGDC').expect(200)).body;
      expect(s.price.source).toBe('SIMULATED');
      expect(s.price.verified).toBe(false);
      expect(s.technicals.notice).toContain('SIMULATED');
      for (const rec of Object.values(s.recommendations) as { status: string; plan: unknown }[]) {
        expect(rec.status).toBe('NOT_ACTIONABLE');
        expect(rec.plan).toBeNull();
      }
      expect(s.ratios.status).toBe('UNAVAILABLE');
      expect(s.explanation.llm.available).toBe(false);
      await get('/stocks/NOPE').expect(404);
      await get('/stocks/ogdc!').expect(422);
    });
  });

  // ───────────────────────── synthetic USER_REPORTED data ─────────────────────────

  describe('with clearly-labelled synthetic USER_REPORTED bars', () => {
    const FRI_CLOSE = new Date('2026-11-13T10:30:00Z');
    beforeAll(async () => {
      const mk = async (symbol: string, sector: string) => {
        ids[symbol] = (
          await prisma.stock.create({ data: { symbol, name: `SYNTHETIC TEST ${symbol}`, sector } })
        ).id;
      };
      await mk('SYNUP', 'SYNTHETIC SECTOR');
      for (const p of ['SYNP1', 'SYNP2', 'SYNP3']) await mk(p, 'SYNTHETIC SECTOR');
      await mk('SYNDN', 'SYNTHETIC DOWN');
      await mk('SYNFLAT', 'SYNTHETIC ILLIQUID');
      await mk('SYNSTALE', 'SYNTHETIC STALE');

      const up = synthetic('2026-11-13', 300, 100, 0.3, 1_000_000);
      await insertBars('SYNUP', up);
      await insertBars('SYNSTALE', up);
      for (const p of ['SYNP1', 'SYNP2', 'SYNP3']) {
        await insertBars(p, synthetic('2026-11-13', 300, 100, 0.05, 1_000_000));
        await setQuote(p, 115, FRI_CLOSE);
      }
      await insertBars('SYNDN', synthetic('2026-11-13', 300, 300, -0.3, 1_000_000));
      await insertBars('SYNFLAT', synthetic('2026-11-13', 300, 50, 0, 1_000));
      await setQuote('SYNUP', up[up.length - 1]!.c, FRI_CLOSE);
      await setQuote('SYNDN', 210, FRI_CLOSE);
      await setQuote('SYNFLAT', 50, FRI_CLOSE);
      // a quote seven days old: the price is stale, so nothing may be recommended
      await setQuote('SYNSTALE', up[up.length - 1]!.c, new Date('2026-11-06T10:30:00Z'));

      await addFinancials('SYNUP', 12, 1200, 1000, 10);
      for (const p of ['SYNP1', 'SYNP2', 'SYNP3']) await addFinancials(p, 5.5, 1000, 900, 5);
    }, 120_000);

    it('ranks an actionable buy with entry, stop, targets, size and fees', async () => {
      const r = (await report('SWING').expect(200)).body;
      expect(r.headline).not.toBe('Not enough verified data to recommend anything');
      const top = r.topBuys[0];
      expect(top.symbol).toBe('SYNUP');
      expect(['BUY', 'STRONG_BUY']).toContain(top.action);
      expect(top.price.source).toBe('USER_REPORTED');
      const plan = top.plan;
      expect(Number(plan.entry.high)).toBeGreaterThanOrEqual(Number(plan.entry.low));
      expect(Number(plan.stopLoss.price)).toBeLessThan(Number(plan.entry.low));
      expect(plan.targets).toHaveLength(3);
      expect(Number(plan.targets[0].price)).toBeGreaterThan(Number(plan.entry.high));
      expect(Number(plan.size.quantity)).toBeGreaterThan(0);
      expect(Number(plan.size.estimatedBuyFees)).toBeGreaterThan(0);
      expect(Number(plan.size.maxLossAtStop)).toBeGreaterThan(0);
      expect(top.confidence.score).toBeDefined();
      expect(top.explanation.available).toBe(true);
      expect(r.opportunities[0].rank).toBe(1);
      expect(r.dataQuality.sources.USER_REPORTED).toBeGreaterThan(0);
      expect(r.dataQuality.staleCount).toBeGreaterThanOrEqual(1); // SYNSTALE
      expect(r.newsImpact.items).toEqual([]);
      expect(r.portfolioNotes.map((n: { kind: string }) => n.kind)).toEqual(
        expect.arrayContaining(['CASH_ALLOCATION', 'DRAWDOWN']),
      );
      // risk per trade sizes the position: 0.5% risks less than 2% (sizes may bind on the position cap, so <=)
      await http().put('/api/v1/advisor/settings').set(auth).send({ riskPerTradePct: '0.25' }).expect(200);
      const small = (await report('SWING').expect(200)).body.topBuys[0].plan.size;
      await http().put('/api/v1/advisor/settings').set(auth).send({ riskPerTradePct: '1' }).expect(200);
      expect(Number(small.maxLossAtStop)).toBeLessThanOrEqual(Number(plan.size.maxLossAtStop));
      expect(Number(small.maxLossAtStop)).toBeLessThan(Number(plan.size.maxLossAtStop) + 1e-9 + 1);
    });

    it('a stale quote makes the stock NOT_ACTIONABLE', async () => {
      const s = (await get('/stocks/SYNSTALE').expect(200)).body;
      expect(s.dataSources.stale).toBe(true);
      expect(s.recommendations.SWING.status).toBe('NOT_ACTIONABLE');
      expect(s.recommendations.SWING.notActionableReasons.join(' ')).toContain('stale');
      expect(s.recommendations.SWING.plan).toBeNull();
    });

    it('illiquid stocks are capped; downtrends are avoided unless held and structural', async () => {
      const flat = (await get('/stocks/SYNFLAT').expect(200)).body.recommendations.SWING;
      expect(['BUY', 'STRONG_BUY']).not.toContain(flat.action);
      expect(flat.plan).toBeNull();
      expect(flat.warnings.join(' ')).toContain('illiquid');
      const illiquid = (await get('/scanner?filter=illiquid').expect(200)).body;
      expect(illiquid.results.map((x: { symbol: string }) => x.symbol)).toContain('SYNFLAT');

      const r = (await report('SWING').expect(200)).body;
      const dn = r.avoidOrSell.find((x: { symbol: string }) => x.symbol === 'SYNDN');
      expect(dn).toBeDefined();
      expect(dn.action).toBe('AVOID'); // not held: nothing to sell
      expect(dn.plan).toBeNull();

      const dnId = ids.SYNDN!;
      await prisma.holding.create({
        data: { portfolioId, stockId: dnId, quantity: 50, avgCost: 250, totalCost: 12500, realizedPnl: 0 },
      });
      const held = (await report('SWING').expect(200)).body;
      const h = held.holdingsAdvice.find((x: { symbol: string }) => x.symbol === 'SYNDN');
      expect(h.price.source).toBe('USER_REPORTED');
      expect(h.pnl.feesAware).toBe(true);
      const sold = held.avoidOrSell.find((x: { symbol: string }) => x.symbol === 'SYNDN');
      expect(sold.action).toBe('SELL'); // held + structural deterioration
      expect(['EXIT', 'PARTIAL_SELL']).toContain(h.advice);
      await prisma.holding.delete({ where: { portfolioId_stockId: { portfolioId, stockId: dnId } } });
    });

    it('long-term views without fundamentals are NOT_ACTIONABLE; with them they are evaluated', async () => {
      const dn = (await get('/stocks/SYNDN').expect(200)).body.recommendations;
      for (const h of ['LONG_TERM', 'DIVIDEND', 'VALUE', 'GROWTH']) {
        expect(dn[h].status).toBe('NOT_ACTIONABLE');
        expect(dn[h].notActionableReasons[0]).toContain('requires fundamentals');
      }
      const up = (await get('/stocks/SYNUP').expect(200)).body;
      expect(up.recommendations.LONG_TERM.status).toBe('ACTIONABLE');
      expect(up.ratios.pe.status).toBe('OK');
      expect(up.ratios.dividendYield.status).toBe('OK'); // from the stored statement dividend per share
      expect(up.valuation.status).toBe('OK');
      expect(up.valuation.assumptions.length).toBeGreaterThan(0);
      expect(up.dataSources.fundamentals.peersUsed).toBe(3);
      expect(up.technicals.notice).toBeNull();
      expect(up.announcements).toEqual([]);
    });

    it('says "No strong buying opportunity today" when verified data exists but nothing qualifies', async () => {
      const r = (await report('DIVIDEND').expect(200)).body;
      expect(r.topBuys).toEqual([]);
      expect(r.headline).toBe('No strong buying opportunity today');
      expect(r.notEnoughData).toBeNull();
    });

    it('scanner returns a ranked list of at most 20, possibly empty', async () => {
      const m = (await get('/scanner?filter=momentum&horizon=SWING').expect(200)).body;
      expect(m.results.length).toBeLessThanOrEqual(20);
      for (const x of m.results) expect(x.matched.metric).toBeDefined();
      const none = (await get('/scanner?filter=highDividend&horizon=SWING').expect(200)).body;
      expect(none.results).toEqual([]);
      await get('/scanner?filter=bogus').expect(422);
    });
  });

  // ───────────────────────── persistence, changes, scheduler ─────────────────────────

  describe('persistence, what changed, scheduler', () => {
    let firstStored = 0;
    let stopPrice = 0;
    let lastClose = 0;

    it('a run stores rows; a re-run is idempotent; rows are append-only', async () => {
      const a = (await post('/run', { portfolioId, horizons: ['SWING', 'LONG_TERM'] }).expect(200)).body;
      expect(a.stored).toBeGreaterThan(0);
      firstStored = await prisma.recommendation.count({
        where: { userId: ownerId, horizon: { in: ['SWING', 'LONG_TERM'] } },
      });
      const b = (await post('/run', { portfolioId, horizons: ['SWING', 'LONG_TERM'] }).expect(200)).body;
      expect(b.stored).toBe(0);
      expect(b.alreadyStored).toBe(a.stored + a.alreadyStored);
      expect(
        await prisma.recommendation.count({
          where: { userId: ownerId, horizon: { in: ['SWING', 'LONG_TERM'] } },
        }),
      ).toBe(firstStored);
      const up = await prisma.recommendation.findFirstOrThrow({
        where: { userId: ownerId, stock: { symbol: 'SYNUP' }, horizon: 'SWING' },
      });
      expect(up.status).toBe('ACTIONABLE');
      expect(up.action).toBe('BUY');
      expect(up.priceSource).toBe('USER_REPORTED');
      expect(up.stop).not.toBeNull();
      expect(up.target1).not.toBeNull();
      stopPrice = Number(up.stop);
      lastClose = Number(up.price);
      await expect(
        prisma.recommendation.update({ where: { id: up.id }, data: { confidence: 1 } }),
      ).rejects.toThrow();
      const stale = await prisma.recommendation.findFirstOrThrow({
        where: { userId: ownerId, stock: { symbol: 'SYNSTALE' }, horizon: 'SWING' },
      });
      expect(stale.status).toBe('NOT_ACTIONABLE');
      expect((stale.components as { engineStatus: string }).engineStatus).toBe('NOT_ACTIONABLE');
    });

    it('bars after the decision time never change a run (look-ahead safety)', async () => {
      const before = (await report('SWING').expect(200)).body;
      // A Monday bar crashing through the stop, inserted while the clock is still Friday evening.
      await insertBars('SYNUP', [
        {
          date: '2026-11-16',
          o: lastClose,
          h: lastClose,
          l: Math.round((stopPrice - 1) * 100) / 100,
          c: Math.round((stopPrice - 0.5) * 100) / 100,
          v: 2_000_000,
        },
      ]);
      const after = (await report('SWING').expect(200)).body;
      expect(after.topBuys[0]).toEqual(before.topBuys[0]);
      expect(after.whatChanged.events).toEqual([]);
      const rerun = (await post('/run', { portfolioId, horizons: ['SWING', 'LONG_TERM'] }).expect(200)).body;
      expect(rerun.stored).toBe(0);
      expect(
        await prisma.recommendation.count({
          where: { userId: ownerId, horizon: { in: ['SWING', 'LONG_TERM'] } },
        }),
      ).toBe(firstStored);
    });

    it('whatChanged diffs two runs on different bars; the scheduler notifies once', async () => {
      now = MON;
      // Fresh Monday prices for the other synthetic stocks so that only SYNUP's crash differs.
      const mon = (symbol: string, close: number, prev: number) =>
        insertBars(symbol, [
          {
            date: '2026-11-16',
            o: prev,
            h: Math.max(prev, close) + 0.5,
            l: Math.min(prev, close) - 0.5,
            c: close,
            v: 1_000_000,
          },
        ]);
      const lastOf = async (symbol: string) =>
        Number(
          (
            await prisma.stockPrice.findFirstOrThrow({
              where: { stockId: ids[symbol]!, ts: { lt: new Date('2026-11-16T00:00:00Z') } },
              orderBy: { ts: 'desc' },
            })
          ).close,
        );
      for (const s of ['SYNP1', 'SYNP2', 'SYNP3', 'SYNDN', 'SYNSTALE']) {
        const p = await lastOf(s);
        await mon(s, p, p);
      }
      const closeMon = new Date('2026-11-16T10:30:00Z');
      for (const s of ['SYNUP', 'SYNP1', 'SYNP2', 'SYNP3', 'SYNDN', 'SYNSTALE', 'SYNFLAT'])
        await setQuote(s, 100, closeMon);
      await insertBars('SYNFLAT', [{ date: '2026-11-16', o: 50, h: 50.5, l: 49.5, c: 50, v: 1_000 }]);

      // fresh announcement about a held symbol
      await prisma.announcement.create({
        data: {
          stockId: ids.OGDC!,
          symbols: ['OGDC'],
          title: 'SYNTHETIC TEST announcement about OGDC',
          category: 'OTHER',
          source: 'USER_REPORTED',
          sourceName: 'SYNTHETIC TEST',
          publishedAt: new Date('2026-11-16T05:00:00Z'),
          retrievedAt: new Date('2026-11-16T06:00:00Z'),
          dedupeHash: 'synthetic-test-ann-1',
        },
      });

      const tick1 = await scheduler.tick(true);
      expect(tick1.ran).toBe(true);
      expect(tick1.stored).toBeGreaterThan(0);
      expect(tick1.notificationsCreated).toBeGreaterThan(0);
      const notes = await prisma.notification.findMany({ where: { userId: ownerId } });
      const keys = notes.map((n) => n.dedupeKey);
      expect(keys.some((k) => k?.startsWith('advisor:stop:'))).toBe(true);
      expect(keys.some((k) => k?.startsWith('advisor:news:'))).toBe(true);
      expect(notes.every((n) => n.channel === 'IN_APP')).toBe(true);
      expect(new Set(keys).size).toBe(keys.length);

      // second tick: nothing new anywhere
      const rowsAfter = await prisma.recommendation.count({ where: { userId: ownerId } });
      const tick2 = await scheduler.tick(true);
      expect(tick2.stored).toBe(0);
      expect(tick2.notificationsCreated).toBe(0);
      expect(await prisma.notification.count({ where: { userId: ownerId } })).toBe(notes.length);
      expect(await prisma.recommendation.count({ where: { userId: ownerId } })).toBe(rowsAfter);
      // the once-a-day guard also holds without force
      expect((await scheduler.tick()).ran).toBe(false);

      const r = (await report('SWING').expect(200)).body;
      expect(r.whatChanged.baseline).toBe(true);
      const ev = r.whatChanged.events.filter((e: { symbol: string }) => e.symbol === 'SYNUP');
      expect(ev.map((e: { kind: string }) => e.kind)).toContain('STOP_HIT');
      expect(ev.find((e: { kind: string }) => e.kind === 'STOP_HIT').date).toBe('2026-11-16');
      expect(r.newsImpact.items.map((i: { title: string }) => i.title)).toContain(
        'SYNTHETIC TEST announcement about OGDC',
      );
      expect(r.newsImpact.items[0].affects[0]).toEqual({ symbol: 'OGDC', relation: 'HELD' });
      // two distinct bars are now stored for SYNUP
      const bars = await prisma.recommendation.findMany({
        where: { userId: ownerId, stock: { symbol: 'SYNUP' }, horizon: 'SWING' },
        orderBy: { asOfBar: 'asc' },
      });
      expect(bars.map((b) => b.asOfBar.toISOString().slice(0, 10))).toEqual(['2026-11-13', '2026-11-16']);
    });

    it('the scheduler does nothing on weekends or before 15:45 PKT', async () => {
      now = new Date('2026-11-16T10:00:00Z'); // Monday 15:00 PKT
      expect((await scheduler.tick(true)).reason).toBe('before 15:45 PKT');
      now = new Date('2026-11-14T11:00:00Z'); // Saturday
      expect((await scheduler.tick(true)).reason).toBe('not a PSX trading day');
      now = MON;
    });

    it('isolates owners: another user cannot read or run my portfolio and sees none of my history', async () => {
      await report('SWING', other, portfolioId).expect(404);
      await get(`/holdings?portfolioId=${portfolioId}`, other).expect(404);
      await post('/run', { portfolioId }, other).expect(404);
      const mine = await prisma.recommendation.count({ where: { userId: ownerId } });
      const theirs = (
        await post('/run', { portfolioId: otherPortfolioId, horizons: ['SWING'] }, other).expect(200)
      ).body;
      expect(theirs, JSON.stringify(theirs)).toMatchObject({ failed: [] });
      // the scheduler tick already stored this owner's rows for the same bar: a manual run repeats nothing
      expect(theirs.stored + theirs.alreadyStored).toBe(theirs.evaluated);
      const otherId = (await prisma.user.findFirstOrThrow({ where: { email: 'x@example.com' } })).id;
      expect(await prisma.recommendation.count({ where: { userId: otherId } })).toBeGreaterThan(0);
      const r = (await report('SWING', other, otherPortfolioId).expect(200)).body;
      expect(r.whatChanged.baseline).toBe(false); // my earlier rows are not their baseline
      expect(r.holdingsAdvice).toEqual([]);
      expect(await prisma.recommendation.count({ where: { userId: ownerId } })).toBe(mine);
      expect(
        await prisma.notification.count({
          where: { userId: (await prisma.user.findFirstOrThrow({ where: { email: 'x@example.com' } })).id },
        }),
      ).toBe(0);
    });
  });
});
