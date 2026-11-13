import type { BarDto } from '@ktrade/broker-sdk';
import type { DataSource, PriceInterval } from '@ktrade/shared';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

/** Rows per INSERT statement (11 bind parameters each, far below PostgreSQL's 65 535 limit). */
const CHUNK = 1000;

export interface BarRow {
  interval: PriceInterval;
  ts: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  isAdjusted: boolean;
}

export interface UpsertBarsOptions {
  providerKey: string;
  source: DataSource;
  /**
   * The unique key is (stock, interval, isAdjusted, ts) — one row per bar regardless of provider — so
   * an existing row is only replaced when it belongs to one of these provider keys. Rows owned by other
   * providers are left untouched (e.g. the SIMULATED seed never overwrites a user's imported prices).
   */
  overwritableProviderKeys: readonly string[];
}

export interface UpsertBarsResult {
  inserted: number;
  updated: number;
  /** Identical to what is stored, or owned by a provider not in `overwritableProviderKeys`. */
  unchanged: number;
}

type Db = Pick<PrismaClient, '$queryRaw'>;

export const barDtoToRow = (b: BarDto): BarRow => ({
  interval: b.interval,
  ts: new Date(b.ts),
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  volume: b.volume,
  isAdjusted: b.isAdjusted,
});

/**
 * Idempotent bulk upsert into `stock_prices` with `INSERT … ON CONFLICT DO UPDATE`. Values are bound as
 * decimal strings and cast to NUMERIC/BIGINT in SQL, so no float ever touches a price. Re-running with
 * identical data changes nothing (the IS DISTINCT FROM guard skips no-op updates).
 */
export async function upsertBars(
  db: Db,
  stockId: string,
  bars: readonly (BarRow | BarDto)[],
  options: UpsertBarsOptions,
): Promise<UpsertBarsResult> {
  const result: UpsertBarsResult = { inserted: 0, updated: 0, unchanged: 0 };
  if (options.overwritableProviderKeys.length === 0) throw new Error('overwritableProviderKeys must not be empty');
  for (let i = 0; i < bars.length; i += CHUNK) {
    const chunk = bars.slice(i, i + CHUNK).map((b) => ('symbol' in b ? barDtoToRow(b) : b));
    const values = chunk.map(
      (b) => Prisma.sql`(${stockId}::uuid, ${b.interval}::"PriceInterval", ${b.ts}::timestamptz,
        ${b.open}::numeric, ${b.high}::numeric, ${b.low}::numeric, ${b.close}::numeric, ${b.volume}::bigint,
        ${b.isAdjusted}, ${options.providerKey}, ${options.source}::"DataSource")`,
    );
    const rows = await db.$queryRaw<{ inserted: boolean }[]>`
      INSERT INTO "stock_prices"
        ("stockId", "interval", "ts", "open", "high", "low", "close", "volume", "isAdjusted", "providerKey", "source")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("stockId", "interval", "isAdjusted", "ts") DO UPDATE SET
        "open" = EXCLUDED."open", "high" = EXCLUDED."high", "low" = EXCLUDED."low", "close" = EXCLUDED."close",
        "volume" = EXCLUDED."volume", "providerKey" = EXCLUDED."providerKey", "source" = EXCLUDED."source"
      WHERE "stock_prices"."providerKey" IN (${Prisma.join([...options.overwritableProviderKeys])})
        AND ("stock_prices"."open", "stock_prices"."high", "stock_prices"."low", "stock_prices"."close",
             "stock_prices"."volume", "stock_prices"."providerKey", "stock_prices"."source")
            IS DISTINCT FROM
            (EXCLUDED."open", EXCLUDED."high", EXCLUDED."low", EXCLUDED."close",
             EXCLUDED."volume", EXCLUDED."providerKey", EXCLUDED."source")
      RETURNING (xmax = 0) AS inserted`;
    for (const r of rows) {
      if (r.inserted) result.inserted++;
      else result.updated++;
    }
    result.unchanged += chunk.length - rows.length;
  }
  return result;
}
