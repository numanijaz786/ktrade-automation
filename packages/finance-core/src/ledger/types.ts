/**
 * Ledger (cost-basis) types for one (portfolio, symbol).
 * Enum spellings mirror @ktrade/shared (CostBasisMethod, TransactionType, CorporateActionType).
 */
import { type Decimal, type DecimalInput } from '../decimal.js';

export type CostBasisMethod = 'WEIGHTED_AVERAGE' | 'FIFO';

interface LedgerEventBase {
  /** Stable identifier (transaction / corporate-action id). Used as the lot id for opened lots. */
  id: string;
  /** ISO 'YYYY-MM-DD' trade date (or ex/book-closure date for corporate actions). */
  date: string;
  /** Optional intra-day order (execution time rank or contract-note line order). */
  sequence?: number;
}

/** BUY or RIGHTS_SUBSCRIPTION: q at p plus capitalised fees f. */
export interface LedgerBuyEvent extends LedgerEventBase {
  type: 'BUY' | 'RIGHTS_SUBSCRIPTION';
  quantity: DecimalInput;
  price: DecimalInput;
  /** Capitalised fees (commission, SST, CDC, levies). Taxes never belong here. Default 0. */
  fees?: DecimalInput;
}

export interface LedgerSellEvent extends LedgerEventBase {
  type: 'SELL';
  quantity: DecimalInput;
  price: DecimalInput;
  /** Fees deducted from proceeds. Default 0. */
  fees?: DecimalInput;
}

/** Shares moved in from another account with their carried-over cost. */
export interface LedgerTransferInEvent extends LedgerEventBase {
  type: 'TRANSFER_IN';
  quantity: DecimalInput;
  totalCost: DecimalInput;
  /** Original acquisition date for holding-period purposes (default: `date`). */
  acquiredDate?: string;
}

/** Shares moved out; cost leaves with them, no P&L is realized. */
export interface LedgerTransferOutEvent extends LedgerEventBase {
  type: 'TRANSFER_OUT';
  quantity: DecimalInput;
}

/** Bonus issue: `ratioNew` new shares for every `ratioOld` held (1 for 10 → ratioNew 1, ratioOld 10). */
export interface LedgerBonusEvent extends LedgerEventBase {
  type: 'BONUS';
  ratioNew: DecimalInput;
  ratioOld: DecimalInput;
}

/** Split a:b (qty × a/b). SPLIT requires a > b; REVERSE_SPLIT requires a < b. */
export interface LedgerSplitEvent extends LedgerEventBase {
  type: 'SPLIT' | 'REVERSE_SPLIT';
  ratioNew: DecimalInput;
  ratioOld: DecimalInput;
}

export type LedgerEvent =
  | LedgerBuyEvent
  | LedgerSellEvent
  | LedgerTransferInEvent
  | LedgerTransferOutEvent
  | LedgerBonusEvent
  | LedgerSplitEvent;

export type LedgerEventType = LedgerEvent['type'];

export type HoldingLotOrigin = 'PURCHASE' | 'RIGHTS' | 'TRANSFER_IN' | 'BONUS';

/** An open tax lot. Lots are always maintained (consumed FIFO), whatever the cost-basis method. */
export interface HoldingLotState {
  lotId: string;
  openEventId: string;
  /** Date the lot was created in this ledger. */
  openDate: string;
  /** Date the holding period runs from (bonus lots inherit their parent's by default). */
  holdingPeriodStart: string;
  origin: HoldingLotOrigin;
  originalQty: Decimal;
  remainingQty: Decimal;
  /** Remaining cost of this lot (4 dp, authoritative). Under FIFO, Σ lots = holding totalCost. */
  remainingCost: Decimal;
  /** remainingCost / remainingQty (6 dp, derived). */
  unitCost: Decimal;
}

export interface LedgerState {
  quantity: Decimal;
  /** 4 dp; authoritative. */
  totalCost: Decimal;
  /** totalCost / quantity at 6 dp; 0 when flat. */
  avgCost: Decimal;
  /** Cumulative realized P&L for the symbol. */
  realizedPnl: Decimal;
  /** Open lots in FIFO consumption order. */
  lots: readonly HoldingLotState[];
  firstAcquiredDate: string | null;
  lastEventDate: string | null;
}

export interface LotChange {
  lotId: string;
  kind: 'OPENED' | 'REDUCED' | 'CLOSED' | 'ADJUSTED';
  quantityDelta: Decimal;
  costDelta: Decimal;
  remainingQtyAfter: Decimal;
  remainingCostAfter: Decimal;
}

export interface LedgerEventResult {
  eventId: string;
  type: LedgerEventType;
  date: string;
  quantityBefore: Decimal;
  quantityAfter: Decimal;
  totalCostBefore: Decimal;
  totalCostAfter: Decimal;
  avgCostBefore: Decimal;
  avgCostAfter: Decimal;
  /** Gross value q·p (4 dp) for trades; null otherwise. */
  grossAmount: Decimal | null;
  /** Cost added to the holding (BUY/RIGHTS/TRANSFER_IN). */
  costAdded: Decimal;
  /** Cost removed from the holding (SELL/TRANSFER_OUT, or written off when a corporate action leaves 0 shares). */
  costRemoved: Decimal;
  /** SELL: q·p − fees. null otherwise. */
  proceeds: Decimal | null;
  /** SELL: proceeds − costRemoved. Corporate action that leaves 0 shares: −cost written off. Otherwise null. */
  realizedPnl: Decimal | null;
  /** BONUS/SPLIT: entitlement lost to flooring (cash-in-lieu is booked separately as ADJUSTMENT income). */
  fractionalQty: Decimal | null;
  lotChanges: LotChange[];
}

export interface LedgerOptions {
  /**
   * Holding-period date of bonus lots: the parent lot's date (default, docs/06 §4) or the bonus date.
   * Must be verified against NCCPL CGT practice.
   */
  bonusLotDating?: 'ORIGINAL_LOT_DATE' | 'BONUS_DATE';
}

export class LedgerError extends Error {
  constructor(
    public readonly code:
      | 'OVERSELL'
      | 'INVALID_QUANTITY'
      | 'INVALID_PRICE'
      | 'INVALID_FEES'
      | 'INVALID_COST'
      | 'INVALID_RATIO'
      | 'OUT_OF_ORDER',
    message: string,
    public readonly eventId?: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export class LedgerOversellError extends LedgerError {
  constructor(
    eventId: string,
    public readonly requested: Decimal,
    public readonly available: Decimal,
  ) {
    super(
      'OVERSELL',
      `Event ${eventId}: cannot remove ${requested.toString()} shares, only ${available.toString()} held`,
      eventId,
    );
    this.name = 'LedgerOversellError';
  }
}
