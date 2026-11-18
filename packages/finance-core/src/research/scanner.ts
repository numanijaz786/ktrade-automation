/**
 * Opportunity scanner (docs/12 §8): evaluates a universe for one horizon and ranks only the ACTIONABLE
 * results whose action passes the filters. Deterministic tie-breaks; an empty list is a valid answer.
 */
import { type Decimal, ZERO } from '../decimal.js';
import { evaluateStock } from './evaluate.js';
import { type EvaluateStockInput, type StockEvaluation } from './rec-types.js';
import { type Horizon, type RecommendationAction } from './types.js';

export interface ScanFilters {
  /** Default: STRONG_BUY and BUY. */
  readonly actions?: readonly RecommendationAction[];
  readonly minConfidence?: Decimal;
  /** Minimum risk:reward to Target 2 (gross). */
  readonly minRiskReward?: Decimal;
  readonly sectors?: readonly string[];
  readonly excludeSymbols?: readonly string[];
  readonly maxResults?: number;
}

export interface RankedOpportunity {
  readonly rank: number;
  readonly symbol: string;
  readonly evaluation: StockEvaluation;
}
export interface ScanResult {
  readonly horizon: Horizon;
  readonly evaluated: number;
  readonly ranked: readonly RankedOpportunity[];
  /** Symbols dropped and why (NOT_ACTIONABLE, action filtered, etc.). */
  readonly excluded: readonly { symbol: string; reason: string }[];
}

const ACTION_RANK: Record<RecommendationAction, number> = {
  STRONG_BUY: 0,
  BUY: 1,
  WATCHLIST: 2,
  HOLD: 3,
  AVOID: 4,
  SELL: 5,
};
const strCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function rankOpportunities(
  universe: readonly Omit<EvaluateStockInput, 'horizon'>[],
  horizon: Horizon,
  filters: ScanFilters = {},
): ScanResult {
  const actions = filters.actions ?? ['STRONG_BUY', 'BUY'];
  const excluded: { symbol: string; reason: string }[] = [];
  const kept: { symbol: string; ev: StockEvaluation }[] = [];
  for (const u of universe) {
    if (filters.excludeSymbols?.includes(u.symbol)) {
      excluded.push({ symbol: u.symbol, reason: 'excluded by filter' });
      continue;
    }
    if (
      filters.sectors &&
      (u.sector === undefined || u.sector === null || !filters.sectors.includes(u.sector))
    ) {
      excluded.push({ symbol: u.symbol, reason: 'sector filtered out' });
      continue;
    }
    const ev = evaluateStock({ ...u, horizon });
    if (ev.status !== 'ACTIONABLE' || ev.action === null) {
      excluded.push({
        symbol: u.symbol,
        reason: `NOT_ACTIONABLE: ${ev.notActionableReasons[0] ?? 'no reason'}`,
      });
      continue;
    }
    if (!actions.includes(ev.action)) {
      excluded.push({ symbol: u.symbol, reason: `action ${ev.action} not in filter` });
      continue;
    }
    if (filters.minConfidence && (ev.confidence === null || ev.confidence.score.lt(filters.minConfidence))) {
      excluded.push({ symbol: u.symbol, reason: 'confidence below minimum' });
      continue;
    }
    const rr = ev.plan?.targets[1]?.riskReward ?? null;
    if (filters.minRiskReward && (rr === null || rr.lt(filters.minRiskReward))) {
      excluded.push({ symbol: u.symbol, reason: 'risk:reward below minimum' });
      continue;
    }
    kept.push({ symbol: u.symbol, ev });
  }
  kept.sort((a, b) => {
    const ra = ACTION_RANK[a.ev.action as RecommendationAction];
    const rb = ACTION_RANK[b.ev.action as RecommendationAction];
    if (ra !== rb) return ra - rb;
    const ca = a.ev.confidence?.score ?? ZERO;
    const cb = b.ev.confidence?.score ?? ZERO;
    if (!ca.eq(cb)) return cb.cmp(ca);
    const ba = a.ev.scores?.bull ?? ZERO;
    const bb = b.ev.scores?.bull ?? ZERO;
    if (!ba.eq(bb)) return bb.cmp(ba);
    const rra = a.ev.plan?.targets[1]?.riskReward ?? ZERO;
    const rrb = b.ev.plan?.targets[1]?.riskReward ?? ZERO;
    if (!rra.eq(rrb)) return rrb.cmp(rra);
    return strCmp(a.symbol, b.symbol);
  });
  const limited = filters.maxResults !== undefined ? kept.slice(0, filters.maxResults) : kept;
  return {
    horizon,
    evaluated: universe.length,
    ranked: limited.map((k, i) => ({ rank: i + 1, symbol: k.symbol, evaluation: k.ev })),
    excluded,
  };
}
