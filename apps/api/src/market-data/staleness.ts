import type { QuoteDto } from '@ktrade/broker-sdk';
import type { PsxCalendar } from './calendar.js';
import { SimulatedPriceRefusedError, StalePriceError } from './errors.js';

/** Extra minutes a quote may lag (on top of its declared delay) before it counts as stale. */
export const DEFAULT_FRESHNESS_MINUTES = 5;

/**
 * docs/09 §B2: data older than its freshness threshold is stale.
 * - Market open: stale when `now − asOf` exceeds `delayMinutes + freshnessMinutes`.
 * - Market closed: stale when it predates the most recent completed session's close (minus the same
 *   allowance). So EOD data from last night is fresh before the open, and stale once trading starts.
 */
export function isStale(
  quote: Pick<QuoteDto, 'asOf' | 'delayMinutes'>,
  now: Date,
  calendar: PsxCalendar,
  freshnessMinutes = DEFAULT_FRESHNESS_MINUTES,
): boolean {
  const asOf = Date.parse(quote.asOf);
  if (Number.isNaN(asOf)) return true;
  const allowanceMs = (quote.delayMinutes + freshnessMinutes) * 60_000;
  if (calendar.isOpen(now)) return now.getTime() - asOf > allowanceMs;
  const lastClose = calendar.sessionClose(calendar.lastCompletedSession(now)).getTime();
  return asOf < lastClose - allowanceMs;
}

/**
 * Guard for anything that acts on real money (live order previews/approval): refuses SIMULATED
 * prices outright and stale prices of any source. Paper trading and backtests do not call this.
 */
export function assertUsableForLive(
  quote: Pick<QuoteDto, 'symbol' | 'asOf' | 'source'> & { stale: boolean },
): void {
  if (quote.source === 'SIMULATED') throw new SimulatedPriceRefusedError(quote.symbol);
  if (quote.stale) throw new StalePriceError(quote.symbol, quote.asOf);
}
