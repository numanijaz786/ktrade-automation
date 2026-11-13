// Internal helpers shared by the finance-core trading modules. NOT part of the public API.
import { type Decimal } from '../decimal.js';
import { type OhlcvBar, type PriceSource } from './types.js';

/** Checked index access (the codebase uses noUncheckedIndexedAccess). */
export function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new RangeError(`index ${i} out of bounds (length ${arr.length})`);
  return v;
}

export function assertPeriod(name: string, period: number, minimum = 1): void {
  if (!Number.isSafeInteger(period) || period < minimum) {
    throw new RangeError(`${name}: period must be an integer >= ${minimum}, got ${String(period)}`);
  }
}

export function pick(bar: OhlcvBar, source: PriceSource): Decimal {
  return bar[source];
}

/** Max of plain integers (counts / bar indices only — never money). */
export function maxInt(...xs: number[]): number {
  let m = Number.NEGATIVE_INFINITY;
  for (const x of xs) if (x > m) m = x;
  return m;
}
