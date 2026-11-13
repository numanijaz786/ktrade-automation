/**
 * PSX regular session: Mon–Fri 09:30–15:30 Asia/Karachi (UTC+5, no DST) per KTrade's FAQ.
 * Exact session phases (pre-open, closing auction) are configurable later; holidays come from `market_holidays`.
 */
const PKT_OFFSET_MIN = 5 * 60;
export const SESSION_OPEN_MIN = 9 * 60 + 30;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;

export function pktParts(now: Date): { date: string; weekday: number; minutes: number } {
  const local = new Date(now.getTime() + PKT_OFFSET_MIN * 60_000);
  return {
    date: local.toISOString().slice(0, 10),
    weekday: local.getUTCDay(), // 0 = Sunday
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

export function isPsxSessionOpen(now: Date, holidays: ReadonlySet<string>): boolean {
  const p = pktParts(now);
  if (p.weekday === 0 || p.weekday === 6 || holidays.has(p.date)) return false;
  return p.minutes >= SESSION_OPEN_MIN && p.minutes < SESSION_CLOSE_MIN;
}

/** The PSX trading date (PKT calendar date) for an instant. */
export const pktTradeDate = (now: Date): string => pktParts(now).date;
