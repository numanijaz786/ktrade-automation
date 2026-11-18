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
import type { RecommendationsStore } from '../src/recommendations/recommendations.store.js';
import type { ResearchProviderRegistry } from '../src/research-data/research-provider-registry.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Research data layer + recommendation ledger on real PostgreSQL (docs/10).
 * Clock: Monday 2026-11-16 10:00 PKT. Opt-in: RUN_INTEGRATION=1.
 */
describe('research data & recommendations (integration, real PostgreSQL)', () => {
  const NOW = new Date('2026-11-16T05:00:00Z');
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let store: RecommendationsStore;
  let registry: ResearchProviderRegistry;
  let auth: Record<string, string>;
  let viewer: Record<string, string>;
  let ownerId: string;
  let viewerId: string;
  const stockIds: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const post = (path: string, body: unknown, h = auth) =>
    http()
      .post(`/api/v1${path}`)
      .set(h)
      .send(body as object);
  const get = (path: string, h = auth) => http().get(`/api/v1${path}`).set(h);

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', { env: process.env, stdio: 'pipe' });
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/bootstrap.js');
    const { RedisHealth } = await import('../src/redis/redis.module.js');
    const { PrismaService: PS } = await import('../src/prisma/prisma.service.js');
    const { CLOCK } = await import('../src/common/clock.js');
    const { RecommendationsStore: RS } = await import('../src/recommendations/recommendations.store.js');
    const { ResearchProviderRegistry: RPR } =
      await import('../src/research-data/research-provider-registry.js');
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
    store = app.get(RS);
    registry = app.get(RPR);

    for (const symbol of ['RESA', 'RESB', 'RESC', 'RESD', 'RESE', 'RESF', 'RESG', 'RESH', 'RESI']) {
      stockIds[symbol] = (await prisma.stock.create({ data: { symbol, name: `${symbol} Ltd` } })).id;
    }
    const reg = await http()
      .post('/api/v1/auth/register')
      .send({
        email: 'o@example.com',
        password: 'a long owner passphrase',
        displayName: 'O',
      })
      .expect(201);
    auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    ownerId = (await prisma.user.findUniqueOrThrow({ where: { email: 'o@example.com' } })).id;
    viewerId = (
      await prisma.user.create({
        data: {
          email: 'v@example.com',
          passwordHash: await argon2.hash('viewer-password-1', ARGON2_OPTIONS),
          displayName: 'V',
          role: 'VIEWER',
        },
      })
    ).id;
    viewer = {
      Authorization: `Bearer ${(await http().post('/api/v1/auth/login').send({ email: 'v@example.com', password: 'viewer-password-1' }).expect(200)).body.accessToken}`,
    };
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  // ─────────────────────────── access control ───────────────────────────

  it('requires authentication; viewers read but cannot write', async () => {
    await http().get('/api/v1/research/providers').expect(401);
    await http().get('/api/v1/recommendations').expect(401);
    await get('/research/providers', viewer).expect(200);
    await post(
      '/research/macro',
      { series: 'POLICY_RATE', date: '2026-11-10', value: '11', sourceRef: 'SBP MPS' },
      viewer,
    ).expect(403);
    await post('/research/announcements', { title: 'Hello world', publishedAt: '2026-11-10' }, viewer).expect(
      403,
    );
    await post('/research/financials/import', { csv: 'x' }, viewer).expect(403);
    await post('/recommendations/evaluate-outcomes', {}, viewer).expect(403);
  });

  // ─────────────────────────── financials ───────────────────────────

  describe('financials', () => {
    const body = {
      symbol: 'RESA',
      periodType: 'ANNUAL',
      periodEnd: '2025-12-31',
      publishedAt: '2026-03-01',
      sourceRef: 'RESA Annual Report 2025, p.84',
      revenue: '1000000.50',
      netProfit: '-250.25',
      eps: '-1.234567',
      totalAssets: '5000000',
      sharesOutstanding: '1000',
    };

    it('records, corrects in place, and returns decimal strings labelled USER_REPORTED', async () => {
      const a = await post('/research/financials', body).expect(201);
      expect(a.body).toMatchObject({
        created: true,
        source: 'USER_REPORTED',
        symbol: 'RESA',
        revenue: '1000000.5',
        eps: '-1.234567',
      });
      expect((await post('/research/financials', body).expect(201)).body.created).toBe(false);
      await post('/research/financials', { ...body, revenue: '2000000' }).expect(201);
      const list = await get('/research/financials?symbol=resa').expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ revenue: '2000000', periodEnd: '2025-12-31' });
      expect(list.body.data[0].grossProfit).toBeUndefined(); // absent stays absent
      const audits = await prisma.auditLog.count({ where: { action: 'research.financials_recorded' } });
      expect(audits).toBe(3);
    });

    it('rejects malformed, over-precise, future-dated and uncited input with 422 (never 500)', async () => {
      for (const bad of [
        { ...body, revenue: '1e5' },
        { ...body, revenue: 'abc' },
        { ...body, revenue: '1.23456' }, // > 4 dp
        { ...body, eps: '1.1234567' }, // > 6 dp
        { ...body, totalAssets: '-5' },
        { ...body, publishedAt: '2026-11-17' }, // future
        { ...body, publishedAt: '2025-12-30' }, // before period end
        { ...body, sourceRef: '' },
        { ...body, periodEnd: '2025-02-30' },
        {
          symbol: 'RESA',
          periodType: 'ANNUAL',
          periodEnd: '2025-12-31',
          publishedAt: '2026-03-01',
          sourceRef: 'doc p1',
        }, // no item
        { ...body, source: 'PROVIDER' }, // unknown key (strict)
      ])
        await post('/research/financials', bad).expect(422);
      await post('/research/financials', { ...body, symbol: 'NOPE' }).expect(404);
    });

    it('CSV import: inserted → unchanged → updated; all-or-nothing with row-level errors', async () => {
      const header = 'symbol,periodType,periodEnd,publishedAt,sourceRef,revenue,eps';
      const good = [
        header,
        'RESB,QUARTERLY,2026-03-31,2026-04-20,"RESB Q1 report, p.2",500,1.5',
        'RESB,quarterly,2026-06-30,2026-07-20,"RESB Q2 report, p.2",600,1.75',
      ].join('\n');
      const first = await post('/research/financials/import', { csv: good }).expect(201);
      expect(first.body).toMatchObject({
        rows: 2,
        inserted: 2,
        updated: 0,
        unchanged: 0,
        source: 'USER_REPORTED',
      });
      const again = await post('/research/financials/import', { csv: good }).expect(201);
      expect(again.body).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
      const changed = good.replace(',500,1.5', ',550,1.5');
      const third = await post('/research/financials/import', { csv: changed }).expect(201);
      expect(third.body).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });

      const count = () => prisma.companyFinancial.count({ where: { stockId: stockIds.RESB! } });
      const paths = (res: { body: { errors: { path: string; message: string }[] } }) =>
        res.body.errors.map((e) => `${e.path}: ${e.message}`);

      const badValue = await post('/research/financials/import', {
        csv: [
          header,
          'RESB,QUARTERLY,2026-09-30,2026-10-20,doc p1,abc,1',
          'RESB,QUARTERLY,2026-09-30,2026-10-20,doc p1,10,1',
        ].join('\n'),
      }).expect(422);
      expect(paths(badValue).some((p) => p.startsWith('rows.2.revenue'))).toBe(true);

      const future = await post('/research/financials/import', {
        csv: [header, 'RESB,QUARTERLY,2026-09-30,2026-11-20,doc p1,10,1'].join('\n'),
      }).expect(422);
      expect(paths(future)).toContain('rows.2.publishedAt: must not be in the future');

      const unknown = await post('/research/financials/import', {
        csv: [header, 'NOPE,QUARTERLY,2026-09-30,2026-10-20,doc p1,10,1'].join('\n'),
      }).expect(422);
      expect(paths(unknown)).toContain('rows.2.symbol: unknown symbol NOPE');

      const dup = await post('/research/financials/import', {
        csv: [
          header,
          'RESB,QUARTERLY,2026-09-30,2026-10-20,doc p1,10,1',
          'RESB,QUARTERLY,2026-09-30,2026-10-21,doc p1,11,1',
        ].join('\n'),
      }).expect(422);
      expect(paths(dup).some((p) => p.includes('duplicate RESB|QUARTERLY|2026-09-30'))).toBe(true);

      const missing = await post('/research/financials/import', { csv: 'symbol,revenue\nRESB,1' }).expect(
        422,
      );
      expect(paths(missing).some((p) => p.includes('missing column "periodType"'))).toBe(true);

      await post('/research/financials/import', { csv: 'x'.repeat(2 * 1024 * 1024 + 1) }).expect(422);
      expect(await count()).toBe(2); // nothing from the rejected files was stored
    });
  });

  // ─────────────────────────── announcements ───────────────────────────

  describe('announcements', () => {
    const base = {
      title: 'RESA board meeting on 20 Nov: Q1 results',
      url: 'https://example.com/a/1',
      category: 'BOARD_MEETING',
      symbol: 'RESA',
      publishedAt: '2026-11-15T05:00:00Z',
      summary: 'Board will consider results.',
    };

    it('records with retrievedAt = now; duplicate (normalised title+url+time) → 409', async () => {
      const a = await post('/research/announcements', base).expect(201);
      expect(a.body).toMatchObject({
        symbol: 'RESA',
        category: 'BOARD_MEETING',
        source: 'USER_REPORTED',
        retrievedAt: NOW.toISOString(),
        publishedAt: '2026-11-15T05:00:00.000Z',
        sentiment: null,
        sentimentSource: 'NONE',
        affectsHoldings: false,
      });
      const dup = await post('/research/announcements', {
        ...base,
        title: 'resa Board Meeting on 20 Nov -- Q1 results!',
        url: 'HTTPS://example.com/a/1/',
      }).expect(409);
      expect(dup.body.code).toBe('DUPLICATE_ANNOUNCEMENT');
      expect(await prisma.announcement.count()).toBe(1);
    });

    it('rejects future publishedAt, unknown symbols and bad input', async () => {
      await post('/research/announcements', {
        ...base,
        title: 'Future item',
        publishedAt: '2026-11-16T05:00:01Z',
      }).expect(422);
      await post('/research/announcements', {
        ...base,
        title: 'Tomorrow item',
        publishedAt: '2026-11-17',
      }).expect(422);
      await post('/research/announcements', { ...base, title: 'Unknown sym', symbol: 'NOPE' }).expect(404);
      await post('/research/announcements', { ...base, title: 'x' }).expect(422);
      await post('/research/announcements', { ...base, title: 'Bad url item', url: 'ftp://x' }).expect(422);
      await post('/research/announcements', { ...base, title: 'Bad rel item', relevance: 101 }).expect(422);
      expect(await prisma.announcement.count()).toBe(1);
    });

    it('CSV import: inserted vs skipped (existing and in-file duplicates), quoted commas; bad rows reject the file', async () => {
      const header = 'publishedAt,title,category,symbol,url,sentiment';
      const csv = [
        header,
        '2026-11-14,"RESB announces dividend, final",DIVIDEND,RESB,https://example.com/b/1,positive',
        '2026-11-14,"resb announces dividend final!",DIVIDEND,RESB,https://example.com/b/1/,positive',
        '2026-11-15T05:00:00Z,RESA board meeting on 20 Nov Q1 results,BOARD_MEETING,RESA,https://example.com/a/1,',
        '2026-11-12,Old item far outside the window,OTHER,,,',
      ].join('\n');
      const res = await post('/research/announcements/import', { csv }).expect(201);
      expect(res.body).toMatchObject({ rows: 4, inserted: 2, skipped: 2, source: 'USER_REPORTED' });
      const stored = await prisma.announcement.findFirstOrThrow({
        where: { title: { startsWith: 'RESB announces' } },
      });
      expect(stored).toMatchObject({
        sentiment: 'POSITIVE',
        sentimentSource: 'MANUAL',
        title: 'RESB announces dividend, final',
      });

      const issues = (r: { body: { errors: { path: string; message: string }[] } }) =>
        r.body.errors.map((e) => `${e.path}: ${e.message}`);
      const future = await post('/research/announcements/import', {
        csv: `${header}\n2026-11-17,Future thing here,OTHER,,,`,
      }).expect(422);
      expect(issues(future)).toContain('rows.2.publishedAt: must not be in the future');
      const unknown = await post('/research/announcements/import', {
        csv: `${header}\n2026-11-10,Unknown symbol thing,OTHER,NOPE,,`,
      }).expect(422);
      expect(issues(unknown)).toContain('rows.2.symbol: unknown symbol NOPE');
      const cat = await post('/research/announcements/import', {
        csv: `${header}\n2026-11-10,Bad category thing,WHATEVER,,,`,
      }).expect(422);
      expect(issues(cat).some((m) => m.startsWith('rows.2.category'))).toBe(true);
      expect(await prisma.announcement.count()).toBe(3);
    });

    it('list: filters, ordered by publishedAt desc, with retrievedAt', async () => {
      const all = await get('/research/announcements').expect(200);
      const times = all.body.data.map((x: { publishedAt: string }) => x.publishedAt);
      expect(times).toEqual([...times].sort().reverse());
      expect(all.body.data[0]).toHaveProperty('retrievedAt');
      expect(all.body.coverage).toBe('sources: owner-entered only');
      const resb = await get('/research/announcements?symbol=RESB').expect(200);
      expect(resb.body.data).toHaveLength(1);
      const div = await get('/research/announcements?category=DIVIDEND&since=2026-11-14').expect(200);
      expect(div.body.data.map((x: { symbol: string }) => x.symbol)).toEqual(['RESB']);
      await get('/research/announcements?category=BOGUS').expect(422);
    });

    it('news-feed: only items inside the freshness window, lastUpdated and coverage note', async () => {
      const feed = await get('/research/news-feed').expect(200); // default 72 h: since 2026-11-13 05:00Z
      const titles = feed.body.items.map((x: { title: string }) => x.title);
      expect(titles).toEqual(['RESA board meeting on 20 Nov: Q1 results', 'RESB announces dividend, final']);
      expect(titles).not.toContain('Old item far outside the window');
      expect(feed.body).toMatchObject({
        windowHours: 72,
        lastUpdated: NOW.toISOString(),
        coverage: 'sources: owner-entered only',
        count: 2,
      });
      const narrow = await get('/research/news-feed?windowHours=24').expect(200);
      expect(narrow.body.items.map((x: { symbol: string }) => x.symbol)).toEqual(['RESA']); // 11-14 00:00 PKT is 29 h old
      const wide = await get('/research/news-feed?windowHours=720').expect(200);
      expect(wide.body.count).toBe(3);
      const none = await get('/research/news-feed?windowHours=1').expect(200);
      expect(none.body.count).toBe(0);
      expect(none.body.note).toMatch(/Nothing is fetched automatically/);
      await get('/research/news-feed?windowHours=0').expect(422);
    });

    it('flags announcements that touch holdings (primary symbol or tagged symbols)', async () => {
      const portfolio = await prisma.portfolio.create({
        data: { userId: ownerId, name: 'Held', kind: 'PAPER', initialCash: '1000' },
      });
      await prisma.holding.create({
        data: {
          portfolioId: portfolio.id,
          stockId: stockIds.RESA!,
          quantity: '100',
          avgCost: '10',
          totalCost: '1000',
        },
      });
      await prisma.holding.create({
        data: {
          portfolioId: portfolio.id,
          stockId: stockIds.RESC!,
          quantity: '0',
          avgCost: '10',
          totalCost: '0',
        }, // sold out
      });
      const tagged = await post('/research/announcements', {
        title: 'Sector wide circular',
        category: 'SECTOR',
        publishedAt: '2026-11-16T04:00:00Z',
        symbols: ['RESC', 'RESA'],
      }).expect(201);
      expect(tagged.body).toMatchObject({ affectsHoldings: true, affectedSymbols: ['RESA'], symbol: null });
      const feed = await get('/research/news-feed').expect(200);
      const flags = Object.fromEntries(
        feed.body.items.map((i: { title: string; affectsHoldings: boolean }) => [i.title, i.affectsHoldings]),
      );
      expect(flags).toMatchObject({
        'RESA board meeting on 20 Nov: Q1 results': true,
        'RESB announces dividend, final': false,
        'Sector wide circular': true,
      });
      // The viewer holds nothing: same items, no flags.
      const viewerFeed = await get('/research/news-feed', viewer).expect(200);
      expect(viewerFeed.body.items.every((i: { affectsHoldings: boolean }) => !i.affectsHoldings)).toBe(true);
    });
  });

  // ─────────────────────────── macro ───────────────────────────

  describe('macro', () => {
    const body = {
      series: 'POLICY_RATE',
      date: '2026-11-10',
      value: '11.0000',
      sourceRef: 'SBP monetary policy statement',
    };

    it('records one value per series+date; re-posting corrects it and is audited', async () => {
      expect((await post('/research/macro', body).expect(201)).body).toMatchObject({
        created: true,
        value: '11',
        source: 'USER_REPORTED',
      });
      expect((await post('/research/macro', body).expect(201)).body.created).toBe(false);
      await post('/research/macro', { ...body, value: '10.5' }).expect(201);
      const list = await get('/research/macro?series=POLICY_RATE').expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].value).toBe('10.5');
      expect(await prisma.auditLog.count({ where: { action: 'research.macro_corrected' } })).toBe(1);
      await post('/research/macro', {
        series: 'USD_PKR',
        date: '2026-11-12',
        value: '280.1234',
        sourceRef: 'interbank close',
      }).expect(201);
      expect(
        (await get('/research/macro?from=2026-11-11').expect(200)).body.data.map(
          (x: { series: string }) => x.series,
        ),
      ).toEqual(['USD_PKR']);
    });

    it('validates: never 500 on junk, no future dates, levels must be positive', async () => {
      for (const bad of [
        { ...body, value: 'abc' },
        { ...body, value: '1e3' },
        { ...body, value: '1.1234567' },
        { ...body, date: '2026-11-17' },
        { ...body, date: '2026-02-30' },
        { ...body, series: 'GDP' },
        { ...body, series: 'USD_PKR', value: '0' },
        { ...body, series: 'KSE100_INDEX', value: '-5' },
        { ...body, sourceRef: '' },
      ])
        await post('/research/macro', bad).expect(422);
    });
  });

  // ─────────────────────────── providers ───────────────────────────

  describe('provider registry', () => {
    it('lists manual providers as enabled and every licensed stub as disabled with exactly what is missing', async () => {
      const res = await get('/research/providers').expect(200);
      const by = Object.fromEntries(res.body.data.map((p: { providerKey: string }) => [p.providerKey, p]));
      expect(Object.keys(by).sort()).toEqual([
        'capitalstake-fundamentals',
        'eodhd-fundamentals',
        'manual-announcements',
        'manual-fundamentals',
        'manual-macro',
        'psx-announcements',
        'sbp-easydata-macro',
      ]);
      for (const key of ['manual-fundamentals', 'manual-announcements', 'manual-macro']) {
        expect(by[key]).toMatchObject({
          enabled: true,
          status: 'OK',
          source: 'USER_REPORTED',
          commercialUseAllowed: false,
          missing: [],
        });
        expect(by[key].lastSuccessAt).toBe(NOW.toISOString());
        expect(typeof by[key].freshnessMinutes).toBe('number');
        expect(by[key].licenseNote).toMatch(/Owner-entered/);
      }
      for (const key of [
        'capitalstake-fundamentals',
        'eodhd-fundamentals',
        'sbp-easydata-macro',
        'psx-announcements',
      ]) {
        expect(by[key]).toMatchObject({
          enabled: false,
          status: 'NOT_CONFIGURED',
          lastSuccessAt: null,
          commercialUseAllowed: false,
        });
        expect(by[key].missing.length).toBeGreaterThan(0);
        expect(by[key].message).toBeTruthy();
      }
      expect(by['psx-announcements'].missing.join(' ')).toContain('marketdatarequest@psx.com.pk');
      expect(by['psx-announcements'].message).toMatch(/No scraping/);
      expect(by['sbp-easydata-macro'].missing.join(' ')).toMatch(/API key/);
      expect(by['capitalstake-fundamentals'].missing.join(' ')).toMatch(/licence/);
      expect(by['eodhd-fundamentals'].missing.join(' ')).toMatch(/PSX/);
      expect(await prisma.providerStatus.count()).toBe(7);
    });

    it('a disabled provider refuses every call and never falls back to another source', async () => {
      for (const key of [
        'capitalstake-fundamentals',
        'eodhd-fundamentals',
        'sbp-easydata-macro',
        'psx-announcements',
      ])
        expect(() => registry.require(key)).toThrowError(/unavailable/);
      expect(() => registry.require('no-such-provider')).toThrowError(/unknown research provider/);
      const entry = registry.list().find((e) => e.provider.key === 'capitalstake-fundamentals')!;
      await expect(
        (entry.provider as { getFinancials(s: string): Promise<unknown> }).getFinancials('RESA'),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      const psx = registry.list().find((e) => e.provider.key === 'psx-announcements')!;
      await expect(
        (psx.provider as { getAnnouncements(q: object): Promise<unknown> }).getAnnouncements({}),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      // the manual provider is the only enabled source and serves stored rows only
      const manual = registry.require('manual-fundamentals') as {
        getFinancials(s: string): Promise<{ source: string }[]>;
      };
      expect((await manual.getFinancials('RESA')).every((r) => r.source === 'USER_REPORTED')).toBe(true);
      expect(await manual.getFinancials('RESC')).toEqual([]);
    });

    it('an empty manual provider reports DEGRADED rather than pretending to be healthy', async () => {
      await prisma.macroObservation.deleteMany({});
      const res = await get('/research/providers').expect(200);
      const macro = res.body.data.find((p: { providerKey: string }) => p.providerKey === 'manual-macro');
      expect(macro).toMatchObject({ status: 'DEGRADED' });
      expect(macro.message).toMatch(/no macro observations entered yet/);
    });
  });

  // ─────────────────────────── recommendations ───────────────────────────

  describe('recommendations ledger and outcomes', () => {
    const bar = (symbol: string, date: string, o: string, h: string, l: string, c: string) =>
      prisma.stockPrice.create({
        data: {
          stockId: stockIds[symbol]!,
          interval: 'D1',
          ts: new Date(`${date}T04:30:00Z`), // 09:30 PKT session open
          open: o,
          high: h,
          low: l,
          close: c,
          volume: 1000n,
          providerKey: 'csv-eod',
          source: 'USER_REPORTED',
        },
      });
    const rec = (symbol: string, over: Record<string, unknown> = {}) =>
      store.record({
        userId: ownerId,
        symbol,
        horizon: 'SHORT_TERM',
        action: 'BUY',
        status: 'ACTIONABLE',
        generatedAt: new Date('2026-11-02T11:00:00Z'),
        asOfBar: '2026-11-02',
        price: '100',
        priceSource: 'USER_REPORTED',
        entryLow: '99',
        entryHigh: '101',
        stop: '95',
        target1: '105',
        target2: '110',
        target3: '115',
        riskReward: '1.0000',
        holdingPeriod: '2-6 weeks',
        holdingDaysMax: 30,
        confidence: '62.50',
        confidenceLevel: 'MEDIUM',
        components: { trend: 0.7 },
        reasons: ['Uptrend'],
        invalidations: ['Close below 95'],
        dataQuality: { bars: 250 },
        engineVersion: 'test-1',
        inputsSnapshot: { closes: [100] },
        ...over,
      } as never);
    const ids: Record<string, string> = {};
    const outcomesOf = (id: string) =>
      prisma.recommendationOutcome.findMany({
        where: { recommendationId: id },
        orderBy: { evaluatedAt: 'asc' },
      });
    const evaluate = async () => (await post('/recommendations/evaluate-outcomes', {}).expect(200)).body;

    beforeAll(async () => {
      // R1 RESB: target ladder to T3.  The as-of bar itself (low 50) and a later crash must NOT count.
      await bar('RESB', '2026-11-02', '100', '101', '50', '100');
      await bar('RESB', '2026-11-03', '100', '102', '99', '101');
      await bar('RESB', '2026-11-04', '101', '106', '100', '105');
      await bar('RESB', '2026-11-05', '105', '111', '104', '110');
      await bar('RESB', '2026-11-06', '110', '116', '109', '115');
      await bar('RESB', '2026-11-09', '115', '120', '60', '70');
      // R2 RESC: stop.   R3 RESD: stop and target in the same bar.
      await bar('RESC', '2026-11-03', '99', '101', '94', '95');
      await bar('RESD', '2026-11-03', '100', '106', '94', '100');
      // R4 RESE: as-of bar would have stopped out, later bars are calm -> stays OPEN.
      await bar('RESE', '2026-11-02', '100', '101', '90', '95');
      await bar('RESE', '2026-11-03', '100', '102', '99', '101');
      // R9 RESG: window of 10 days that has passed.
      await bar('RESG', '2026-10-02', '100', '102', '99', '101');
      await bar('RESG', '2026-10-20', '101', '130', '60', '70'); // beyond the window, ignored

      ids.r1 = (await rec('RESB')).recommendation.id;
      ids.r2 = (await rec('RESC', { horizon: 'MEDIUM_TERM' })).recommendation.id;
      ids.r3 = (await rec('RESD', { horizon: 'MEDIUM_TERM' })).recommendation.id;
      ids.r4 = (await rec('RESE')).recommendation.id;
      ids.r9 = (
        await rec('RESG', {
          horizon: 'MEDIUM_TERM',
          asOfBar: '2026-10-01',
          holdingDaysMax: 10,
          generatedAt: new Date('2026-10-01T11:00:00Z'),
        })
      ).recommendation.id;
      // Not actionable / other owners
      ids.hold = (
        await rec('RESA', {
          action: 'HOLD',
          status: 'NOT_ACTIONABLE',
          stop: undefined,
          target1: undefined,
          target2: undefined,
          target3: undefined,
        })
      ).recommendation.id;
      ids.viewerRec = (
        await rec('RESA', {
          userId: viewerId,
          action: 'WATCHLIST',
          status: 'NOT_ACTIONABLE',
          stop: undefined,
          target1: undefined,
          target2: undefined,
          target3: undefined,
        })
      ).recommendation.id;
      ids.system = (
        await rec('RESI', {
          userId: null,
          action: 'AVOID',
          status: 'NOT_ACTIONABLE',
          stop: undefined,
          target1: undefined,
          target2: undefined,
          target3: undefined,
        })
      ).recommendation.id;
    });

    it('record is idempotent per user+stock+horizon+asOfBar+engineVersion and never overwrites', async () => {
      const again = await rec('RESB', { price: '101', confidence: '10', reasons: ['changed'] });
      expect(again.created).toBe(false);
      expect(again.recommendation.id).toBe(ids.r1);
      expect(again.recommendation.price).toBe('100');
      expect(again.recommendation.reasons).toEqual(['Uptrend']);
      const newVersion = await rec('RESB', { engineVersion: 'test-2' });
      expect(newVersion.created).toBe(true);
      const newHorizon = await rec('RESB', { horizon: 'LONG_TERM' });
      expect(newHorizon.created).toBe(true);
      // system (userId null) rows are idempotent too, despite NULL in the key
      const sys = await rec('RESI', {
        userId: null,
        action: 'AVOID',
        status: 'NOT_ACTIONABLE',
        stop: undefined,
        target1: undefined,
        target2: undefined,
        target3: undefined,
      });
      expect(sys.created).toBe(false);
      expect(sys.recommendation.id).toBe(ids.system);
      expect(await prisma.recommendation.count({ where: { stockId: stockIds.RESB! } })).toBe(3);
      // the two extra rows would be evaluated below; keep the ledger tidy for hand-computed numbers
      ids.extra1 = newVersion.recommendation.id;
      ids.extra2 = newHorizon.recommendation.id;
    });

    it('refuses invalid levels (schema and DB CHECK) and unknown symbols', async () => {
      await expect(rec('RESB', { engineVersion: 'bad-1', price: '1e3' })).rejects.toThrow();
      await expect(rec('NOPE', { engineVersion: 'bad-2' })).rejects.toMatchObject({
        response: { code: 'UNKNOWN_SYMBOL' },
      });
      // ACTIONABLE BUY with the stop above the price violates the DB constraint
      await expect(rec('RESB', { engineVersion: 'bad-3', stop: '101' })).rejects.toThrow();
      await expect(rec('RESB', { engineVersion: 'bad-4', action: 'HOLD' })).rejects.toThrow(); // ACTIONABLE must be BUY/SELL
      await expect(rec('RESB', { engineVersion: 'bad-5', confidence: '101' })).rejects.toThrow();
    });

    it('is append-only at the database: UPDATE, DELETE and TRUNCATE are rejected for recommendations and outcomes', async () => {
      const append = /append-only/;
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "recommendations" SET "price" = 1 WHERE id = '${ids.r1}'::uuid`),
      ).rejects.toThrow(append);
      await expect(
        prisma.recommendation.update({ where: { id: ids.r1! }, data: { confidence: '1' } }),
      ).rejects.toThrow(append);
      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM "recommendations" WHERE id = '${ids.r1}'::uuid`),
      ).rejects.toThrow(append);
      await expect(prisma.recommendation.deleteMany({})).rejects.toThrow(append);
      await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "recommendations" CASCADE')).rejects.toThrow(
        append,
      );
      await expect(prisma.user.delete({ where: { id: viewerId } })).rejects.toThrow(); // FK RESTRICT: history keeps its owner
      expect(await prisma.recommendation.count()).toBeGreaterThanOrEqual(10);
    });

    it('evaluate-outcomes: hand-computed target, stop, same-bar-stop, open (no look-ahead) and expired cases', async () => {
      const res = await evaluate();
      expect(res).toMatchObject({ considered: 7, appended: 7, closed: 6, noNewData: 0 });

      const r1 = (await outcomesOf(ids.r1!))[0]!;
      expect(r1).toMatchObject({ status: 'TARGET_HIT', holdingDays: 4 });
      expect(r1.exitPrice!.toString()).toBe('115');
      expect(r1.returnPct!.toString()).toBe('15');
      expect(r1.maxFavourable.toString()).toBe('16'); // high 116
      expect(r1.maxAdverse.toString()).toBe('-1'); // low 99; the 11-02 bar (low 50) and 11-09 crash are ignored
      expect(
        [r1.target1HitAt, r1.target2HitAt, r1.target3HitAt].map((d) => d?.toISOString().slice(0, 10)),
      ).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
      expect(r1.closedAt!.toISOString().slice(0, 10)).toBe('2026-11-06');
      expect(r1.benchmarkReturnPct).toBeNull(); // no KSE-100 series stored

      const r2 = (await outcomesOf(ids.r2!))[0]!;
      expect(r2).toMatchObject({ status: 'STOPPED', holdingDays: 1 });
      expect(r2.returnPct!.toString()).toBe('-5');
      expect(r2.maxAdverse.toString()).toBe('-6');

      const r3 = (await outcomesOf(ids.r3!))[0]!;
      expect(r3.status).toBe('STOPPED'); // stop first when both touch in one bar
      expect(r3.target1HitAt).toBeNull();
      expect(r3.stopHitAt!.toISOString().slice(0, 10)).toBe('2026-11-03');
      expect(r3.returnPct!.toString()).toBe('-5');

      const r4 = (await outcomesOf(ids.r4!))[0]!;
      expect(r4).toMatchObject({ status: 'OPEN', stopHitAt: null, closedAt: null, exitPrice: null });
      expect(r4.returnPct!.toString()).toBe('1');

      const r9 = (await outcomesOf(ids.r9!))[0]!;
      expect(r9.status).toBe('EXPIRED');
      expect(r9.returnPct!.toString()).toBe('1');
      expect(r9.closedAt!.toISOString().slice(0, 10)).toBe('2026-10-02');

      expect(
        await prisma.recommendationOutcome.count({
          where: { recommendationId: { in: [ids.hold!, ids.viewerRec!, ids.system!] } },
        }),
      ).toBe(0);
    });

    it('re-evaluating is a no-op; a new bar appends a NEW row and never rewrites the old one', async () => {
      const before = await prisma.recommendationOutcome.findMany({ orderBy: { id: 'asc' } });
      const noop = await evaluate();
      expect(noop).toMatchObject({ considered: 1, appended: 0, closed: 0, noNewData: 1 }); // only R4 is still open
      expect(await prisma.recommendationOutcome.count()).toBe(before.length);

      await bar('RESE', '2026-11-04', '101', '103', '100', '102');
      const next = await evaluate();
      expect(next).toMatchObject({ considered: 1, appended: 1, closed: 0 });
      const rows = await outcomesOf(ids.r4!);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(before.find((r) => r.id === rows[0]!.id)); // first evaluation untouched
      expect(rows[1]!.lastBarDate.toISOString().slice(0, 10)).toBe('2026-11-04');
      expect(rows[1]!.returnPct!.toString()).toBe('2');
      await expect(
        prisma.recommendationOutcome.update({ where: { id: rows[0]!.id }, data: { returnPct: '9' } }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.recommendationOutcome.deleteMany({})).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "recommendation_outcomes"')).rejects.toThrow(
        /append-only/,
      );
    });

    it('GET /recommendations: filters, outcomes, owner isolation', async () => {
      const all = await get('/recommendations?limit=200').expect(200);
      const mine = all.body.data.map((r: { id: string }) => r.id);
      expect(mine).toContain(ids.r1);
      expect(mine).toContain(ids.system); // system rows are visible to everyone
      expect(mine).not.toContain(ids.viewerRec); // another user's row is not
      const v = await get('/recommendations?limit=200', viewer).expect(200);
      const theirs = v.body.data.map((r: { id: string }) => r.id);
      expect(theirs).toContain(ids.viewerRec);
      expect(theirs).toContain(ids.system);
      expect(theirs).not.toContain(ids.r1);

      const r1 = all.body.data.find((r: { id: string }) => r.id === ids.r1);
      expect(r1).toMatchObject({
        symbol: 'RESB',
        price: '100',
        stop: '95',
        confidence: '62.5',
        engineVersion: 'test-1',
        simulated: false,
      });
      expect(r1.latestOutcome).toMatchObject({
        status: 'TARGET_HIT',
        returnPct: '15',
        maxFavourablePct: '16',
      });

      expect(
        (await get('/recommendations?symbol=resb').expect(200)).body.data.every(
          (r: { symbol: string }) => r.symbol === 'RESB',
        ),
      ).toBe(true);
      expect(
        (await get('/recommendations?action=HOLD').expect(200)).body.data.map((r: { id: string }) => r.id),
      ).toEqual([ids.hold]);
      expect((await get('/recommendations?status=NOT_ACTIONABLE').expect(200)).body.total).toBe(2); // hold + system
      const medium = await get('/recommendations?horizon=MEDIUM_TERM&limit=200').expect(200);
      expect(medium.body.data.map((r: { id: string }) => r.id).sort()).toEqual(
        [ids.r2, ids.r3, ids.r9].sort(),
      );
      expect(
        (await get('/recommendations?from=2026-10-01&to=2026-10-01').expect(200)).body.data.map(
          (r: { id: string }) => r.id,
        ),
      ).toEqual([ids.r9]);
      expect((await get('/recommendations?from=2026-11-03').expect(200)).body.total).toBe(0);
      await get('/recommendations?action=SHOUT').expect(422);
    });

    it('GET /recommendations/:id: full outcome history; other users get 404; bad ids 400', async () => {
      const one = await get(`/recommendations/${ids.r4}`).expect(200);
      expect(one.body.outcomes).toHaveLength(2);
      expect(one.body.latestOutcome.lastBarDate).toBe('2026-11-04');
      expect(one.body).toMatchObject({
        reasons: ['Uptrend'],
        invalidations: ['Close below 95'],
        inputsSnapshot: { closes: [100] },
        components: { trend: 0.7 },
      });
      await get(`/recommendations/${ids.viewerRec}`).expect(404);
      await get(`/recommendations/${ids.r1}`, viewer).expect(404);
      await get(`/recommendations/${ids.system}`, viewer).expect(200);
      await get('/recommendations/not-a-uuid').expect(400);
    });

    it('performance: hand-computed aggregates, per-horizon breakdown, benchmark null with a note', async () => {
      const p = (await get('/recommendations/performance').expect(200)).body;
      // Closed: R1 +15 (4 d, T1), its twin e1 +15 (4 d, T1), LONG e2 +15 (4 d, T1), R2 -5 (1 d), R3 -5 (1 d), R9 +1 (1 d).
      // Open: R4 (+2). The HOLD / WATCHLIST / AVOID rows are not actionable and are not counted.
      expect(p).toMatchObject({
        recommendations: 7,
        evaluated: 7,
        open: 1,
        closed: 6,
        winRatePct: '66.67', // 4 of 6
        avgReturnPct: '6.0000', // 36 / 6
        targetHitRatePct: '42.86', // 3 of 7 evaluated reached T1
        stopFrequencyPct: '33.33', // 2 of 6
        avgHoldingDays: '2.50', // 15 / 6
        avgBenchmarkReturnPct: null,
        benchmark: null,
        scope: { onlyActionable: true, includesSimulated: false },
      });
      expect(p.benchmarkNote).toMatch(/KSE100_INDEX/);
      expect(p.perHorizon.SHORT_TERM).toMatchObject({
        recommendations: 3,
        closed: 2,
        open: 1,
        winRatePct: '100.00',
        avgReturnPct: '15.0000',
        targetHitRatePct: '66.67',
        stopFrequencyPct: '0.00',
        avgHoldingDays: '4.00',
      });
      expect(p.perHorizon.MEDIUM_TERM).toMatchObject({
        recommendations: 3,
        closed: 3,
        winRatePct: '33.33',
        avgReturnPct: '-3.0000',
        targetHitRatePct: '0.00',
        stopFrequencyPct: '66.67',
        avgHoldingDays: '1.00',
      });
      expect(p.perHorizon.LONG_TERM).toMatchObject({
        recommendations: 1,
        closed: 1,
        winRatePct: '100.00',
        avgReturnPct: '15.0000',
      });
      expect(p.note).toMatch(/not a prediction/);

      const sOnly = (await get('/recommendations/performance?horizon=MEDIUM_TERM').expect(200)).body;
      expect(sOnly).toMatchObject({ recommendations: 3, winRatePct: '33.33' });
      // the viewer owns nothing actionable
      expect((await get('/recommendations/performance', viewer).expect(200)).body).toMatchObject({
        recommendations: 0,
        winRatePct: null,
        avgReturnPct: null,
      });
      await get('/recommendations/performance?includeSimulated=maybe').expect(422);
    });

    it('benchmark appears once a KSE-100 series exists; SIMULATED-priced recommendations are excluded by default', async () => {
      await prisma.macroObservation.createMany({
        data: [
          {
            series: 'KSE100_INDEX',
            date: new Date('2026-11-02T00:00:00Z'),
            value: '100000',
            source: 'USER_REPORTED',
            sourceRef: 'PSX index close',
          },
          {
            series: 'KSE100_INDEX',
            date: new Date('2026-11-06T00:00:00Z'),
            value: '103000',
            source: 'USER_REPORTED',
            sourceRef: 'PSX index close',
          },
        ],
      });
      for (const s of ['RESF', 'RESH']) {
        await bar(s, '2026-11-03', '100', '102', '99', '101');
        await bar(s, '2026-11-06', '110', '116', '109', '115');
      }
      ids.r8 = (await rec('RESF')).recommendation.id; // T3 reached on 11-06 -> +15 %, KSE-100 +3 %
      ids.r7 = (await rec('RESH', { priceSource: 'SIMULATED' })).recommendation.id;
      expect(await evaluate()).toMatchObject({ considered: 3, appended: 2, closed: 2, noNewData: 1 });
      expect((await outcomesOf(ids.r8!))[0]!.benchmarkReturnPct!.toString()).toBe('3');
      expect((await outcomesOf(ids.r1!))[0]!.benchmarkReturnPct).toBeNull(); // history is never rewritten

      const p = (await get('/recommendations/performance').expect(200)).body;
      expect(p).toMatchObject({ recommendations: 8, closed: 7, winRatePct: '71.43', avgReturnPct: '7.2857' });
      expect(p.benchmark).toEqual({ series: 'KSE100_INDEX', avgReturnPct: '3.0000', samples: 1 });
      expect(p.benchmarkNote).toBeNull();
      const withSim = (await get('/recommendations/performance?includeSimulated=true').expect(200)).body;
      expect(withSim).toMatchObject({ recommendations: 9, closed: 8, scope: { includesSimulated: true } });
      const flagged = await get(`/recommendations/${ids.r7}`).expect(200);
      expect(flagged.body.simulated).toBe(true);
    });
  });
});
