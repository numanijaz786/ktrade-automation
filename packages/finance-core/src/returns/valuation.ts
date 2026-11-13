/**
 * Valuation & simple P&L definitions (docs/06 §5). Ratios are FRACTIONS (0.05 = 5%) and are null —
 * never NaN/Infinity — when undefined (zero or non-positive denominator).
 */
import { type Decimal, type DecimalInput, d, roundMoney, sum } from '../decimal.js';

export interface HoldingValuationInput {
  quantity: DecimalInput;
  totalCost: DecimalInput;
  lastPrice: DecimalInput;
}

export interface HoldingValuation {
  /** qty × lastPrice (4 dp). */
  marketValue: Decimal;
  /** marketValue − totalCost. */
  unrealizedPnl: Decimal;
  /** unrealizedPnl / totalCost; null when totalCost ≤ 0. */
  unrealizedReturn: Decimal | null;
}

/** Market value of a position: qty × lastPrice at ledger precision. */
export function marketValue(quantity: DecimalInput, lastPrice: DecimalInput): Decimal {
  return roundMoney(d(quantity).times(d(lastPrice)));
}

/** Unrealized P&L = marketValue − totalCost. */
export function unrealizedPnl(marketValueAmount: DecimalInput, totalCost: DecimalInput): Decimal {
  return d(marketValueAmount).minus(d(totalCost));
}

export function holdingValuation(input: HoldingValuationInput): HoldingValuation {
  const mv = marketValue(input.quantity, input.lastPrice);
  const cost = d(input.totalCost);
  const pnl = mv.minus(cost);
  return { marketValue: mv, unrealizedPnl: pnl, unrealizedReturn: cost.gt(0) ? pnl.div(cost) : null };
}

/** Liquidation value = marketValue − estimated sell fees. */
export function liquidationValue(marketValueAmount: DecimalInput, estimatedSellFees: DecimalInput): Decimal {
  return d(marketValueAmount).minus(d(estimatedSellFees));
}

/** Account value = cash + Σ market values. */
export function accountValue(cash: DecimalInput, marketValues: readonly DecimalInput[]): Decimal {
  return d(cash).plus(sum(marketValues.map((v) => d(v))));
}

export interface PortfolioWeight<K> {
  key: K;
  marketValue: Decimal;
  /** holding MV / Σ holdings MV; null when Σ MV ≤ 0. */
  weight: Decimal | null;
}

/** Portfolio weight of each holding: MV / Σ MV. */
export function portfolioWeights<K>(holdings: readonly { key: K; marketValue: DecimalInput }[]): PortfolioWeight<K>[] {
  const mvs = holdings.map((h) => d(h.marketValue));
  const total = sum(mvs);
  return holdings.map((h, i) => {
    const mv = mvs[i] as Decimal;
    return { key: h.key, marketValue: mv, weight: total.gt(0) ? mv.div(total) : null };
  });
}

/**
 * Simple return = (accountValue − netContributions) / netContributions.
 * null when netContributions ≤ 0 (the ratio has no meaningful sign/scale then).
 */
export function simpleReturn(accountValueAmount: DecimalInput, netContributions: DecimalInput): Decimal | null {
  const c = d(netContributions);
  if (!c.gt(0)) return null;
  return d(accountValueAmount).minus(c).div(c);
}

/** Today's P&L = V_today − V_prevClose − netExternalFlows_today. */
export function dailyPnl(valueToday: DecimalInput, valuePrevClose: DecimalInput, netExternalFlows: DecimalInput): Decimal {
  return d(valueToday).minus(d(valuePrevClose)).minus(d(netExternalFlows));
}
