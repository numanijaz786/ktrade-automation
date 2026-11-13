/**
 * PSX trading calendar (docs/09 §B2): Mon–Fri, regular session 09:30–15:30 Asia/Karachi, minus the
 * holidays in `market_holidays`. Pakistan Standard Time is a fixed UTC+05:00 (no DST), so instants are
 * mapped to PKT dates with a constant offset instead of a tz database.
 *
 * Dates are `YYYY-MM-DD` strings in the PKT trading calendar; instants are JS `Date`s (UTC).
 * Only integer millisecond arithmetic happens here, never price maths.
 */

export const PKT_OFFSET_MINUTES = 5 * 60;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const PKT_OFFSET_MS = PKT_OFFSET_MINUTES * MINUTE_MS;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in `YYYY-MM-DD` form (rejects 2026-02-30). */
export function isIsoDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  return new Date(t).toISOString().slice(0, 10) === value;
}

function utcMidnight(date: string): number {
  if (!isIsoDate(date)) throw new RangeError(`Invalid ISO date: ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
}

/** The PKT calendar date an instant falls on. */
export const pktDateOf = (instant: Date): string => new Date(instant.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);

/** Instant of `HH:MM` PKT on a PKT date. */
export const pktInstant = (date: string, minuteOfDay: number): Date =>
  new Date(utcMidnight(date) - PKT_OFFSET_MS + minuteOfDay * MINUTE_MS);

export const addDays = (date: string, days: number): string =>
  new Date(utcMidnight(date) + days * DAY_MS).toISOString().slice(0, 10);

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (date: string): number => new Date(utcMidnight(date)).getUTCDay();
export const isWeekday = (date: string): boolean => {
  const wd = weekdayOf(date);
  return wd !== 0 && wd !== 6;
};

export interface SessionHours {
  /** Minutes after PKT midnight. Default 09:30. */
  openMinute: number;
  /** Minutes after PKT midnight. Default 15:30. */
  closeMinute: number;
}
export const PSX_REGULAR_SESSION: SessionHours = { openMinute: 9 * 60 + 30, closeMinute: 15 * 60 + 30 };

/** Holidays + session hours. Pure and synchronous so providers can use it inside tight loops. */
export class PsxCalendar {
  private readonly holidays: ReadonlySet<string>;

  constructor(
    holidays: Iterable<string> = [],
    readonly session: SessionHours = PSX_REGULAR_SESSION,
  ) {
    this.holidays = new Set(holidays);
    if (session.closeMinute <= session.openMinute) throw new RangeError('Session close must be after open');
  }

  get sessionMinutes(): number {
    return this.session.closeMinute - this.session.openMinute;
  }

  isHoliday(date: string): boolean {
    return this.holidays.has(date);
  }

  isTradingDay(date: string): boolean {
    return isWeekday(date) && !this.holidays.has(date);
  }

  sessionOpen(date: string): Date {
    return pktInstant(date, this.session.openMinute);
  }

  sessionClose(date: string): Date {
    return pktInstant(date, this.session.closeMinute);
  }

  /** Market open right now (regular session, trading day, [open, close)). */
  isOpen(instant: Date): boolean {
    const date = pktDateOf(instant);
    if (!this.isTradingDay(date)) return false;
    const t = instant.getTime();
    return t >= this.sessionOpen(date).getTime() && t < this.sessionClose(date).getTime();
  }

  previousTradingDay(date: string): string {
    let d = addDays(date, -1);
    for (let i = 0; i < 60 && !this.isTradingDay(d); i++) d = addDays(d, -1);
    return d;
  }

  nextTradingDay(date: string): string {
    let d = addDays(date, 1);
    for (let i = 0; i < 60 && !this.isTradingDay(d); i++) d = addDays(d, 1);
    return d;
  }

  /** The most recent trading date whose session has fully closed at `instant`. */
  lastCompletedSession(instant: Date): string {
    const today = pktDateOf(instant);
    if (this.isTradingDay(today) && instant.getTime() >= this.sessionClose(today).getTime()) return today;
    return this.previousTradingDay(today);
  }

  /** Trading dates in [from, to] (inclusive), ascending. */
  tradingDays(from: string, to: string): string[] {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (this.isTradingDay(d)) out.push(d);
    return out;
  }
}
