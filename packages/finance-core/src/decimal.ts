// Named import: decimal.js ships CJS-style typings, so under NodeNext a default import
// resolves to the module namespace rather than the class. Both its .mjs build and .d.ts export `Decimal`.
import { Decimal as DecimalJs } from 'decimal.js';

/**
 * The ONLY numeric type allowed for money, prices, quantities and rates in this codebase.
 * An isolated Decimal constructor so global Decimal settings elsewhere can never change our maths.
 *
 * precision 34 ≈ IEEE 754 decimal128; ROUND_HALF_EVEN for intermediate maths (unbiased).
 * Explicit rounding helpers below apply the business rounding rules (docs/06 §1).
 */
export const Decimal = DecimalJs.clone({
  precision: 34,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Decimal = InstanceType<typeof Decimal>;
export type DecimalInput = Decimal | string | bigint;

/** Construct a Decimal. JS numbers are deliberately NOT accepted (except safe integers via `fromInt`). */
export function d(value: DecimalInput): Decimal {
  if (typeof value === 'bigint') return new Decimal(value.toString());
  const out = new Decimal(value);
  if (!out.isFinite()) throw new RangeError(`Non-finite decimal: ${String(value)}`);
  return out;
}

/** For counts/indices only (e.g. bar counts, periods). Throws on non-integers. */
export function fromInt(n: number): Decimal {
  if (!Number.isSafeInteger(n)) throw new RangeError(`fromInt expects a safe integer, got ${n}`);
  return new Decimal(n);
}

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
export const HUNDRED = new Decimal(100);

/** Ledger storage precision for money (NUMERIC(20,4)). */
export const MONEY_DP = 4;
/** Storage precision for prices / per-share values (NUMERIC(20,6)). */
export const PRICE_DP = 6;
/** Broker-facing amounts (fee components, contract-note values) are in paisa: 2 dp. */
export const PAISA_DP = 2;

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';
const MODE: Record<RoundingMode, DecimalJs.Rounding> = {
  HALF_UP: DecimalJs.ROUND_HALF_UP,
  HALF_EVEN: DecimalJs.ROUND_HALF_EVEN,
  DOWN: DecimalJs.ROUND_DOWN,
  UP: DecimalJs.ROUND_UP,
};

export function round(x: Decimal, dp: number, mode: RoundingMode = 'HALF_EVEN'): Decimal {
  return x.toDecimalPlaces(dp, MODE[mode]);
}
/** Round to ledger money precision (4 dp, half-even). */
export const roundMoney = (x: Decimal): Decimal => round(x, MONEY_DP, 'HALF_EVEN');
/** Round to price precision (6 dp, half-even). */
export const roundPrice = (x: Decimal): Decimal => round(x, PRICE_DP, 'HALF_EVEN');
/** Round to paisa with a configurable mode (default half-up, matching typical contract notes — to be confirmed). */
export const roundPaisa = (x: Decimal, mode: RoundingMode = 'HALF_UP'): Decimal => round(x, PAISA_DP, mode);

export function sum(values: Iterable<Decimal>): Decimal {
  let acc = ZERO;
  for (const v of values) acc = acc.plus(v);
  return acc;
}

export const max = (a: Decimal, b: Decimal): Decimal => (a.gte(b) ? a : b);
export const min = (a: Decimal, b: Decimal): Decimal => (a.lte(b) ? a : b);

/** Serialize for storage / API: fixed notation, exactly `dp` places. */
export const toFixedString = (x: Decimal, dp: number): string => x.toFixed(dp);

/** Percentage helper: (part / whole) × 100, or null when whole is zero. */
export function pct(part: Decimal, whole: Decimal): Decimal | null {
  return whole.isZero() ? null : part.div(whole).times(HUNDRED);
}
