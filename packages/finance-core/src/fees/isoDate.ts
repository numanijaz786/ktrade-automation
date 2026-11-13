/**
 * Internal ISO calendar-date helpers ('YYYY-MM-DD'). Shared by fees/, ledger/ and returns/.
 * Day arithmetic is integer counting (allowed for counts/periods); no clocks are read.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Throws RangeError unless `s` is a real calendar date in 'YYYY-MM-DD' form. */
export function assertIsoDate(s: string, label = 'date'): string {
  const m = ISO_DATE.exec(s);
  if (!m) throw new RangeError(`${label} must be an ISO date 'YYYY-MM-DD', got '${s}'`);
  const [, y, mo, da] = m;
  const t = new Date(`${y}-${mo}-${da}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== s) {
    throw new RangeError(`${label} is not a valid calendar date: '${s}'`);
  }
  return s;
}

/** Epoch day number (days since 1970-01-01) of a validated ISO date. */
export function epochDay(s: string): number {
  assertIsoDate(s);
  return Date.parse(`${s}T00:00:00Z`) / MS_PER_DAY;
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return epochDay(to) - epochDay(from);
}

/** Valid ISO dates order lexicographically. */
export function compareIsoDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 'YYYY-MM' of an ISO date. */
export function isoMonth(s: string): string {
  return assertIsoDate(s).slice(0, 7);
}

/** True when `date` lies in [from, to] (to inclusive; null/undefined = open-ended). */
export function isWithinEffective(date: string, from: string, to?: string | null): boolean {
  return date >= from && (to === null || to === undefined || date <= to);
}
