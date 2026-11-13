import { type Decimal } from '../decimal.js';

/** One OHLCV bar. `ts` is an ISO-8601 timestamp (callers must be consistent about open vs close time). */
export interface OhlcvBar {
  readonly ts: string;
  readonly open: Decimal;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly close: Decimal;
  readonly volume: Decimal;
}

/** Bar field an indicator reads from. */
export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'volume';
export const PRICE_SOURCES: readonly PriceSource[] = ['open', 'high', 'low', 'close', 'volume'];

/** Batch indicator output, index-aligned with the input; `null` during warm-up (or when undefined, e.g. division by 0). */
export type IndicatorSeries<T = Decimal> = (T | null)[];

/**
 * Incremental indicator. `update(bar)` consumes the next bar (strictly in time order) and returns the value
 * as of that bar's close, or `null` while warming up. The first non-null value appears on the
 * `warmupBars`-th update (i.e. at index `warmupBars - 1`).
 */
export interface StreamingIndicator<T = Decimal> {
  readonly warmupBars: number;
  /** Number of bars consumed so far. */
  readonly count: number;
  /** Latest value (null while warming up). */
  readonly value: T | null;
  update(bar: OhlcvBar): T | null;
}
