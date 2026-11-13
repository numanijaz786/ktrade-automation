/**
 * Pure snapshot / performance maths (docs/06 §5). All decimal; delegates the definitions to finance-core.
 *
 * Conventions
 *  - A snapshot values the portfolio at the CLOSE of a PSX trading date; V_t already includes that day's
 *    external flow F_t = Δ netContributions (DEPOSIT/WITHDRAWAL only — dividends, fees, taxes, profit on idle
 *    funds and adjustments are P&L, not external flows). Flows are assumed to arrive at END of day.
 *  - dailyPnl_t = V_t − V_{t−1} − F_t ;  r_t = (V_t − F_t) / V_{t−1} − 1.
 *  - When V_{t−1} = 0 the return is undefined: `dailyReturn` is null here and stored as 0 in
 *    `portfolio_snapshots.dailyReturn` (NOT NULL column). Performance never reads the stored return: TWR is
 *    recomputed from (V_t, F_t) by finance-core, starting at the first snapshot with V > 0 (so the gain made on
 *    the very day of the first deposit is in daily/monthly P&L but not in TWR — no capital was at risk overnight).
 */
import {
  aggregateMonthlyPnl,
  d,
  type Decimal,
  dailyPerformance,
  maxDrawdown,
  ONE,
  twrIndex,
  ZERO,
} from '@ktrade/finance-core';
import { addDays } from '../market-data/calendar.js';

export interface DayValuation {
  date: string;
  totalValue: Decimal;
  netContributions: Decimal;
}

export interface DailyFields {
  netFlow: Decimal;
  dailyPnl: Decimal;
  /** null when V_{t−1} = 0. */
  dailyReturn: Decimal | null;
}

/** Daily P&L and return of `cur` against the previous close (`prev` null = nothing before → V_{t−1} = 0). */
export function dailyFields(prev: DayValuation | null, cur: DayValuation): DailyFields {
  const netFlow = cur.netContributions.minus(prev?.netContributions ?? ZERO);
  const [day] = dailyPerformance([
    { date: prev?.date ?? addDays(cur.date, -1), value: prev?.totalValue ?? ZERO },
    { date: cur.date, value: cur.totalValue, netFlow },
  ]);
  return { netFlow, dailyPnl: day!.pnl, dailyReturn: day!.dailyReturn };
}

export const PERFORMANCE_RANGES = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'] as const;
export type PerformanceRange = (typeof PERFORMANCE_RANGES)[number];

function shiftMonths(date: string, months: number): string {
  const [y, m, day] = date.split('-').map((p) => Number.parseInt(p, 10)) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(day < lastDay ? day : lastDay);
  return target.toISOString().slice(0, 10);
}

/**
 * The range's base date (exclusive start): points dated AFTER it are in range; the latest point ON/BEFORE it is
 * the base the first in-range return is measured from. null for ALL.
 */
export function rangeBaseDate(range: PerformanceRange, end: string): string | null {
  switch (range) {
    case '1M':
      return shiftMonths(end, -1);
    case '3M':
      return shiftMonths(end, -3);
    case '6M':
      return shiftMonths(end, -6);
    case '1Y':
      return shiftMonths(end, -12);
    case 'YTD':
      return `${Number.parseInt(end.slice(0, 4), 10) - 1}-12-31`;
    case 'ALL':
      return null;
  }
}

export interface SnapshotPoint {
  date: string;
  totalValue: Decimal;
  netContributions: Decimal;
  dailyPnl: Decimal;
}

export interface PerformanceResult {
  series: { date: string; totalValue: Decimal; dailyPnl: Decimal; twrIndex: Decimal | null }[];
  /** Fraction (0.05 = 5%); null when undefined (no capital, < 2 linked points, or a gain on zero capital). */
  twr: Decimal | null;
  /** Positive fraction over the TWR index (flow-neutral); null when undefined. */
  maxDrawdown: {
    value: Decimal;
    peakDate: string | null;
    troughDate: string | null;
    recoveryDate: string | null;
  } | null;
  monthly: { month: string; pnl: Decimal; days: number }[];
  /** First date the TWR chain starts from (its index = 1), or null. */
  twrBaseDate: string | null;
}

/**
 * Range performance from ordered snapshots. `base` is the last snapshot on/before the range start (or null),
 * `inRange` the snapshots after it, ascending.
 */
export function performanceFromSnapshots(
  base: SnapshotPoint | null,
  inRange: readonly SnapshotPoint[],
): PerformanceResult {
  const chainAll = base ? [base, ...inRange] : [...inRange];
  // Start linking at the first point with capital (V > 0); flows are Δ netContributions between points.
  const start = chainAll.findIndex((p) => p.totalValue.gt(0));
  const chain = start === -1 ? [] : chainAll.slice(start);
  const points = chain.map((p, i) => ({
    date: p.date,
    value: p.totalValue,
    netFlow: i === 0 ? ZERO : p.netContributions.minus((chain[i - 1] as SnapshotPoint).netContributions),
  }));
  const index =
    points.length >= 2
      ? twrIndex(points)
      : points.length === 1
        ? [{ date: points[0]!.date, index: ONE }]
        : null;
  const byDate = new Map((index ?? []).map((x) => [x.date, x.index]));
  const twr = index && index.length >= 2 ? index[index.length - 1]!.index.minus(ONE) : null;
  const dd =
    index && index.length >= 2 ? maxDrawdown(index.map((x) => ({ date: x.date, value: x.index }))) : null;
  return {
    series: inRange.map((p) => ({
      date: p.date,
      totalValue: p.totalValue,
      dailyPnl: p.dailyPnl,
      twrIndex: byDate.get(p.date) ?? null,
    })),
    twr,
    maxDrawdown: dd
      ? {
          value: dd.maxDrawdown,
          peakDate: dd.peakDate,
          troughDate: dd.troughDate,
          recoveryDate: dd.recoveryDate,
        }
      : null,
    monthly: aggregateMonthlyPnl(inRange.map((p) => ({ date: p.date, pnl: p.dailyPnl }))),
    twrBaseDate: index ? (chain[0]?.date ?? null) : null,
  };
}

/** Percent string (4 dp) of a fraction, or null. */
export const fractionToPct = (x: Decimal | null): string | null =>
  x === null ? null : x.times(100).toDecimalPlaces(4).toFixed(4);

export const toDec = (v: { toString(): string } | null | undefined): Decimal =>
  v === null || v === undefined ? ZERO : d(v.toString());
