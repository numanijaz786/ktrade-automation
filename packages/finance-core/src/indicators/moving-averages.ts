import { type Decimal, fromInt, sum, ZERO } from '../decimal.js';
import { assertPeriod, at, pick } from './internal.js';
import { type IndicatorSeries, type OhlcvBar, type PriceSource, type StreamingIndicator } from './types.js';

// ───────────────────────────── SMA ─────────────────────────────

/** Simple moving average: mean of the last `period` values. Warm-up = period. */
export function smaSeries(values: readonly Decimal[], period: number): IndicatorSeries {
  assertPeriod('SMA', period);
  const n = fromInt(period);
  return values.map((_, i) => (i + 1 < period ? null : sum(values.slice(i + 1 - period, i + 1)).div(n)));
}

/** Rolling-window SMA. The window is summed afresh on every update (exact, no running-sum drift). */
export class SmaIndicator implements StreamingIndicator {
  readonly warmupBars: number;
  count = 0;
  value: Decimal | null = null;
  private readonly window: Decimal[] = [];
  constructor(
    readonly period: number,
    readonly source: PriceSource = 'close',
  ) {
    assertPeriod('SMA', period);
    this.warmupBars = period;
  }
  update(bar: OhlcvBar): Decimal | null {
    return this.push(pick(bar, this.source));
  }
  push(x: Decimal): Decimal | null {
    this.count++;
    this.window.push(x);
    if (this.window.length > this.period) this.window.shift();
    this.value = this.window.length === this.period ? sum(this.window).div(fromInt(this.period)) : null;
    return this.value;
  }
}

// ───────────────────────────── EMA ─────────────────────────────

/** Smoothing factor alpha = 2 / (period + 1). */
export const emaAlpha = (period: number): Decimal => fromInt(2).div(fromInt(period + 1));

/**
 * Exponential moving average, seeded with the SMA of the first `period` values (standard convention),
 * then EMA_t = EMA_{t-1} + alpha * (x_t - EMA_{t-1}). Warm-up = period.
 */
export function emaSeries(values: readonly Decimal[], period: number): IndicatorSeries {
  assertPeriod('EMA', period);
  const k = emaAlpha(period);
  const out: IndicatorSeries = [];
  let prev: Decimal | null = null;
  let seedSum = ZERO;
  for (let i = 0; i < values.length; i++) {
    const x = at(values, i);
    if (prev === null) {
      seedSum = seedSum.plus(x);
      if (i + 1 === period) prev = seedSum.div(fromInt(period));
    } else {
      prev = prev.plus(x.minus(prev).times(k));
    }
    out.push(prev);
  }
  return out;
}

/** Scalar streaming EMA (used by MACD and by the bar-based EMA). */
export class EmaCore {
  readonly warmupBars: number;
  count = 0;
  value: Decimal | null = null;
  private readonly k: Decimal;
  private seedSum = ZERO;
  constructor(readonly period: number) {
    assertPeriod('EMA', period);
    this.warmupBars = period;
    this.k = emaAlpha(period);
  }
  push(x: Decimal): Decimal | null {
    this.count++;
    if (this.value === null) {
      this.seedSum = this.seedSum.plus(x);
      if (this.count === this.period) this.value = this.seedSum.div(fromInt(this.period));
    } else {
      this.value = this.value.plus(x.minus(this.value).times(this.k));
    }
    return this.value;
  }
}

export class EmaIndicator implements StreamingIndicator {
  readonly warmupBars: number;
  private readonly core: EmaCore;
  constructor(
    readonly period: number,
    readonly source: PriceSource = 'close',
  ) {
    this.core = new EmaCore(period);
    this.warmupBars = period;
  }
  get count(): number {
    return this.core.count;
  }
  get value(): Decimal | null {
    return this.core.value;
  }
  update(bar: OhlcvBar): Decimal | null {
    return this.core.push(pick(bar, this.source));
  }
  push(x: Decimal): Decimal | null {
    return this.core.push(x);
  }
}

// ───────────────────────────── WMA ─────────────────────────────

/** Linearly weighted MA: sum(w_i * x_i) / sum(w_i), weight 1 (oldest) .. period (newest). Warm-up = period. */
export function wmaSeries(values: readonly Decimal[], period: number): IndicatorSeries {
  assertPeriod('WMA', period);
  const denom = fromInt((period * (period + 1)) / 2);
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    let acc = ZERO;
    for (let j = 0; j < period; j++) acc = acc.plus(at(values, i + 1 - period + j).times(fromInt(j + 1)));
    return acc.div(denom);
  });
}

export class WmaIndicator implements StreamingIndicator {
  readonly warmupBars: number;
  count = 0;
  value: Decimal | null = null;
  private readonly window: Decimal[] = [];
  private readonly denom: Decimal;
  constructor(
    readonly period: number,
    readonly source: PriceSource = 'close',
  ) {
    assertPeriod('WMA', period);
    this.warmupBars = period;
    this.denom = fromInt((period * (period + 1)) / 2);
  }
  update(bar: OhlcvBar): Decimal | null {
    return this.push(pick(bar, this.source));
  }
  push(x: Decimal): Decimal | null {
    this.count++;
    this.window.push(x);
    if (this.window.length > this.period) this.window.shift();
    if (this.window.length < this.period) return (this.value = null);
    this.value = sum(this.window.map((v, j) => v.times(fromInt(j + 1)))).div(this.denom);
    return this.value;
  }
}

// ───────────────────────────── Volume SMA ─────────────────────────────

/** SMA of bar volume. Warm-up = period. */
export function volumeSmaSeries(bars: readonly OhlcvBar[], period: number): IndicatorSeries {
  return smaSeries(
    bars.map((b) => b.volume),
    period,
  );
}

export class VolumeSmaIndicator extends SmaIndicator {
  constructor(period: number) {
    super(period, 'volume');
  }
}
