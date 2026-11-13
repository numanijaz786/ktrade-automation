/**
 * Performance over a daily valuation series (docs/06 §5).
 *
 * Each point is an end-of-day account value V_t that ALREADY includes that day's external flow F_t
 * (deposits − withdrawals), i.e. flows are assumed to arrive at end of day:
 *   dailyPnl_t = V_t − V_{t−1} − F_t
 *   r_t        = (V_t − F_t) / V_{t−1} − 1
 *   TWR        = Π(1 + r_t) − 1
 */
import { type Decimal, type DecimalInput, d, ONE, sum, ZERO } from '../decimal.js';
import { assertIsoDate, isoMonth } from '../fees/isoDate.js';

export interface ValuationPoint {
  date: string;
  /** End-of-day account value (cash + market value), after the day's external flows. */
  value: DecimalInput;
  /** Net external flow on the day (deposits − withdrawals). Default 0. */
  netFlow?: DecimalInput;
}

export interface DailyPerformance {
  date: string;
  value: Decimal;
  netFlow: Decimal;
  pnl: Decimal;
  /** null when V_{t−1} = 0 (no capital at risk). */
  dailyReturn: Decimal | null;
}

function normalise(points: readonly ValuationPoint[]): { date: string; value: Decimal; netFlow: Decimal }[] {
  const out = points.map((p) => ({
    date: assertIsoDate(p.date),
    value: d(p.value),
    netFlow: d(p.netFlow ?? ZERO),
  }));
  for (let i = 1; i < out.length; i++) {
    if (!((out[i - 1] as { date: string }).date < (out[i] as { date: string }).date)) {
      throw new RangeError('Valuation points must have strictly ascending dates');
    }
  }
  return out;
}

/** Daily P&L and return for every point after the first (the first point is the base). */
export function dailyPerformance(points: readonly ValuationPoint[]): DailyPerformance[] {
  const pts = normalise(points);
  const out: DailyPerformance[] = [];
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1] as (typeof pts)[number];
    const cur = pts[i] as (typeof pts)[number];
    const pnl = cur.value.minus(prev.value).minus(cur.netFlow);
    const dailyReturn = prev.value.isZero() ? null : cur.value.minus(cur.netFlow).div(prev.value).minus(ONE);
    out.push({ date: cur.date, value: cur.value, netFlow: cur.netFlow, pnl, dailyReturn });
  }
  return out;
}

/**
 * Cumulative TWR index (base point = 1). A day with V_{t−1} = 0 and V_t − F_t = 0 (nothing invested yet)
 * contributes factor 1; a day with V_{t−1} = 0 but a non-zero result has no defined return, so the
 * whole index is undefined → null. Returns null for fewer than 2 points.
 */
export function twrIndex(points: readonly ValuationPoint[]): { date: string; index: Decimal }[] | null {
  if (points.length < 2) return null;
  const days = dailyPerformance(points);
  const first = points[0] as ValuationPoint;
  const out = [{ date: first.date, index: ONE }];
  let idx = ONE;
  for (const day of days) {
    if (day.dailyReturn === null) {
      if (!day.value.minus(day.netFlow).isZero()) return null;
    } else {
      idx = idx.times(ONE.plus(day.dailyReturn));
    }
    out.push({ date: day.date, index: idx });
  }
  return out;
}

/** Time-weighted return Π(1 + r_t) − 1 (fraction); null when undefined. */
export function timeWeightedReturn(points: readonly ValuationPoint[]): Decimal | null {
  const series = twrIndex(points);
  const last = series?.[series.length - 1];
  return last ? last.index.minus(ONE) : null;
}

export interface MaxDrawdownResult {
  /** Largest peak-to-trough decline as a positive fraction (0.25 = −25%). 0 when the series never falls. */
  maxDrawdown: Decimal;
  peakDate: string | null;
  troughDate: string | null;
  /** First date the series regains the peak after the trough; null if not (yet) recovered. */
  recoveryDate: string | null;
}

/**
 * Maximum drawdown of an equity series. Pass a flow-neutral series (e.g. twrIndex) — raw account value
 * mistakes withdrawals for losses. Points with a non-positive running peak are skipped; null if the
 * series is empty or never has a positive peak.
 */
export function maxDrawdown(
  series: readonly { date: string; value: DecimalInput }[],
): MaxDrawdownResult | null {
  let peak: Decimal | null = null;
  let peakDate: string | null = null;
  let best: MaxDrawdownResult | null = null;
  let bestPeak: Decimal | null = null;
  for (const p of series) {
    assertIsoDate(p.date);
    const v = d(p.value);
    if (peak === null || v.gt(peak)) {
      peak = v;
      peakDate = p.date;
    }
    if (best && bestPeak && best.recoveryDate === null && best.troughDate !== null && v.gte(bestPeak)) {
      best.recoveryDate = p.date;
    }
    if (!peak.gt(0)) continue;
    if (!best) best = { maxDrawdown: ZERO, peakDate: null, troughDate: null, recoveryDate: null };
    const dd = peak.minus(v).div(peak);
    if (dd.gt(best.maxDrawdown)) {
      best = { maxDrawdown: dd, peakDate, troughDate: p.date, recoveryDate: null };
      bestPeak = peak;
    }
  }
  return best;
}

export interface MonthlyPnl {
  /** 'YYYY-MM'. */
  month: string;
  pnl: Decimal;
  days: number;
}

/** Monthly P&L = Σ daily P&L within each calendar month, ascending by month. */
export function aggregateMonthlyPnl(daily: readonly { date: string; pnl: DecimalInput }[]): MonthlyPnl[] {
  const byMonth = new Map<string, Decimal[]>();
  for (const day of daily) {
    const m = isoMonth(day.date);
    const list = byMonth.get(m) ?? [];
    list.push(d(day.pnl));
    byMonth.set(m, list);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, values]) => ({ month, pnl: sum(values), days: values.length }));
}
