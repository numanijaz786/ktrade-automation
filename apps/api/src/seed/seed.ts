/**
 * Idempotent reference-data seed:  pnpm --filter @ktrade/api db:seed   (after `pnpm build`)
 *   - PSX stock list + SIMULATED daily history (never overwrites imported real prices)
 *   - KTrade's published fee schedule (Commission Structure PDF), effective-dated
 * Deliberately NOT seeded: tax rates (CGT / dividend WHT). Unverified numbers must not reach calculations;
 * the tax lookup fails loudly ("not configured") until the owner enters confirmed rates (ADR-023).
 * Never creates users or touches ledgers.
 */
import 'reflect-metadata';
import { PrismaPg } from '@prisma/adapter-pg';
import { ktradeDefaultSchedule } from '@ktrade/finance-core';
import { PrismaClient } from '../generated/prisma/client.js';
import { DEFAULT_SCHEDULE_EFFECTIVE_FROM } from '../ledger/fee-defaults.js';
import { seedMarketData } from './stocks.js';

export async function seedFeeSchedule(prisma: PrismaClient): Promise<{ items: number }> {
  const spec = ktradeDefaultSchedule(DEFAULT_SCHEDULE_EFFECTIVE_FROM);
  const effectiveFrom = new Date(`${spec.effectiveFrom}T00:00:00Z`);
  const items = spec.items.map((i) => ({
    component: i.component,
    appliesTo: i.appliesTo,
    method: i.method,
    rate: i.rate?.toFixed() ?? null,
    perShare: i.perShare?.toFixed() ?? null,
    fixedAmount: i.fixedAmount?.toFixed() ?? null,
    minAmount: i.minAmount?.toFixed() ?? null,
    baseComponent: i.baseComponent ?? null,
    capitalise: i.capitalise,
    sortOrder: i.sortOrder,
  }));
  await prisma.$transaction(async (tx) => {
    const schedule = await tx.feeSchedule.upsert({
      where: { brokerCode_effectiveFrom: { brokerCode: 'KTRADE', effectiveFrom } },
      create: {
        brokerCode: 'KTRADE',
        name: spec.name ?? 'KTrade published schedule',
        effectiveFrom,
        sourceNote: spec.sourceNote ?? 'KTrade Commission Structure PDF',
      },
      update: {
        name: spec.name ?? 'KTrade published schedule',
        sourceNote: spec.sourceNote ?? 'KTrade Commission Structure PDF',
      },
    });
    await tx.feeScheduleItem.deleteMany({ where: { scheduleId: schedule.id } });
    await tx.feeScheduleItem.createMany({ data: items.map((i) => ({ ...i, scheduleId: schedule.id })) });
  });
  return { items: items.length };
}

function parseYears(argv: readonly string[]): number | undefined {
  const i = argv.indexOf('--years');
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || !/^\d+$/.test(v)) throw new Error('--years expects a whole number (1–5)');
  return Number.parseInt(v, 10);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url))
    throw new Error('DATABASE_URL must be set to a postgres:// URL');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const fees = await seedFeeSchedule(prisma);
    const market = await seedMarketData(
      prisma,
      { now: () => new Date() },
      { years: parseYears(process.argv) },
    );
    process.stdout.write(
      `Seed complete: ${market.stocks} stocks, ${market.barsInserted} bars inserted / ${market.barsUpdated} updated ` +
        `(SIMULATED, ${market.from} → ${market.to}); fee schedule with ${fees.items} items. Tax rates NOT seeded (enter confirmed rates).\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Run only when executed directly (importable from tests).
if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}` ||
  process.argv[1]?.endsWith('seed.js')
) {
  main().catch((err: unknown) => {
    process.stderr.write(`Seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
