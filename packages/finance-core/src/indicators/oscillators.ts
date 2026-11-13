import { type Decimal, fromInt, HUNDRED, pct, ZERO } from '../decimal.js';
import { assertPeriod, at, pick } from './internal.js';
import { EmaCore, emaSeries } from './moving-averages.js';
import { type IndicatorSeries, type OhlcvBar, type PriceSource, type StreamingIndicator } from './types.js';

// ───────────────────────────── RSI (Wilder) ─────────────────────────────

/**
 * RSI = 100 * avgGain / (avgGain + avgLoss)  (algebraically identical to 100 - 100/(1+RS)).
 * Seed: simple mean of the first `period` gains/losses (changes 1..period); thereafter Wilder smoothing
 *   avg_t = (avg_{t-1} * (period - 1) + x_t) / period.
 * A perfectly flat window (avgGain = avgLoss = 0) yields the neutral value 50.
 * Warm-up = period + 1 bars (period price changes are needed).
 */
function rsiFromAverages(avgGain: Decimal, avgLoss: Decimal): Decimal {
  const total = avgGain.plus(avgLoss);
  return total.isZero() ? fromInt(50) : HUNDRED.times(avgGain).div(total);
}

export function rsiSeries(values: readonly Decimal[], period = 14): IndicatorSeries {
  assertPeriod('RSI', period);
  const n = fromInt(period);
  const nMinus1 = fromInt(period - 1);
  const out: IndicatorSeries = values.length > 0 ? [null] : [];
  let gainSum = ZERO;
  let lossSum = ZERO;
  let avgGain: Decimal | null = null;
  let avgLoss: Decimal = ZERO;
  for (let i = 1; i < values.length; i++) {
    const change = at(values, i).minus(at(values, i - 1));
    const gain = change.gt(0) ? change : ZERO;
    const loss = change.lt(0) ? change.neg() : ZERO;
    if (avgGain === null) {
      gainSum = gainSum.plus(gain);
      lossSum = lossSum.plus(loss);
      if (i === period) {
        avgGain = gainSum.div(n);
        avgLoss = lossSum.div(n);
      }
    } else {
      avgGain = avgGain.times(nMinus1).plus(gain).div(n);
      avgLoss = avgLoss.times(nMinus1).plus(loss).div(n);
    }
    out.push(avgGain === null ? null : rsiFromAverages(avgGain, avgLoss));
  }
  return out;
}

export class RsiIndicator implements StreamingIndicator {
  readonly warmupBars: number;
  count = 0;
  value: Decimal | null = null;
  private prev: Decimal | null = null;
  private gainSum = ZERO;
  private lossSum = ZERO;
  private avgGain: Decimal | null = null;
  private avgLoss = ZERO;
  constructor(
    readonly period = 14,
    readonly source: PriceSource = 'close',
  ) {
    assertPeriod('RSI', period);
    this.warmupBars = period + 1;
  }
  update(bar: OhlcvBar): Decimal | null {
    return this.push(pick(bar, this.source));
  }
  push(x: Decimal): Decimal | null {
    this.count++;
    const prev = this.prev;
    this.prev = x;
    if (prev === null) return (this.value = null);
    const change = x.minus(prev);
    const gain = change.gt(0) ? change : ZERO;
    const loss = change.lt(0) ? change.neg() : ZERO;
    const n = fromInt(this.period);
    if (this.avgGain === null) {
      this.gainSum = this.gainSum.plus(gain);
      this.lossSum = this.lossSum.plus(loss);
      if (this.count - 1 === this.period) {
        this.avgGain = this.gainSum.div(n);
        this.avgLoss = this.lossSum.div(n);
      }
    } else {
      const nMinus1 = fromInt(this.period - 1);
      this.avgGain = this.avgGain.times(nMinus1).plus(gain).div(n);
      this.avgLoss = this.avgLoss.times(nMinus1).plus(loss).div(n);
    }
    this.value = this.avgGain === null ? null : rsiFromAverages(this.avgGain, this.avgLoss);
    return this.value;
  }
}

// ───────────────────────────── MACD ─────────────────────────────

export interface MacdValue {
  /** EMA(fast) - EMA(slow). */
  readonly macd: Decimal;
  /** EMA(signalPeriod) of the MACD line, seeded with the SMA of its first `signalPeriod` values. */
  readonly signal: Decimal;
  /** macd - signal. */
  readonly histogram: Decimal;
}

function assertMacd(fast: number, slow: number, signal: number): void {
  assertPeriod('MACD fast', fast);
  assertPeriod('MACD slow', slow);
  assertPeriod('MACD signal', signal);
  if (fast >= slow) throw new RangeError(`MACD: fast (${fast}) must be < slow (${slow})`);
}

/** MACD; output is null until the signal line exists. Warm-up = slow + signal - 1. */
export function macdSeries(values: readonly Decimal[], fast = 12, slow = 26, signal = 9): IndicatorSeries<MacdValue> {
  assertMacd(fast, slow, signal);
  const ef = emaSeries(values, fast);
  const es = emaSeries(values, slow);
  const line: Decimal[] = [];
  const lineIndex: number[] = [];
  values.forEach((_, i) => {
    const f = at(ef, i);
    const s = at(es, i);
    if (f !== null && s !== null) {
      line.push(f.minus(s));
      lineIndex.push(i);
    }
  });
  const sig = emaSeries(line, signal);
  const out: IndicatorSeries<MacdValue> = values.map(() => null);
  line.forEach((m, j) => {
    const s = at(sig, j);
    if (s !== null) out[at(lineIndex, j)] = { macd: m, signal: s, histogram: m.minus(s) };
  });
  return out;
}

export class MacdIndicator implements StreamingIndicator<MacdValue> {
  readonly warmupBars: number;
  count = 0;
  value: MacdValue | null = null;
  private readonly fastEma: EmaCore;
  private readonly slowEma: EmaCore;
  private readonly signalEma: EmaCore;
  constructor(
    readonly fast = 12,
    readonly slow = 26,
    readonly signal = 9,
    readonly source: PriceSource = 'close',
  ) {
    assertMacd(fast, slow, signal);
    this.fastEma = new EmaCore(fast);
    this.slowEma = new EmaCore(slow);
    this.signalEma = new EmaCore(signal);
    this.warmupBars = slow + signal - 1;
  }
  update(bar: OhlcvBar): MacdValue | null {
    return this.push(pick(bar, this.source));
  }
  push(x: Decimal): MacdValue | null {
    this.count++;
    const f = this.fastEma.push(x);
    const s = this.slowEma.push(x);
    if (f === null || s === null) return (this.value = null);
    const m = f.minus(s);
    const sig = this.signalEma.push(m);
    this.value = sig === null ? null : { macd: m, signal: sig, histogram: m.minus(sig) };
    return this.value;
  }
}

// ───────────────────────────── ROC ─────────────────────────────

/** Rate of change in percent: (x_t - x_{t-period}) / x_{t-period} * 100; null if x_{t-period} = 0. Warm-up = period + 1. */
export function rocSeries(values: readonly Decimal[], period: number): IndicatorSeries {
  assertPeriod('ROC', period);
  return values.map((x, i) => (i < period ? null : pct(x.minus(at(values, i - period)), at(values, i - period))));
}

export class RocIndicator implements StreamingIndicator {
  readonly warmupBars: number;
  count = 0;
  value: Decimal | null = null;
  private readonly window: Decimal[] = [];
  constructor(
    readonly period: number,
    readonly source: PriceSource = 'close',
  ) {
    assertPeriod('ROC', period);
    this.warmupBars = period + 1;
  }
  update(bar: OhlcvBar): Decimal | null {
    return this.push(pick(bar, this.source));
  }
  push(x: Decimal): Decimal | null {
    this.count++;
    this.window.push(x);
    if (this.window.length > this.period + 1) this.window.shift();
    if (this.window.length <= this.period) return (this.value = null);
    const base = at(this.window, 0);
    this.value = pct(x.minus(base), base);
    return this.value;
  }
}
