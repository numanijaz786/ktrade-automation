// Internal helpers for the research module. NOT part of the public API.
import { type Decimal, d, fromInt, ZERO } from '../decimal.js';

export { at } from '../indicators/internal.js';

/** Format a Decimal for human-readable explanations (rounded, never used for maths). */
export const fmt = (x: Decimal, dp = 2): string => x.toDecimalPlaces(dp).toFixed(dp);

const MS_PER_DAY = d('86400000');

/** Parse an ISO-8601 date/timestamp to epoch milliseconds (deterministic; no clock). Throws if invalid. */
export function parseTs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new RangeError(`invalid ISO timestamp: ${iso}`);
  return ms;
}
export const tryParseTs = (iso: string): number | null => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** Whole + fractional days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): Decimal {
  return fromInt(parseTs(to) - parseTs(from)).div(MS_PER_DAY);
}
export function minutesBetween(from: string, to: string): Decimal {
  return fromInt(parseTs(to) - parseTs(from)).div(d('60000'));
}

/** Clamp x to [lo, hi]. */
export function clamp(x: Decimal, lo: Decimal, hi: Decimal): Decimal {
  return x.lt(lo) ? lo : x.gt(hi) ? hi : x;
}

/** Linear map of x from [a, b] to [0, 100], clamped. */
export function scale100(x: Decimal, a: Decimal, b: Decimal): Decimal {
  return clamp(x.minus(a).div(b.minus(a)).times(100), ZERO, d('100'));
}

/** Median of a non-empty list (mean of the two middle values for even counts). */
export function median(values: readonly Decimal[]): Decimal {
  if (values.length === 0) throw new RangeError('median of empty list');
  const s = [...values].sort((a, b) => a.cmp(b));
  const mid = s.length >> 1;
  const hi = s[mid] as Decimal;
  return s.length % 2 === 1 ? hi : (s[mid - 1] as Decimal).plus(hi).div(2);
}
