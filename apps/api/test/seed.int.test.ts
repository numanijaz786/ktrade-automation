import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeTradeFees, d, ktradeDefaultSchedule } from '@ktrade/finance-core';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { DEFAULT_SCHEDULE_EFFECTIVE_FROM } from '../src/ledger/fee-defaults.js';
import { seedFeeSchedule } from '../src/seed/seed.js';
import { PSX_SEED_STOCKS, seedMarketData } from '../src/seed/stocks.js';

/** Reference-data seed on real PostgreSQL. Opt-in: RUN_INTEGRATION=1. */
describe('seed (integration, real PostgreSQL)', () => {
  let pg: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  const clock = { now: () => new Date('2026-11-16T12:00:00Z') };

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    execSync('pnpm exec prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: pg.getConnectionUri() },
      stdio: 'pipe',
    });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.getConnectionUri() }) });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('seeds stocks + SIMULATED bars idempotently (DB CHECK constraints validate every OHLC bar)', async () => {
    const first = await seedMarketData(prisma, clock, { years: 1 });
    expect(first.stocks).toBe(PSX_SEED_STOCKS.length);
    expect(first.barsInserted).toBeGreaterThan(PSX_SEED_STOCKS.length * 200); // ~245 sessions/yr
    const second = await seedMarketData(prisma, clock, { years: 1 });
    expect(second).toMatchObject({ barsInserted: 0, barsUpdated: 0 });
    expect(await prisma.stockPrice.count({ where: { source: { not: 'SIMULATED' } } })).toBe(0);
    expect(
      (await prisma.systemSetting.findUnique({ where: { key: 'marketData.activeProvider' } }))?.value,
    ).toBe('simulated');
  });

  it('never overwrites real (non-simulated) price rows', async () => {
    const ogdc = await prisma.stock.findUniqueOrThrow({ where: { symbol: 'OGDC' } });
    const bar = await prisma.stockPrice.findFirstOrThrow({
      where: { stockId: ogdc.id, interval: 'D1' },
      orderBy: { ts: 'desc' },
    });
    await prisma.stockPrice.update({
      where: { id: bar.id },
      data: {
        providerKey: 'csv-eod',
        source: 'USER_REPORTED',
        close: '123.45',
        high: '999',
        low: '1',
        open: '123.45',
      },
    });
    await seedMarketData(prisma, clock, { years: 1 });
    const after = await prisma.stockPrice.findUniqueOrThrow({ where: { id: bar.id } });
    expect([after.source, after.close.toFixed(2)]).toEqual(['USER_REPORTED', '123.45']);
  });

  it('seeds the KTrade fee schedule so the DB schedule computes exactly the same fees as the built-in default', async () => {
    await seedFeeSchedule(prisma);
    await seedFeeSchedule(prisma); // idempotent
    expect(await prisma.feeSchedule.count()).toBe(1);
    const row = await prisma.feeSchedule.findFirstOrThrow({ include: { items: true } });
    const fromDb = {
      effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
      items: row.items.map((i) => ({
        component: i.component,
        appliesTo: i.appliesTo,
        method: i.method,
        rate: i.rate ? d(i.rate.toString()) : null,
        perShare: i.perShare ? d(i.perShare.toString()) : null,
        fixedAmount: i.fixedAmount ? d(i.fixedAmount.toString()) : null,
        minAmount: i.minAmount ? d(i.minAmount.toString()) : null,
        baseComponent: i.baseComponent,
        capitalise: i.capitalise,
        sortOrder: i.sortOrder,
      })),
    };
    const builtIn = ktradeDefaultSchedule(DEFAULT_SCHEDULE_EFFECTIVE_FROM);
    for (const trade of [
      { side: 'BUY' as const, quantity: d('100'), price: d('250') }, // pct branch
      { side: 'SELL' as const, quantity: d('10000'), price: d('1.50') }, // per-share branch (0.06 > 0.3% × 1.50)
      { side: 'BUY' as const, quantity: d('1'), price: d('0.01') },
    ]) {
      const a = computeTradeFees(fromDb, trade);
      const b = computeTradeFees(builtIn, trade);
      expect(a.lines.map((l) => [l.component, l.amount.toFixed()])).toEqual(
        b.lines.map((l) => [l.component, l.amount.toFixed()]),
      );
      expect(a.total.toFixed()).toBe(b.total.toFixed());
    }
  });

  it('does not seed tax rates (unverified numbers must never reach calculations)', async () => {
    expect(await prisma.taxRate.count()).toBe(0);
  });
});
