import { Decimal, type StockEvaluation } from '@ktrade/finance-core';
import { type ExplanationResult } from './explanation.js';
import { type StockBundle } from './advisor-data.service.js';

/** Decimal -> trimmed decimal string (max `dp` places); everything else passes through. Output is JSON-safe. */
export const num = (x: Decimal, dp = 4): string => x.toDecimalPlaces(dp).toFixed();

export function plain(v: unknown, dp = 6): unknown {
  if (v instanceof Decimal) return num(v, dp);
  if (Array.isArray(v)) return v.map((x) => plain(x, dp));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      if (x !== undefined) out[k] = plain(x, dp);
    return out;
  }
  return v;
}

export const jsonSafe = (v: unknown): unknown => JSON.parse(JSON.stringify(plain(v)));

export interface PriceView {
  value: string;
  source: string;
  asOfBar: string;
  barTs: string;
  /** Neither SIMULATED nor ESTIMATED, and not stale. */
  verified: boolean;
}

export function priceView(b: StockBundle): PriceView | null {
  if (!b.lastBar || !b.asOfBar) return null;
  return {
    value: num(b.lastBar.close, 6),
    source: b.lastBar.source,
    asOfBar: b.asOfBar,
    barTs: b.lastBar.ts,
    verified: b.lastBar.source !== 'SIMULATED' && b.lastBar.source !== 'ESTIMATED' && !b.stale,
  };
}

export function planView(ev: StockEvaluation) {
  const p = ev.plan;
  if (!p) return null;
  return {
    entry: { low: num(p.entryLow), high: num(p.entryHigh), basis: p.entryBasis },
    stopLoss: { price: num(p.stopLoss), basis: p.stopBasis, downsidePct: num(p.downsidePct, 2) },
    targets: p.targets.map((t) => ({
      n: t.n,
      price: num(t.price),
      basis: t.basis,
      riskReward: num(t.riskReward, 2),
      netRiskReward: t.netRiskReward ? num(t.netRiskReward, 2) : null,
      upsidePct: num(t.upsidePct, 2),
    })),
    holdingPeriod: p.holdingPeriod,
    size: {
      quantity: p.quantity.toFixed(0),
      allocationPct: num(p.allocationPct, 2),
      binding: p.sizingBinding,
      estimatedCost: num(p.estimatedBuyCost, 2),
      estimatedBuyFees: num(p.estimatedBuyFees, 2),
      maxLossAtStop: num(p.maxLoss, 2),
    },
  };
}

export function evaluationView(ev: StockEvaluation, explanation: ExplanationResult | null, b?: StockBundle) {
  return {
    symbol: ev.symbol,
    name: b?.stock.name ?? null,
    sector: b?.stock.sector ?? null,
    horizon: ev.horizon,
    status: ev.status,
    action: ev.action,
    headline: ev.headline,
    price: b ? priceView(b) : null,
    confidence: ev.confidence
      ? {
          score: num(ev.confidence.score, 2),
          level: ev.confidence.level,
          components: ev.confidence.components.map((c) => ({
            name: c.name,
            weight: c.weight,
            score: num(c.score, 2),
            contribution: num(c.contribution, 2),
            detail: c.detail,
          })),
          caps: ev.confidence.caps,
        }
      : null,
    scores: ev.scores
      ? {
          bull: num(ev.scores.bull, 2),
          bear: num(ev.scores.bear, 2),
          coveragePct: num(ev.scores.coveragePct, 2),
        }
      : null,
    plan: planView(ev),
    reasons: ev.reasons.map((r) => ({ ruleId: r.ruleId, supports: r.supports, text: r.text })),
    invalidation: ev.invalidation,
    watchFor: ev.watchFor,
    warnings: ev.warnings,
    notActionableReasons: ev.notActionableReasons,
    dataQuality: plain(ev.dataQuality),
    explanation,
    disclaimer: ev.disclaimer,
  };
}
