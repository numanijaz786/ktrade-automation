import { type PsxCalendar, pktDateOf } from '../market-data/calendar.js';

/** Bar length of the intraday intervals (ms). D1 is calendar-based (see below). */
const INTRADAY_MS: Record<string, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  H1: 60 * 60_000,
};

/**
 * When a still-NEW signal stops being actionable (the strategy's interval horizon).
 *  - D1: a signal computed from the bar of trading day T is acted on during the next trading session; it expires
 *    at that session's close (e.g. Friday's bar → Monday 15:30 PKT; holidays from the calendar are skipped).
 *  - Intraday: one bar after the bar it came from has closed (bar start + 2 × bar length).
 */
export function signalExpiresAt(interval: string, barTs: Date, calendar: PsxCalendar): Date {
  const intraday = INTRADAY_MS[interval];
  if (intraday !== undefined) return new Date(barTs.getTime() + 2 * intraday);
  return calendar.sessionClose(calendar.nextTradingDay(pktDateOf(barTs)));
}
