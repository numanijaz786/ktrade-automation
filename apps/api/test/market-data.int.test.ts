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
import { ARGON2_OPTIONS } from '../src/auth/password-policy.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Market data + watchlists on real PostgreSQL, seeded with SIMULATED history.
 * Clock: Monday 2026-11-16 10:00 PKT (session open). Opt-in: RUN_INTEGRATION=1.
 */
describe('market data & watchlists (integration, real PostgreSQL)', () => {
  const NOW = new Date('2026-11-16T05:00:00Z');
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: Record<string, string>;
  let stepUp: Record<string, string>;
  let viewer: Record<string, string>;
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
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  it('requires authentication', async () => {
    await http().get('/api/v1/market/overview').expect(401);
  });

  it('order preview fetches prices itself when none were loaded yet; duplicate portfolio names are a 409', async () => {
    await prisma.stockQuote.deleteMany({});
    const paper = await http()
      .post('/api/v1/portfolios')
      .set(auth)
      .send({ name: 'Cold start', initialCash: '100000' })
      .expect(201);
    const dup = await http()
      .post('/api/v1/portfolios')
      .set(auth)
      .send({ name: 'Cold start', initialCash: '1' })
      .expect(409);
    expect(dup.body.code).toBe('ALREADY_EXISTS');
    const prev = await http()
      .post('/api/v1/orders/preview')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ portfolioId: paper.body.id, symbol: 'OGDC', side: 'BUY', type: 'MARKET', quantity: '1' })
      .expect(201);
    expect(prev.body.status).toBe('PREVIEWED');
    expect(prev.body.referencePrice.source).toBe('SIMULATED');
  });

  it('overview: session state, breadth, movers, sectors — all labelled SIMULATED with a timestamp', async () => {
    const res = await http().get('/api/v1/market/overview').set(auth).expect(200);
    expect(res.body.session).toMatchObject({ open: true, tradingDay: true });
    expect(res.body.breadth.total).toBe(30);
    expect(res.body.breadth.advancers + res.body.breadth.decliners + res.body.breadth.unchanged).toBe(30);
    expect(res.body.dataSource).toBe('SIMULATED');
    expect(Date.parse(res.body.asOf)).toBeLessThanOrEqual(NOW.getTime());
    expect(res.body.sectors.length).toBeGreaterThan(5);
    const pcts = res.body.gainers.map((g: { changePct: string }) => Number(g.changePct));
    expect(pcts).toEqual([...pcts].sort((a, b) => b - a));
  });

  it('stocks: search, sector filter, pagination; details with 52-week stats; unknown → 404', async () => {
    const search = await http().get('/api/v1/market/stocks?search=oil').set(auth).expect(200);
    expect(search.body.data.map((s: { symbol: string }) => s.symbol)).toContain('OGDC');
    const ogdcSector = search.body.data.find((s: { symbol: string }) => s.symbol === 'OGDC').sector;
    const bySector = await http()
      .get(`/api/v1/market/stocks?sector=${encodeURIComponent(ogdcSector)}`)
      .set(auth)
      .expect(200);
    expect(bySector.body.data.every((s: { sector: string }) => s.sector === ogdcSector)).toBe(true);
    const page = await http().get('/api/v1/market/stocks?limit=10&offset=10').set(auth).expect(200);
    expect([page.body.total, page.body.data.length]).toEqual([30, 10]);

    const ogdc = await http().get('/api/v1/market/stocks/ogdc').set(auth).expect(200); // case-insensitive
    expect(ogdc.body).toMatchObject({ symbol: 'OGDC', quote: { source: 'SIMULATED', stale: false } });
    expect(Number(ogdc.body.stats.week52High)).toBeGreaterThanOrEqual(Number(ogdc.body.stats.week52Low));
    expect(ogdc.body.stats.historySource).toBe('SIMULATED');

    await http().get('/api/v1/market/stocks/NOPE').set(auth).expect(404);
    await http().get('/api/v1/market/stocks/bad%20symbol').set(auth).expect(422);
  });

  it('quotes are persisted to stock_quotes, so paper-order previews are priced from them', async () => {
    const q = await http().get('/api/v1/market/quotes?symbols=OGDC,HUBC').set(auth).expect(200);
    expect(q.body.map((x: { symbol: string }) => x.symbol)).toEqual(['HUBC', 'OGDC']);
    for (const x of q.body) {
      expect(x).toMatchObject({ source: 'SIMULATED', providerKey: 'simulated', stale: false });
      expect(Number(x.last)).toBeGreaterThan(0);
    }
    expect(await prisma.stockQuote.count()).toBe(30);
    await http().get('/api/v1/market/quotes?symbols=NOPE').set(auth).expect(404);

    const paper = await http()
      .post('/api/v1/portfolios')
      .set(auth)
      .send({ name: 'Paper', initialCash: '1000000' })
      .expect(201);
    const prev = await http()
      .post('/api/v1/orders/preview')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ portfolioId: paper.body.id, symbol: 'HUBC', side: 'BUY', type: 'MARKET', quantity: '10' })
      .expect(201);
    expect(prev.body.status).toBe('PREVIEWED');
    expect(prev.body.referencePrice.source).toBe('SIMULATED');
  });

  it('candles: daily from the DB with per-bar source, intraday from the provider, range validation', async () => {
    const d1 = await http()
      .get('/api/v1/market/candles/OGDC?interval=D1&from=2026-10-01&to=2026-11-13')
      .set(auth)
      .expect(200);
    expect(d1.body.bars.length).toBeGreaterThan(25);
    expect(d1.body.source).toBe('SIMULATED');
    expect(d1.body.bars.every((b: { source: string }) => b.source === 'SIMULATED')).toBe(true);
    const ts = d1.body.bars.map((b: { ts: string }) => b.ts);
    expect(ts).toEqual([...ts].sort());
    const m5 = await http()
      .get('/api/v1/market/candles/OGDC?interval=M5&from=2026-11-16&to=2026-11-16')
      .set(auth)
      .expect(200);
    expect(m5.body.bars.length).toBeGreaterThan(0);
    expect(
      (await http().get('/api/v1/market/candles/OGDC?from=2026-11-13&to=2026-11-01').set(auth).expect(400))
        .body.code,
    ).toBe('INVALID_RANGE');
  });

  it('imported real prices beat simulated ones, are labelled USER_REPORTED, and survive re-seeding', async () => {
    const csv =
      'symbol,date,open,high,low,close,volume\nOGDC,2026-11-13,230.00,236.00,229.50,235.75,2500000\n';
    await http().post('/api/v1/market/prices/import').set(viewer).send({ csv }).expect(403); // owner only
    await http().post('/api/v1/market/prices/import').set(auth).send({ csv }).expect(201);
    const [q] = (await http().get('/api/v1/market/quotes?symbols=OGDC').set(auth).expect(200)).body;
    expect(q).toMatchObject({ source: 'USER_REPORTED', providerKey: 'csv-eod', last: '235.75' });
    const bars = (
      await http().get('/api/v1/market/candles/OGDC?from=2026-11-12&to=2026-11-13').set(auth).expect(200)
    ).body.bars;
    expect(bars.find((b: { ts: string }) => b.ts.startsWith('2026-11-13'))?.source).toBe('USER_REPORTED');

    const { seedMarketData } = await import('../src/seed/stocks.js');
    await seedMarketData(prisma, { now: () => NOW }, { years: 1 });
    const again = (
      await http().get('/api/v1/market/candles/OGDC?from=2026-11-12&to=2026-11-13').set(auth).expect(200)
    ).body.bars;
    expect(again.find((b: { ts: string }) => b.ts.startsWith('2026-11-13'))).toMatchObject({
      source: 'USER_REPORTED',
      close: '235.75',
    });

    const bad = await http()
      .post('/api/v1/market/prices/import')
      .set(auth)
      .send({ csv: 'symbol,date,open,high,low,close,volume\nOGDC,2026-11-12,10,5,9,,1\n' })
      .expect(422);
    expect(bad.headers['content-type']).toContain('application/problem+json');
  });

  it('providers: licensed vendor listed but cannot be activated; switching needs step-up', async () => {
    const list = await http().get('/api/v1/market/providers').set(auth).expect(200);
    expect(list.body.find((p: { key: string }) => p.key === 'capitalstake')).toMatchObject({
      enabled: false,
      active: false,
    });
    expect(list.body.find((p: { key: string }) => p.key === 'simulated').active).toBe(true);
    await http().put('/api/v1/market/providers/active').set(auth).send({ key: 'capitalstake' }).expect(403);
    const blocked = await http()
      .put('/api/v1/market/providers/active')
      .set(auth)
      .set(stepUp)
      .send({ key: 'capitalstake' })
      .expect(409);
    expect(blocked.body.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('watchlists: full CRUD with quotes, validation, and per-user isolation', async () => {
    const created = await http()
      .post('/api/v1/watchlists')
      .set(auth)
      .send({ name: 'Energy', symbols: ['OGDC', 'ppl'] })
      .expect(201);
    const id = created.body.id;
    expect(created.body.items.map((i: { symbol: string }) => i.symbol)).toEqual(['OGDC', 'PPL']);
    expect(created.body.items[0].quote.source).toEqual(expect.any(String));

    expect(
      (await http().post('/api/v1/watchlists').set(auth).send({ name: 'Energy' }).expect(409)).body.code,
    ).toBe('ALREADY_EXISTS');
    await http()
      .post('/api/v1/watchlists')
      .set(auth)
      .send({ name: 'Bad', symbols: ['NOPE'] })
      .expect(404);
    await http().post('/api/v1/watchlists').set(auth).send({ name: 'Banks' }).expect(201);

    await http().patch(`/api/v1/watchlists/${id}`).set(auth).send({ name: 'Energy & Power' }).expect(200);
    const added = await http()
      .post(`/api/v1/watchlists/${id}/stocks`)
      .set(auth)
      .send({ symbol: 'HUBC' })
      .expect(200);
    expect(added.body.items).toHaveLength(3);
    await http().post(`/api/v1/watchlists/${id}/stocks`).set(auth).send({ symbol: 'HUBC' }).expect(200); // idempotent
    await http().post(`/api/v1/watchlists/${id}/stocks`).set(auth).send({ symbol: 'NOPE' }).expect(404);
    const removed = await http().delete(`/api/v1/watchlists/${id}/stocks/PPL`).set(auth).expect(200);
    expect(removed.body.items.map((i: { symbol: string }) => i.symbol)).toEqual(['OGDC', 'HUBC']);
    await http().delete(`/api/v1/watchlists/${id}/stocks/PPL`).set(auth).expect(404);

    const lists = await http().get('/api/v1/watchlists').set(auth).expect(200);
    expect(lists.body.map((l: { name: string }) => l.name)).toEqual(['Energy & Power', 'Banks']);

    // Another user can neither see nor change these lists (404, not 403: ids are not disclosed).
    expect((await http().get('/api/v1/watchlists').set(viewer).expect(200)).body).toEqual([]);
    await http().get(`/api/v1/watchlists/${id}`).set(viewer).expect(404);
    await http().delete(`/api/v1/watchlists/${id}`).set(viewer).expect(403); // viewer is read-only anyway

    await http().delete(`/api/v1/watchlists/${id}`).set(auth).expect(204);
    await http().get(`/api/v1/watchlists/${id}`).set(auth).expect(404);
    expect(await prisma.watchlistStock.count({ where: { watchlistId: id } })).toBe(0);
  });
});
