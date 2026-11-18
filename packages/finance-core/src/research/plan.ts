/**
 * Trade-plan construction (docs/12 §5): entry range, stop, three targets, position size and fee-aware risk:reward.
 * Pure; reuses sizePosition (strategy) and computeTradeFees (fees). Only called for STRONG_BUY / BUY.
 */
import { type Decimal, HUNDRED, max, ONE, round, ZERO } from '../decimal.js';
import { computeTradeFees } from '../fees/engine.js';
import { sizePosition } from '../strategy/sizing.js';
import {
  HOLDING_PERIODS,
  type PlanTarget,
  type PortfolioContext,
  type RecommendationConfig,
  type RiskConfig,
  type TradePlan,
} from './rec-types.js';
import { type TechSnapshot } from './rules.js';
import { type Horizon } from './types.js';
import { type ValuationSummary } from './valuation.js';
import { fmt } from './util.js';

export interface PlanArgs {
  readonly tech: TechSnapshot;
  readonly horizon: Horizon;
  readonly cfg: RecommendationConfig;
  readonly portfolio: PortfolioContext;
  readonly risk: RiskConfig;
  readonly valuation: ValuationSummary | null;
}

interface Candidate {
  readonly price: Decimal;
  readonly basis: string;
}

export function buildPlan(a: PlanArgs): { plan: TradePlan } | { blocked: string } {
  const { tech, horizon, cfg, portfolio, risk } = a;
  const atr = tech.atr;
  if (atr === null || !atr.gt(0))
    return { blocked: 'ATR is not available or zero; cannot place a volatility-based stop' };
  const price = tech.close;
  const entryHigh = price.times(ONE.plus(cfg.entryTolerancePct.div(HUNDRED)));
  const support = tech.sr.support && tech.sr.support.price.lt(price) ? tech.sr.support : null;

  // Entry: pull back to the nearest support when it is within 1 ATR, else half an ATR below the price.
  let entryLow: Decimal;
  let entryBasis: string;
  if (support && price.minus(support.price).lte(atr)) {
    entryLow = support.price;
    entryBasis = `nearest support ${fmt(support.price)} (${support.touches} touches) to the last close`;
  } else {
    entryLow = price.minus(atr.times('0.5'));
    entryBasis = `last close less 0.5 x ATR(${cfg.atrPeriod}) ${fmt(atr)}`;
  }

  // Stop: the support-based stop when it lies between the ATR stop and 1 ATR below the price (not too wide, not noise-tight), else the ATR stop; always below the entry range.
  const k = cfg.stopAtrMult[horizon];
  const stopAtr = price.minus(atr.times(k));
  const stopSupport = support ? support.price.minus(atr.times('0.25')) : null;
  let stop: Decimal;
  let stopBasis: string;
  if (stopSupport !== null && stopSupport.gte(stopAtr) && stopSupport.lte(price.minus(atr))) {
    stop = stopSupport;
    stopBasis = `0.25 x ATR below support ${fmt((support as { price: Decimal }).price)}`;
  } else {
    stop = stopAtr;
    stopBasis = `${fmt(k)} x ATR(${cfg.atrPeriod}) below the last close`;
  }
  const ceiling = entryLow.minus(atr.times('0.1'));
  if (stop.gt(ceiling)) {
    stop = ceiling;
    stopBasis += '; moved below the entry range';
  }
  if (!stop.gt(0)) return { blocked: 'computed stop-loss is not positive' };
  const riskPerShare = entryHigh.minus(stop);
  if (!riskPerShare.gt(0)) return { blocked: 'risk per share is not positive' };

  // Targets: resistance levels (or ATR multiples), the third optionally the conservative fair value.
  const gap = atr.times('0.5');
  const mults = cfg.targetAtrMults[horizon];
  const resistances: Candidate[] = tech.sr.levels
    .filter((l) => l.type === 'RESISTANCE')
    .map((l) => ({ price: l.price, basis: `resistance ${fmt(l.price)} (${l.touches} touches)` }));
  const valuationCandidate: Candidate[] =
    a.valuation && a.valuation.fairValueLow !== null
      ? [
          {
            price: a.valuation.fairValueLow,
            basis: `conservative fair value ${fmt(a.valuation.fairValueLow)} (model output, see assumptions)`,
          },
        ]
      : [];
  const pick = (prev: Decimal | null, cands: readonly Candidate[], idx: 0 | 1 | 2): Candidate => {
    const floor = (prev ?? price).plus(gap);
    const hit = cands.find((c) => c.price.gte(floor));
    if (hit) return hit;
    const m = mults[idx];
    const atrTarget = price.plus(atr.times(m));
    return atrTarget.gte(floor)
      ? { price: atrTarget, basis: `last close + ${fmt(m)} x ATR(${cfg.atrPeriod})` }
      : { price: floor, basis: 'previous target + 0.5 x ATR' };
  };
  const t1 = pick(null, resistances, 0);
  const t2 = pick(t1.price, resistances, 1);
  const t3 = pick(t2.price, [...valuationCandidate, ...resistances], 2);
  const picks = [t1, t2, t3];

  // Position size: existing sizer, fee-aware, then verified against cash with the exact fee schedule.
  const holdingValue = portfolio.holdingQty.times(price);
  let sectorCap: Decimal | null = null;
  if (
    risk.maxSectorPct !== undefined &&
    risk.maxSectorPct !== null &&
    portfolio.sectorExposurePct !== undefined &&
    portfolio.sectorExposurePct !== null
  ) {
    const roomValue = risk.maxSectorPct
      .minus(portfolio.sectorExposurePct)
      .div(HUNDRED)
      .times(portfolio.equity);
    sectorCap = roomValue.lte(0) ? ZERO : round(roomValue.div(entryHigh), 0, 'DOWN');
  }
  const size = (feePct: Decimal): ReturnType<typeof sizePosition> =>
    sizePosition({
      price: entryHigh,
      maxInvestmentRemaining: max(portfolio.cash, ZERO),
      feeEstimatePct: feePct,
      maxPositionQty: sectorCap,
      riskPerTradePct: risk.riskPerTradePct,
      equity: portfolio.equity,
      stopPrice: stop,
      maxPositionPct: risk.maxPositionPct,
      portfolioValue: portfolio.equity,
      currentPositionValue: holdingValue,
    });
  let sized = size(ZERO);
  if (sized.qty.gt(0)) {
    const f0 = computeTradeFees(risk.feeSchedule, { side: 'BUY', quantity: sized.qty, price: entryHigh });
    sized = size(f0.total.div(f0.grossValue).times(HUNDRED));
  }
  let qty = sized.qty;
  for (let i = 0; i < 1000 && qty.gt(0); i++) {
    const f = computeTradeFees(risk.feeSchedule, { side: 'BUY', quantity: qty, price: entryHigh });
    if (f.netAmount.abs().lte(portfolio.cash)) break;
    qty = qty.minus(1);
  }
  if (!qty.gt(0)) {
    return {
      blocked: `position size is 0 shares (binding constraint ${sized.binding}); insufficient cash or risk limits`,
    };
  }
  const buy = computeTradeFees(risk.feeSchedule, { side: 'BUY', quantity: qty, price: entryHigh });
  const sellAtStop = computeTradeFees(risk.feeSchedule, { side: 'SELL', quantity: qty, price: stop });
  const targets: PlanTarget[] = picks.map((p, i) => {
    const sell = computeTradeFees(risk.feeSchedule, { side: 'SELL', quantity: qty, price: p.price });
    const netReward = p.price.minus(entryHigh).times(qty).minus(buy.total).minus(sell.total);
    const netRisk = riskPerShare.times(qty).plus(buy.total).plus(sellAtStop.total);
    return {
      n: (i + 1) as 1 | 2 | 3,
      price: p.price,
      basis: p.basis,
      riskReward: p.price.minus(entryHigh).div(riskPerShare),
      netRiskReward: netRisk.gt(0) ? netReward.div(netRisk) : null,
      upsidePct: p.price.minus(price).div(price).times(HUNDRED),
    };
  });
  return {
    plan: {
      entryLow,
      entryHigh,
      entryBasis,
      stopLoss: stop,
      stopBasis,
      targets,
      downsidePct: price.minus(stop).div(price).times(HUNDRED),
      holdingPeriod: HOLDING_PERIODS[horizon],
      quantity: qty,
      allocationPct: qty.times(entryHigh).div(portfolio.equity).times(HUNDRED),
      sizingBinding: sized.binding,
      estimatedBuyCost: buy.netAmount.abs(),
      estimatedBuyFees: buy.total,
      maxLoss: riskPerShare.times(qty).plus(buy.total).plus(sellAtStop.total),
    },
  };
}
