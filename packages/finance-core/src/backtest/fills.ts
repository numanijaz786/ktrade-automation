/**
 * Fill models (docs/08 §5).
 *
 * Slippage is applied adversely: BUY price × (1 + bps/10000), SELL price × (1 − bps/10000), rounded to price
 * precision (6 dp, half-even). A limit order never fills at a price worse than its limit: slippage is capped
 * at the limit.
 */
import { type Decimal, HUNDRED, max, min, ONE, round, roundPrice, ZERO } from '../decimal.js';
import { type OhlcvBar } from '../indicators/types.js';
import { type TradeSide } from '../strategy/types.js';

const BPS = HUNDRED.times(HUNDRED);

/** Adverse slippage: BUY pays more, SELL receives less. */
export function applySlippage(side: TradeSide, price: Decimal, slippageBps: Decimal): Decimal {
  if (slippageBps.isNeg()) throw new RangeError('slippageBps must be >= 0');
  const f = slippageBps.div(BPS);
  return roundPrice(side === 'BUY' ? price.times(ONE.plus(f)) : price.times(ONE.minus(f)));
}

/** floor(volume × pct / 100), or null when no cap applies. */
export function volumeCapQty(
  volume: Decimal | null | undefined,
  participationPct: Decimal | null | undefined,
): Decimal | null {
  if (participationPct === null || participationPct === undefined || volume === null || volume === undefined)
    return null;
  if (!participationPct.gt(0)) throw new RangeError('volume participation pct must be > 0');
  return round(volume.times(participationPct).div(HUNDRED), 0, 'DOWN');
}

export type PaperOrderType = 'MARKET' | 'LIMIT';

export interface PaperWorkingOrder {
  readonly side: TradeSide;
  readonly type: PaperOrderType;
  /** Remaining quantity (whole shares, > 0). */
  readonly qty: Decimal;
  readonly limitPrice?: Decimal | null;
}

export interface PaperQuote {
  /** Last traded price of the new quote. */
  readonly last: Decimal;
  /** Volume traded since the previous quote (used only for the participation cap). */
  readonly volume?: Decimal | null;
}

export interface PaperFillOptions {
  readonly slippageBps?: Decimal;
  /** Max % of `quote.volume` this order may take; ignored when the quote carries no volume. */
  readonly volumeParticipationPct?: Decimal | null;
}

export interface PaperFillResult {
  readonly filled: boolean;
  readonly qty: Decimal;
  readonly price: Decimal | null;
  readonly remainingQty: Decimal;
  readonly reason: string;
}

/**
 * Paper fill against the NEXT quote after the order was placed:
 *  - MARKET BUY  → fills at last × (1 + slip); MARKET SELL → last × (1 − slip).
 *  - LIMIT BUY   → fills iff last ≤ limit, at min(last × (1 + slip), limit).
 *  - LIMIT SELL  → fills iff last ≥ limit, at max(last × (1 − slip), limit).
 *  - Partial fills: qty = min(remaining, floor(quote.volume × pct/100)) when a participation cap is set and
 *    the quote has volume; a cap of 0 shares means no fill on this quote.
 */
export function paperFill(
  order: PaperWorkingOrder,
  quote: PaperQuote,
  options: PaperFillOptions = {},
): PaperFillResult {
  if (!order.qty.isInteger() || !order.qty.gt(0))
    throw new RangeError('paperFill: qty must be a positive whole number');
  if (!quote.last.gt(0)) throw new RangeError('paperFill: quote.last must be > 0');
  const slip = options.slippageBps ?? ZERO;
  const none = (reason: string): PaperFillResult => ({
    filled: false,
    qty: ZERO,
    price: null,
    remainingQty: order.qty,
    reason,
  });
  let price: Decimal;
  if (order.type === 'MARKET') {
    price = applySlippage(order.side, quote.last, slip);
  } else {
    const limit = order.limitPrice;
    if (!limit || !limit.gt(0)) throw new RangeError('paperFill: LIMIT order requires a positive limitPrice');
    const slipped = applySlippage(order.side, quote.last, slip);
    if (order.side === 'BUY') {
      if (quote.last.gt(limit))
        return none(`last ${quote.last.toString()} above buy limit ${limit.toString()}`);
      price = min(slipped, limit);
    } else {
      if (quote.last.lt(limit))
        return none(`last ${quote.last.toString()} below sell limit ${limit.toString()}`);
      price = max(slipped, limit);
    }
  }
  const cap = volumeCapQty(quote.volume, options.volumeParticipationPct);
  const qty = cap === null ? order.qty : min(order.qty, cap);
  if (qty.isZero()) return none('volume participation cap allows 0 shares');
  return {
    filled: true,
    qty,
    price,
    remainingQty: order.qty.minus(qty),
    reason: qty.eq(order.qty) ? 'filled' : 'partially filled (volume cap)',
  };
}

/**
 * Bar-based limit fill for simulations: a limit order fills only if the bar trades THROUGH the limit
 * (BUY: low < limit; SELL: high > limit — a mere touch does not fill). Fill price is the open if the bar
 * opened beyond the limit (gap in the order's favour), else the limit; slippage is applied but capped at the limit.
 */
export function barLimitFill(
  side: TradeSide,
  limitPrice: Decimal,
  bar: OhlcvBar,
  slippageBps: Decimal = ZERO,
): { filled: boolean; price: Decimal | null } {
  if (side === 'BUY') {
    if (!bar.low.lt(limitPrice)) return { filled: false, price: null };
    return {
      filled: true,
      price: min(applySlippage('BUY', min(bar.open, limitPrice), slippageBps), limitPrice),
    };
  }
  if (!bar.high.gt(limitPrice)) return { filled: false, price: null };
  return {
    filled: true,
    price: max(applySlippage('SELL', max(bar.open, limitPrice), slippageBps), limitPrice),
  };
}
