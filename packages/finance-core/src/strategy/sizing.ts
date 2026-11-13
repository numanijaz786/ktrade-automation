/**
 * Position sizer (docs/08 §4). All "Pct" inputs are percentages (5 = 5%).
 *
 * suggestedQty = floor(min(
 *   BUDGET            maxInvestmentRemaining / (price × (1 + feeEstimatePct/100)),
 *   MAX_POSITION_QTY  maxPositionQty                                  (if set),
 *   RISK_PER_TRADE    (riskPerTradePct/100 × equity) / (price − stopPrice)   (if risk% AND stopPrice set),
 *   CONCENTRATION     (maxPositionPct/100 × portfolioValue − currentPositionValue) / price  (if set)
 * )), clamped at 0. qty 0 ⇒ no trade.
 */
import { type Decimal, HUNDRED, ONE, round, ZERO } from '../decimal.js';

export type SizingConstraint = 'BUDGET' | 'MAX_POSITION_QTY' | 'RISK_PER_TRADE' | 'CONCENTRATION';

export interface PositionSizingInput {
  readonly price: Decimal;
  readonly maxInvestmentRemaining: Decimal;
  /** Estimated round-trip-entry fee as % of value (e.g. "0.25"). Default 0. */
  readonly feeEstimatePct?: Decimal | null;
  readonly maxPositionQty?: Decimal | null;
  readonly riskPerTradePct?: Decimal | null;
  readonly equity?: Decimal | null;
  readonly stopPrice?: Decimal | null;
  readonly maxPositionPct?: Decimal | null;
  readonly portfolioValue?: Decimal | null;
  /** Market value of the existing holding in this symbol (for the concentration cap). Default 0. */
  readonly currentPositionValue?: Decimal | null;
}

export interface SizingCandidate {
  readonly constraint: SizingConstraint;
  /** Whole shares (floored, >= 0). */
  readonly qty: Decimal;
}

export interface PositionSizingResult {
  /** Whole shares, >= 0. */
  readonly qty: Decimal;
  readonly tradable: boolean;
  /** The constraint that produced the minimum (first in BUDGET, MAX_POSITION_QTY, RISK_PER_TRADE, CONCENTRATION order on ties). */
  readonly binding: SizingConstraint;
  readonly candidates: readonly SizingCandidate[];
}

const floorNonNeg = (x: Decimal): Decimal => (x.lte(0) ? ZERO : round(x, 0, 'DOWN'));

export function sizePosition(input: PositionSizingInput): PositionSizingResult {
  const { price } = input;
  if (!price.gt(0)) throw new RangeError('sizePosition: price must be > 0');
  if (input.maxInvestmentRemaining.isNeg())
    throw new RangeError('sizePosition: maxInvestmentRemaining must be >= 0');
  const fee = input.feeEstimatePct ?? ZERO;
  if (fee.isNeg()) throw new RangeError('sizePosition: feeEstimatePct must be >= 0');

  const candidates: SizingCandidate[] = [
    {
      constraint: 'BUDGET',
      qty: floorNonNeg(input.maxInvestmentRemaining.div(price.times(ONE.plus(fee.div(HUNDRED))))),
    },
  ];
  if (input.maxPositionQty !== undefined && input.maxPositionQty !== null) {
    if (input.maxPositionQty.isNeg()) throw new RangeError('sizePosition: maxPositionQty must be >= 0');
    candidates.push({ constraint: 'MAX_POSITION_QTY', qty: floorNonNeg(input.maxPositionQty) });
  }
  const risk = input.riskPerTradePct ?? null;
  const stop = input.stopPrice ?? null;
  if (risk !== null && stop !== null) {
    const equity = input.equity ?? null;
    if (equity === null) throw new RangeError('sizePosition: equity is required with riskPerTradePct');
    if (risk.isNeg()) throw new RangeError('sizePosition: riskPerTradePct must be >= 0');
    if (!stop.lt(price)) throw new RangeError('sizePosition: stopPrice must be below price for a long entry');
    candidates.push({
      constraint: 'RISK_PER_TRADE',
      qty: floorNonNeg(risk.div(HUNDRED).times(equity).div(price.minus(stop))),
    });
  }
  const conc = input.maxPositionPct ?? null;
  if (conc !== null) {
    const pv = input.portfolioValue ?? null;
    if (pv === null) throw new RangeError('sizePosition: portfolioValue is required with maxPositionPct');
    const room = conc
      .div(HUNDRED)
      .times(pv)
      .minus(input.currentPositionValue ?? ZERO);
    candidates.push({ constraint: 'CONCENTRATION', qty: floorNonNeg(room.div(price)) });
  }
  let best = candidates[0] as SizingCandidate;
  for (const c of candidates) if (c.qty.lt(best.qty)) best = c;
  return { qty: best.qty, tradable: best.qty.gt(0), binding: best.constraint, candidates };
}
