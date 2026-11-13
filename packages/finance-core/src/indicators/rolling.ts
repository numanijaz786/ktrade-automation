import { type Decimal, max, min } from '../decimal.js';
import { assertPeriod, at, pick } from './internal.js';
import { type IndicatorSeries, type OhlcvBar, type PriceSource, type StreamingIndicator } from './types.js';

function extreme(window: readonly Decimal[], pickFn: (a: Decimal, b: Decimal) => Decimal): Decimal {
  let acc = at(window, 0);
  for (const v of window) acc = pickFn(acc, v);
  return acc;
}

/** Rolling highest value over the last `period` values INCLUDING the current one. Warm-up = period. */
export function highestSeries(values: readonly Decimal[], period: number): IndicatorSeries {
  assertPeriod('HIGHEST', period);
  return values.map((_, i) => (i + 1 < period ? null : extreme(values.slice(i + 1 - period, i + 1), max)));
}

/** Rolling lowest value over the last `period` values INCLUDING the current one. Warm-up = period. */
export function lowestSeries(values: readonly Decimal[], period: number): IndicatorSeries {
  assertPeriod('LOWEST', period);
  return values.map((_, i) => (i + 1 < period ? null : extreme(values.slice(i + 1 - period, i + 1), min)));
}

abstract class RollingExtreme implements StreamingIndicator {
  readonly warmupBars: number;
  count = 0;
  value: Decimal | null = null;
  // Monotonic deque of [index, value]: O(1) amortised per update.
  private readonly deque: { i: number; v: Decimal }[] = [];
  protected abstract dominates(a: Decimal, b: Decimal): boolean;
  constructor(
    readonly period: number,
    readonly source: PriceSource,
  ) {
    assertPeriod('rolling extreme', period);
    this.warmupBars = period;
  }
  update(bar: OhlcvBar): Decimal | null {
    return this.push(pick(bar, this.source));
  }
  push(x: Decimal): Decimal | null {
    const i = this.count++;
    while (this.deque.length > 0 && this.dominates(x, at(this.deque, this.deque.length - 1).v)) this.deque.pop();
    this.deque.push({ i, v: x });
    while (at(this.deque, 0).i <= i - this.period) this.deque.shift();
    this.value = this.count >= this.period ? at(this.deque, 0).v : null;
    return this.value;
  }
}

/** Streaming rolling highest (default source: bar high). */
export class HighestIndicator extends RollingExtreme {
  constructor(period: number, source: PriceSource = 'high') {
    super(period, source);
  }
  protected dominates(a: Decimal, b: Decimal): boolean {
    return a.gte(b);
  }
}

/** Streaming rolling lowest (default source: bar low). */
export class LowestIndicator extends RollingExtreme {
  constructor(period: number, source: PriceSource = 'low') {
    super(period, source);
  }
  protected dominates(a: Decimal, b: Decimal): boolean {
    return a.lte(b);
  }
}
