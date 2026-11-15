/**
 * Dividend eligibility from the ledger (docs/06 §6, ADR-018 §5). Pure: the caller supplies the per-event share
 * deltas (from the same finance-core replay the holdings projection uses) and the PSX calendar.
 *
 * - BUY / SELL deltas settle on T+n trading days (`market.settlementDays`, default 1).
 * - Corporate-action deltas (bonus, split), rights allotments and CDC transfers are credited on their event date —
 *   there is no exchange settlement cycle for them.
 * A delta counts iff it is settled STRICTLY BEFORE book closure starts (finance-core `settledQuantityBefore`).
 */
import {
  type Decimal,
  type SettledQuantityMovement,
  settledQuantityBefore,
  settlementDateFor,
  ZERO,
} from '@ktrade/finance-core';
import { addDays, type PsxCalendar } from '../market-data/calendar.js';

export type SettlementBasis = 'T_PLUS_N' | 'EVENT_DATE';

export interface ShareDelta {
  /** ISO trade / event date. */
  date: string;
  /** Signed share delta (+ buy / bonus, − sell). */
  quantity: Decimal;
  settles: SettlementBasis;
}

/** Upper bound accepted for `market.settlementDays` (PSX is T+1; T+2/T+3 were used historically). */
export const MAX_SETTLEMENT_DAYS = 10;
export const DEFAULT_SETTLEMENT_DAYS = 1;

/** Settlement-dated movements of every delta that could possibly settle before `bookClosureFrom`. */
export function settledMovements(
  deltas: readonly ShareDelta[],
  bookClosureFrom: string,
  settlementDays: number,
  calendar: PsxCalendar,
): SettledQuantityMovement[] {
  // A trade on or after book-closure start can never settle before it.
  const relevant = deltas.filter((x) => x.date < bookClosureFrom && !x.quantity.isZero());
  if (relevant.length === 0) return [];
  const first = relevant.reduce((min, x) => (x.date < min ? x.date : min), relevant[0]!.date);
  // Long enough for T+n of the last relevant trade, even across PSX's longest holiday runs.
  const tradingDays = calendar.tradingDays(first, addDays(bookClosureFrom, 31 + 7 * settlementDays));
  return relevant.map((x) => ({
    settlementDate:
      x.settles === 'T_PLUS_N' ? settlementDateFor(x.date, settlementDays, tradingDays) : x.date,
    quantity: x.quantity,
  }));
}

/** Shares settled in the portfolio strictly before `bookClosureFrom`. */
export function eligibleShares(
  deltas: readonly ShareDelta[],
  bookClosureFrom: string,
  settlementDays: number,
  calendar: PsxCalendar,
): Decimal {
  const movements = settledMovements(deltas, bookClosureFrom, settlementDays, calendar);
  return movements.length === 0 ? ZERO : settledQuantityBefore(movements, bookClosureFrom);
}
