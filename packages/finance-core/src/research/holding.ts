/**
 * Holdings advice (docs/12 §7): continue holding / partial sell / exit / target reached, from the user's own
 * average cost, fees, dividends, realized P&L, stop and targets. Same hard gates as evaluateStock: simulated,
 * stale, too-short or fundamentals-less evaluations give NO advice. A loss alone is never a reason to sell.
 */
import { type Decimal, HUNDRED, ONE, round, ZERO } from '../decimal.js';
import { computeTradeFees } from '../fees/engine.js';
import { runEvaluation } from './evaluate.js';
import { DISCLAIMER, type EvaluateStockInput, type StockEvaluation } from './rec-types.js';
import { fmt } from './util.js';

export type HoldingAdvice = 'CONTINUE_HOLDING' | 'PARTIAL_SELL' | 'EXIT' | 'TARGET_REACHED';

export interface HoldingPosition {
  readonly qty: Decimal;
  /** Average cost per share including buy fees (as the ledger reports it). */
  readonly avgCost: Decimal;
  /** Realized P&L already booked on this symbol (net of fees). */
  readonly realizedPnl?: Decimal | null;
  /** Net dividends received while holding. */
  readonly dividendsReceived?: Decimal | null;
  readonly stopLoss?: Decimal | null;
  /** Target prices (any order). */
  readonly targets?: readonly Decimal[] | null;
}

export interface EvaluateHoldingInput extends Omit<EvaluateStockInput, 'portfolio'> {
  readonly portfolio: Omit<EvaluateStockInput['portfolio'], 'holdingQty'> & { readonly holdingQty?: Decimal };
  readonly position: HoldingPosition;
}

export interface HoldingPnl {
  readonly lastPrice: Decimal;
  readonly costBasis: Decimal;
  readonly marketValue: Decimal;
  readonly unrealizedGross: Decimal;
  readonly estimatedSellFees: Decimal;
  /** After estimated sell fees and taxes. */
  readonly unrealizedNet: Decimal;
  readonly unrealizedNetPct: Decimal | null;
  readonly realizedPnl: Decimal;
  readonly dividendsReceived: Decimal;
  /** unrealizedNet + realizedPnl + dividends. */
  readonly totalReturn: Decimal;
  readonly totalReturnPct: Decimal | null;
}

export interface HoldingEvaluation {
  readonly status: 'ACTIONABLE' | 'NOT_ACTIONABLE';
  readonly advice: HoldingAdvice | null;
  readonly headline: string;
  readonly notActionableReasons: readonly string[];
  readonly reasons: readonly string[];
  readonly pnl: HoldingPnl | null;
  readonly suggestedSellQty: Decimal | null;
  readonly stopLoss: { readonly price: Decimal; readonly origin: 'SUPPLIED' | 'SUGGESTED_FROM_ATR' } | null;
  readonly targetsReached: number;
  readonly targetsTotal: number;
  readonly stockEvaluation: StockEvaluation;
  readonly warnings: readonly string[];
  readonly disclaimer: string;
}

/** Whole shares to sell: floor(x), at least 1, at most the position. */
const wholeShares = (qty: Decimal, x: Decimal): Decimal => {
  const f = round(x, 0, 'DOWN');
  return f.lt(1) ? (qty.gte(1) ? ONE : ZERO) : f.gt(qty) ? qty : f;
};

export function evaluateHolding(input: EvaluateHoldingInput): HoldingEvaluation {
  const pos = input.position;
  if (!pos.qty.gt(0)) throw new RangeError('position.qty must be > 0');
  if (!pos.avgCost.gt(0)) throw new RangeError('position.avgCost must be > 0');
  const run = runEvaluation({ ...input, portfolio: { ...input.portfolio, holdingQty: pos.qty } });
  const ev = run.evaluation;
  if (ev.status === 'NOT_ACTIONABLE' || run.tech === null) {
    return {
      status: 'NOT_ACTIONABLE',
      advice: null,
      headline: `No holding advice: ${ev.notActionableReasons[0] ?? 'not actionable'}`,
      notActionableReasons: ev.notActionableReasons,
      reasons: [],
      pnl: null,
      suggestedSellQty: null,
      stopLoss: null,
      targetsReached: 0,
      targetsTotal: pos.targets?.length ?? 0,
      stockEvaluation: ev,
      warnings: ev.warnings,
      disclaimer: DISCLAIMER,
    };
  }
  const close = run.tech.close;
  const cfg = run.cfg;
  const sell = computeTradeFees(input.risk.feeSchedule, { side: 'SELL', quantity: pos.qty, price: close });
  const costBasis = pos.qty.times(pos.avgCost);
  const marketValue = pos.qty.times(close);
  const unrealizedGross = marketValue.minus(costBasis);
  const unrealizedNet = unrealizedGross.minus(sell.total);
  const realized = pos.realizedPnl ?? ZERO;
  const divs = pos.dividendsReceived ?? ZERO;
  const totalReturn = unrealizedNet.plus(realized).plus(divs);
  const pnl: HoldingPnl = {
    lastPrice: close,
    costBasis,
    marketValue,
    unrealizedGross,
    estimatedSellFees: sell.total,
    unrealizedNet,
    unrealizedNetPct: unrealizedNet.div(costBasis).times(HUNDRED),
    realizedPnl: realized,
    dividendsReceived: divs,
    totalReturn,
    totalReturnPct: totalReturn.div(costBasis).times(HUNDRED),
  };

  const warnings = [...ev.warnings];
  const reasons: string[] = [
    `last close ${fmt(close)} vs average cost ${fmt(pos.avgCost)}: unrealized ${fmt(unrealizedNet)} after estimated sell fees ${fmt(sell.total)}; realized ${fmt(realized)}, dividends ${fmt(divs)}`,
  ];
  let stop: HoldingEvaluation['stopLoss'] = null;
  if (pos.stopLoss) stop = { price: pos.stopLoss, origin: 'SUPPLIED' };
  else if (run.tech.atr !== null) {
    stop = {
      price: close.minus(run.tech.atr.times(cfg.stopAtrMult[input.horizon])),
      origin: 'SUGGESTED_FROM_ATR',
    };
    warnings.push('no stop-loss supplied; the shown stop is a suggestion from ATR, not a recorded order');
  }
  const targets = [...(pos.targets ?? [])].sort((a, b) => a.cmp(b));
  const reached = targets.filter((t) => close.gte(t)).length;

  let advice: HoldingAdvice;
  let qty: Decimal | null = null;
  if (pos.stopLoss && close.lte(pos.stopLoss)) {
    advice = 'EXIT';
    qty = pos.qty;
    reasons.push(`stop-loss hit: close ${fmt(close)} <= stop ${fmt(pos.stopLoss)}`);
  } else if (ev.action === 'SELL') {
    advice = 'EXIT';
    qty = pos.qty;
    reasons.push(`structural deterioration: ${ev.headline}`);
    reasons.push(...ev.reasons.filter((r) => r.supports === 'BEARISH').map((r) => r.text));
  } else if (targets.length > 0 && reached === targets.length) {
    advice = 'TARGET_REACHED';
    qty = pos.qty;
    reasons.push(
      `all ${targets.length} target(s) reached (highest ${fmt(targets[targets.length - 1] as Decimal)}); close ${fmt(close)}. Sell the remainder or trail a stop under the recent swing low`,
    );
  } else if (reached > 0) {
    advice = 'PARTIAL_SELL';
    const share = targets.length - reached + 1;
    qty = wholeShares(pos.qty, pos.qty.div(share));
    reasons.push(
      `${reached} of ${targets.length} targets reached; take 1/${share} of the position (${qty.toString()} shares) and keep the rest`,
    );
  } else if (ev.scores && ev.scores.structuralBearPassed > 0 && ev.scores.bear.gte(cfg.avoidSoftBearMin)) {
    advice = 'PARTIAL_SELL';
    qty = wholeShares(pos.qty, pos.qty.div(2));
    reasons.push(
      `structural deterioration is present (bear ${fmt(ev.scores.bear)}) but not decisive: reduce by half (${qty.toString()} shares)`,
    );
    reasons.push(...ev.reasons.filter((r) => r.supports === 'BEARISH').map((r) => r.text));
  } else {
    advice = 'CONTINUE_HOLDING';
    reasons.push(`no stop, target or structural-deterioration trigger: ${ev.headline}`);
    if (unrealizedNet.isNeg()) reasons.push('an unrealized loss alone is not a reason to sell');
  }
  return {
    status: 'ACTIONABLE',
    advice,
    headline: `${advice}: ${reasons[1] ?? reasons[0] ?? ''}`,
    notActionableReasons: [],
    reasons,
    pnl,
    suggestedSellQty: qty,
    stopLoss: stop,
    targetsReached: reached,
    targetsTotal: targets.length,
    stockEvaluation: ev,
    warnings,
    disclaimer: DISCLAIMER,
  };
}
