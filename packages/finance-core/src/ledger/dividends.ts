/**
 * Dividend entitlement maths (docs/06 §6) and settlement-based eligibility helpers. Pure.
 *
 *   gross = sharesEligible × dividendPerShare     (paisa)
 *   wht   = gross × whtRate                       (paisa)
 *   net   = gross − wht − zakat
 *
 * Eligibility: shares *settled* before book closure starts. With T+n settlement, a trade on T settles
 * on the n-th trading day after T; it is eligible iff that settlement date < book-closure start.
 */
import { type Decimal, type DecimalInput, type RoundingMode, d, roundPaisa, sum, ZERO } from '../decimal.js';
import { assertIsoDate } from '../fees/isoDate.js';

export interface DividendEntitlementInput {
  sharesEligible: DecimalInput;
  dividendPerShare: DecimalInput;
  /** Withholding rate as a fraction (from findTaxRate / estimateDividendTax). */
  whtRate: DecimalInput;
  /** Zakat deducted at source (amount; 0 when exempt / declaration filed). */
  zakatAmount?: DecimalInput;
  rounding?: RoundingMode;
}

export interface DividendEntitlementAmounts {
  sharesEligible: Decimal;
  dividendPerShare: Decimal;
  gross: Decimal;
  whtRate: Decimal;
  wht: Decimal;
  zakat: Decimal;
  net: Decimal;
}

export function computeDividendEntitlement(input: DividendEntitlementInput): DividendEntitlementAmounts {
  const shares = d(input.sharesEligible);
  const dps = d(input.dividendPerShare);
  const rate = d(input.whtRate);
  const zakat = roundPaisa(d(input.zakatAmount ?? ZERO), input.rounding ?? 'HALF_UP');
  if (shares.isNeg()) throw new RangeError('sharesEligible must be ≥ 0');
  if (dps.isNeg()) throw new RangeError('dividendPerShare must be ≥ 0');
  if (rate.isNeg() || rate.gt(1)) throw new RangeError('whtRate must be within [0, 1]');
  if (zakat.isNeg()) throw new RangeError('zakatAmount must be ≥ 0');
  const mode = input.rounding ?? 'HALF_UP';
  const gross = roundPaisa(shares.times(dps), mode);
  const wht = roundPaisa(gross.times(rate), mode);
  const net = gross.minus(wht).minus(zakat);
  if (net.isNeg()) throw new RangeError('Deductions exceed the gross dividend');
  return { sharesEligible: shares, dividendPerShare: dps, gross, whtRate: rate, wht, zakat, net };
}

function sortedCalendar(calendar: readonly string[]): readonly string[] {
  for (let i = 0; i < calendar.length; i++) {
    assertIsoDate(calendar[i] as string, 'trading calendar date');
    if (i > 0 && !((calendar[i - 1] as string) < (calendar[i] as string))) {
      throw new RangeError('tradingCalendar must be strictly ascending');
    }
  }
  return calendar;
}

function checkDays(settlementDays: number): void {
  if (!Number.isSafeInteger(settlementDays) || settlementDays < 0) {
    throw new RangeError(`settlementDays must be a non-negative integer, got ${settlementDays}`);
  }
}

/**
 * Settlement date of a trade: the `settlementDays`-th trading day after `tradeDate` (T+0 → tradeDate).
 * `tradingCalendar` is the ascending list of PSX trading days and must extend far enough.
 */
export function settlementDateFor(tradeDate: string, settlementDays: number, tradingCalendar: readonly string[]): string {
  assertIsoDate(tradeDate, 'tradeDate');
  checkDays(settlementDays);
  if (settlementDays === 0) return tradeDate;
  const cal = sortedCalendar(tradingCalendar);
  const after = cal.filter((day) => day > tradeDate);
  const s = after[settlementDays - 1];
  if (s === undefined) throw new RangeError(`tradingCalendar does not extend to T+${settlementDays} of ${tradeDate}`);
  return s;
}

/** True iff a trade on `tradeDate` settles strictly before `bookClosureStart`. */
export function isTradeEligibleForBookClosure(
  tradeDate: string,
  bookClosureStart: string,
  settlementDays: number,
  tradingCalendar: readonly string[],
): boolean {
  assertIsoDate(bookClosureStart, 'bookClosureStart');
  return settlementDateFor(tradeDate, settlementDays, tradingCalendar) < bookClosureStart;
}

/**
 * Last trade date whose settlement lands before book closure starts (the last "cum" day),
 * or null if the calendar does not reach back far enough.
 */
export function latestEligibleTradeDate(
  bookClosureStart: string,
  settlementDays: number,
  tradingCalendar: readonly string[],
): string | null {
  assertIsoDate(bookClosureStart, 'bookClosureStart');
  checkDays(settlementDays);
  const before = sortedCalendar(tradingCalendar).filter((day) => day < bookClosureStart);
  // The last settlement day is the last trading day before book closure; step back n trading days.
  return before[before.length - 1 - settlementDays] ?? null;
}

export interface SettledQuantityMovement {
  /** ISO settlement date of the movement. */
  settlementDate: string;
  /** Signed share delta (+ buy / bonus credit, − sell). */
  quantity: DecimalInput;
}

/** Shares settled strictly before `bookClosureStart` — the eligible quantity for an entitlement. */
export function settledQuantityBefore(movements: readonly SettledQuantityMovement[], bookClosureStart: string): Decimal {
  assertIsoDate(bookClosureStart, 'bookClosureStart');
  const qty = sum(
    movements
      .filter((mv) => assertIsoDate(mv.settlementDate, 'settlementDate') < bookClosureStart)
      .map((mv) => d(mv.quantity)),
  );
  if (qty.isNeg()) throw new RangeError('Settled quantity is negative: movements are inconsistent');
  return qty;
}
