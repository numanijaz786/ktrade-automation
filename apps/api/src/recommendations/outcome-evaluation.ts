import { type Decimal, HUNDRED, max, min, round, ZERO } from '@ktrade/finance-core';
import type { OutcomeStatus } from '@ktrade/shared';
import { addDays } from '../market-data/calendar.js';

/**
 * Pure outcome evaluation for one ACTIONABLE recommendation against stored D1 bars.
 *
 * Rules (conservative by construction, documented in docs/10):
 *  - Only bars STRICTLY AFTER the recommendation bar (`asOfBar`) are used: no look-ahead.
 *  - Reference entry is the recommendation price (the close of the as-of bar the engine saw).
 *  - BUY is long (stop below, targets above); SELL is the mirror image.
 *  - Intrabar order is unknowable from OHLC, so when the stop and any target are both touched in one bar the
 *    STOP is assumed first: the stop wins and targets touched in that bar are not credited.
 *  - A bar that gaps through the stop exits at its open (the worse price), not at the stop.
 *  - Targets fill at the target price (no credit for gapping beyond it).
 *  - The position closes at the stop, the highest defined target, or after `maxDays` calendar days (EXPIRED, at the
 *    close of the last bar inside the window). Otherwise it stays OPEN and is marked to the last close.
 *  - Percentages are direction-adjusted percent of entry, 4 dp half-even.
 */
export interface EvalBar {
  /** PKT trading date YYYY-MM-DD. */
  date: string;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
}

export interface EvalInput {
  action: 'BUY' | 'SELL';
  entry: Decimal;
  stop: Decimal;
  /** Defined targets in order; null = not set. */
  targets: readonly [Decimal | null, Decimal | null, Decimal | null];
  asOfBar: string;
  maxDays: number;
  bars: readonly EvalBar[];
  /** PKT "today": an open position past its window with data is expired. */
  today: string;
}

export interface EvalResult {
  status: OutcomeStatus;
  lastBarDate: string;
  maxFavourable: Decimal;
  maxAdverse: Decimal;
  targetHitAt: readonly [string | null, string | null, string | null];
  stopHitAt: string | null;
  closedAt: string | null;
  exitPrice: Decimal | null;
  returnPct: Decimal;
  holdingDays: number;
}

const r4 = (x: Decimal): Decimal => round(x, 4, 'HALF_EVEN');
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Direction-adjusted percent move of `price` relative to entry. */
export const movePct = (action: 'BUY' | 'SELL', entry: Decimal, price: Decimal): Decimal =>
  r4(
    action === 'BUY'
      ? price.minus(entry).div(entry).times(HUNDRED)
      : entry.minus(price).div(entry).times(HUNDRED),
  );

export function evaluateOutcome(input: EvalInput): EvalResult | null {
  const long = input.action === 'BUY';
  const expiry = addDays(input.asOfBar, input.maxDays);
  const bars = input.bars
    .filter((b) => b.date > input.asOfBar && b.date <= expiry)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const lastInWindow = bars[bars.length - 1];
  if (!lastInWindow) return null;

  const finalIdx = input.targets.reduce((acc, t, i) => (t ? i : acc), -1);
  const hit: [string | null, string | null, string | null] = [null, null, null];
  let stopHitAt: string | null = null;
  let favourable = ZERO; // best price excursion in percent
  let adverse = ZERO; // worst price excursion in percent (<= 0)
  let closed: { status: OutcomeStatus; date: string; exit: Decimal } | null = null;

  for (const bar of bars) {
    const worst = long ? bar.low : bar.high;
    const best = long ? bar.high : bar.low;
    adverse = min(adverse, movePct(input.action, input.entry, worst));
    const stopHit = long ? bar.low.lte(input.stop) : bar.high.gte(input.stop);
    if (stopHit) {
      // Stop first: this bar's favourable excursion and any target touches are not credited.
      const gapped = long ? bar.open.lt(input.stop) : bar.open.gt(input.stop);
      closed = { status: 'STOPPED', date: bar.date, exit: gapped ? bar.open : input.stop };
      stopHitAt = bar.date;
      break;
    }
    favourable = max(favourable, movePct(input.action, input.entry, best));
    input.targets.forEach((t, i) => {
      if (t && hit[i] === null && (long ? bar.high.gte(t) : bar.low.lte(t))) hit[i] = bar.date;
    });
    if (finalIdx >= 0 && hit[finalIdx] !== null) {
      closed = { status: 'TARGET_HIT', date: bar.date, exit: input.targets[finalIdx]! };
      break;
    }
  }

  const lastBar = closed ? bars.find((b) => b.date === closed!.date)! : lastInWindow;
  if (!closed && input.today > expiry)
    closed = { status: 'EXPIRED', date: lastInWindow.date, exit: lastInWindow.close };

  const mark = closed ? closed.exit : lastBar.close;
  return {
    status: closed ? closed.status : 'OPEN',
    lastBarDate: lastBar.date,
    maxFavourable: favourable,
    maxAdverse: adverse,
    targetHitAt: hit,
    stopHitAt,
    closedAt: closed ? closed.date : null,
    exitPrice: closed ? closed.exit : null,
    returnPct: movePct(input.action, input.entry, mark),
    holdingDays: daysBetween(input.asOfBar, closed ? closed.date : lastBar.date),
  };
}
