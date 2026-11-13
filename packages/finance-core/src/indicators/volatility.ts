import { d, type Decimal, type DecimalInput, fromInt, max, sum, ZERO } from '../decimal.js';
import { assertPeriod, at, pick } from './internal.js';
import { type IndicatorSeries, type OhlcvBar, type PriceSource, type StreamingIndicator } from './types.js';

// ───────────────────────────── True range / ATR (Wilder) ─────────────────────────────

/** TR_t = max(high - low, |high - prevClose|, |low - prevClose|). */
export function trueRange(bar: OhlcvBar, prevClose: Decimal): Decimal {
  return max(bar.high.minus(bar.low), max(bar.high.minus(prevClose).abs(), bar.low.minus(prevClose).abs()));
}

/**
 * Average True Range with Wilder smoothing.
 * The first bar has no previous close, so (as in TA-Lib) TR is only defined from bar 1 on:
 *   ATR_period = mean(TR_1..TR_period);  ATR_t = (ATR_{t-1} * (period - 1) + TR_t) / period.
 * Warm-up = period + 1.
 */
export function atrSeries(bars: readonly OhlcvBar[], period = 14): IndicatorSeries {
  assertPeriod('ATR', period);
  const n = fromInt(period);
  const nMinus1 = fromInt(period - 1);
  const out: IndicatorSeries = bars.length > 0 ? [null] : [];
  const trs: Decimal[] = [];
  let atr: Decimal | null = null;
  for (let i = 1; i < bars.length; i++) {
    const tr = trueRange(at(bars, i), at(bars, i - 1).close);
    trs.push(tr);
    if (atr === null) {
      if (i === period) atr = sum(trs).div(n);
    } else {
      atr = atr.times(nMinus1).plus(tr).div(n);
    }
    out.push(atr);
  }
  return out;
}

export class AtrIndicator implements StreamingIndicator {
  readonly warmupBars: number;
  count = 0;
  value: Decimal | null = null;
  private prevClose: Decimal | null = null;
  private trSum = ZERO;
  constructor(readonly period = 14) {
    assertPeriod('ATR', period);
    this.warmupBars = period + 1;
  }
  update(bar: OhlcvBar): Decimal | null {
    this.count++;
    const prevClose = this.prevClose;
    this.prevClose = bar.close;
    if (prevClose === null) return (this.value = null);
    const tr = trueRange(bar, prevClose);
    const n = fromInt(this.period);
    if (this.value === null) {
      this.trSum = this.trSum.plus(tr);
      if (this.count - 1 === this.period) this.value = this.trSum.div(n);
    } else {
      this.value = this.value.times(fromInt(this.period - 1)).plus(tr).div(n);
    }
    return this.value;
  }
}

// ───────────────────────────── Bollinger Bands ─────────────────────────────

export interface BollingerValue {
  readonly upper: Decimal;
  /** SMA(period). */
  readonly middle: Decimal;
  readonly lower: Decimal;
  /** Population standard deviation of the window (divisor = period, as in Bollinger's definition). */
  readonly stdDev: Decimal;
}

function bollingerOfWindow(window: readonly Decimal[], k: Decimal): BollingerValue {
  const n = fromInt(window.length);
  const middle = sum(window).div(n);
  // Two-pass variance (numerically exact-friendly): mean of squared deviations.
  const variance = sum(window.map((x) => x.minus(middle).pow(2))).div(n);
  const sd = variance.sqrt();
  return { middle, upper: middle.plus(sd.times(k)), lower: middle.minus(sd.times(k)), stdDev: sd };
}

/** Bollinger Bands: middle = SMA(period), upper/lower = middle +/- k * population stddev. Warm-up = period. */
export function bollingerSeries(
  values: readonly Decimal[],
  period = 20,
  stdDevMultiplier: DecimalInput = '2',
): IndicatorSeries<BollingerValue> {
  assertPeriod('Bollinger', period);
  const k = d(stdDevMultiplier);
  return values.map((_, i) => (i + 1 < period ? null : bollingerOfWindow(values.slice(i + 1 - period, i + 1), k)));
}

export class BollingerIndicator implements StreamingIndicator<BollingerValue> {
  readonly warmupBars: number;
  count = 0;
  value: BollingerValue | null = null;
  private readonly window: Decimal[] = [];
  private readonly k: Decimal;
  constructor(
    readonly period = 20,
    stdDevMultiplier: DecimalInput = '2',
    readonly source: PriceSource = 'close',
  ) {
    assertPeriod('Bollinger', period);
    this.k = d(stdDevMultiplier);
    if (this.k.isNeg()) throw new RangeError('Bollinger: stdDev multiplier must be >= 0');
    this.warmupBars = period;
  }
  update(bar: OhlcvBar): BollingerValue | null {
    return this.push(pick(bar, this.source));
  }
  push(x: Decimal): BollingerValue | null {
    this.count++;
    this.window.push(x);
    if (this.window.length > this.period) this.window.shift();
    this.value = this.window.length === this.period ? bollingerOfWindow(this.window, this.k) : null;
    return this.value;
  }
}
