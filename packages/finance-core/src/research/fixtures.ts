/**
 * SYNTHETIC TEST FIXTURES. Every number here is invented by a deterministic formula for unit tests; none of it
 * is, or resembles, real market data. Not exported from the package index.
 */
import { d, type Decimal } from '../decimal.js';
import { ktradeDefaultSchedule } from '../fees/engine.js';
import { type FinancialStatement } from './fundamentals.js';
import { type EvaluateStockInput } from './rec-types.js';
import { type ResearchBar, type ResearchDataSource } from './types.js';

export const DAY_MS = 86_400_000;
export const BASE_MS = Date.UTC(2025, 0, 1);
export const isoDay = (i: number): string => new Date(BASE_MS + i * DAY_MS).toISOString();

export const bar = (
  i: number,
  o: string,
  h: string,
  l: string,
  c: string,
  v: string,
  source: ResearchDataSource = 'PROVIDER',
): ResearchBar => ({ ts: isoDay(i), open: d(o), high: d(h), low: d(l), close: d(c), volume: d(v), source });

/** Repeating wave (period 8) added to a linear drift. Deterministic, hand-checkable. */
const WAVE = [0, 1, 2, 1, 0, -1, -2, -1] as const;

/**
 * Synthetic drifting series: close_i = start + slope*i + wave[i mod 8]; open = previous close; high/low are
 * 0.5 outside the body; volume cycles between 1.00x and 1.20x of `volume` (default 1,000,000 shares).
 */
export function driftBars(
  n: number,
  opts: { start?: string; slope?: string; source?: ResearchDataSource; volume?: number } = {},
): ResearchBar[] {
  const start = d(opts.start ?? '100');
  const slope = d(opts.slope ?? '0.3');
  const out: ResearchBar[] = [];
  let prev = start;
  for (let i = 0; i < n; i++) {
    const c = start.plus(slope.times(i)).plus(WAVE[i % 8] as number);
    const o = i === 0 ? c : prev;
    const hi = (o.gt(c) ? o : c).plus('0.5');
    const lo = (o.lt(c) ? o : c).minus('0.5');
    const vol = d(String(opts.volume ?? 1_000_000))
      .times(20 + (i % 5))
      .div(20);
    out.push({
      ts: isoDay(i),
      open: o,
      high: hi,
      low: lo,
      close: c,
      volume: vol,
      source: opts.source ?? 'PROVIDER',
    });
    prev = c;
  }
  return out;
}

export const asOfAfter = (bars: readonly ResearchBar[], hours = 6): string =>
  new Date(Date.parse((bars[bars.length - 1] as ResearchBar).ts) + hours * 3_600_000).toISOString();

export function statement(over: Partial<FinancialStatement> = {}): FinancialStatement {
  return {
    period: 'FY2024',
    periodType: 'ANNUAL',
    periodEnd: '2024-12-31',
    publishedAt: '2025-02-15T00:00:00.000Z',
    currency: 'PKR',
    source: 'USER_REPORTED',
    document: 'SYNTHETIC TEST FIXTURE',
    revenue: d('1000'),
    grossProfit: d('400'),
    operatingIncome: d('200'),
    netIncome: d('120'),
    eps: d('12'),
    totalAssets: d('2000'),
    totalEquity: d('800'),
    totalDebt: d('400'),
    operatingCashFlow: d('180'),
    capitalExpenditure: d('60'),
    dividendsPerShare: d('6'),
    sharesOutstanding: d('10'),
    ...over,
  };
}

export const prior = (over: Partial<FinancialStatement> = {}): FinancialStatement =>
  statement({
    period: 'FY2023',
    periodEnd: '2023-12-31',
    publishedAt: '2024-02-15T00:00:00.000Z',
    revenue: d('800'),
    eps: d('10'),
    ...over,
  });

export function stockInput(over: Partial<EvaluateStockInput> = {}): EvaluateStockInput {
  const bars = over.bars ?? driftBars(250);
  const last = bars[bars.length - 1];
  const asOf = over.asOf ?? asOfAfter(bars);
  return {
    symbol: 'SYNTH',
    sector: 'SYNTHETIC SECTOR',
    horizon: 'SWING',
    asOf,
    bars,
    marketData: { priceAsOf: last?.ts ?? asOf, freshnessLimitMinutes: 60 * 24, delayMinutes: 0 },
    currency: 'PKR',
    portfolio: { equity: d('1000000'), cash: d('1000000'), holdingQty: d('0'), sectorExposurePct: d('0') },
    risk: {
      riskPerTradePct: d('1'),
      maxPositionPct: d('20'),
      maxSectorPct: d('40'),
      feeSchedule: ktradeDefaultSchedule('2024-01-01'),
    },
    ...over,
  };
}

export const D = (s: string): Decimal => d(s);
