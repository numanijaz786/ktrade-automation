/**
 * Plain-English helpers for the advisor pages. Everything here is wording or validation: no price level,
 * target or quantity is ever computed on the client (docs/12, ADR-036). Comparisons use `Dec` (BigInt).
 */
import { Dec } from '../decimal';
import type {
  AdvisorAction,
  AdvisorEvaluation,
  AdvisorHorizon,
  AdvisorPrice,
  HoldingAdviceKind,
  ScannerFilter,
} from './types-advisor';

export const HORIZON_LABEL: Record<AdvisorHorizon, string> = {
  SHORT_TERM: 'Short-term',
  SWING: 'Swing',
  LONG_TERM: 'Long-term',
  DIVIDEND: 'Dividend',
  VALUE: 'Value',
  GROWTH: 'Growth',
};

export const ACTION_LABEL: Record<AdvisorAction, string> = {
  STRONG_BUY: 'Strong buy',
  BUY: 'Buy',
  HOLD: 'Hold',
  WATCHLIST: 'Watch only',
  SELL: 'Sell',
  AVOID: 'Avoid',
};

export const HOLDING_ADVICE_LABEL: Record<HoldingAdviceKind, string> = {
  CONTINUE_HOLDING: 'Continue holding',
  PARTIAL_SELL: 'Sell part',
  EXIT: 'Exit',
  TARGET_REACHED: 'Target reached',
};

export const FILTER_LABEL: Record<ScannerFilter, string> = {
  undervalued: 'Undervalued',
  earningsGrowth: 'Earnings growth',
  highDividend: 'High dividend',
  breakout: 'Breakout',
  nearSupport: 'Near support',
  unusualVolume: 'Unusual volume',
  momentum: 'Momentum',
  improvingFundamentals: 'Improving fundamentals',
  deteriorating: 'Deteriorating',
  illiquid: 'Hard to trade (illiquid)',
};

export const RATIO_LABEL: Record<string, string> = {
  revenueGrowthYoY: 'Revenue growth, year on year (%)',
  revenueGrowthQoQ: 'Revenue growth, quarter on quarter (%)',
  epsGrowthYoY: 'Earnings per share growth, year on year (%)',
  grossMargin: 'Gross margin (%)',
  operatingMargin: 'Operating margin (%)',
  netMargin: 'Net margin (%)',
  eps: 'Earnings per share',
  pe: 'Price to earnings (P/E)',
  pb: 'Price to book (P/B)',
  roe: 'Return on equity (%)',
  roa: 'Return on assets (%)',
  debtToEquity: 'Debt to equity',
  operatingCashFlow: 'Operating cash flow',
  freeCashFlow: 'Free cash flow',
  dividendYield: 'Dividend yield (%)',
  payoutRatio: 'Payout ratio (%)',
};

/**
 * The label shown beside any price. Daily bars are end-of-day closes, so a provider price is "Delayed", never
 * "Live". A stale price says so. Simulated and estimated prices are never called live.
 */
export function priceLabel(p: Pick<AdvisorPrice, 'source' | 'verified'>): {
  text: string;
  tone: 'bad' | 'warn' | 'info' | 'good';
} {
  switch (p.source) {
    case 'SIMULATED':
      return { text: 'Simulated', tone: 'bad' };
    case 'ESTIMATED':
      return { text: 'Estimated', tone: 'warn' };
    case 'USER_REPORTED':
      return p.verified ? { text: 'Imported', tone: 'info' } : { text: 'Imported, stale', tone: 'warn' };
    case 'PROVIDER':
      return p.verified
        ? { text: 'Delayed (daily close)', tone: 'info' }
        : { text: 'Delayed, stale', tone: 'warn' };
    case 'BROKER_DISPLAYED':
    case 'BROKER_CONFIRMED':
      return p.verified ? { text: 'Broker', tone: 'good' } : { text: 'Broker, stale', tone: 'warn' };
  }
}

export interface Timing {
  kind: 'now' | 'wait' | 'below' | 'unknown';
  text: string;
}

/** "When to buy" wording from the API's own entry range and the API's own latest price. */
export function whenToBuy(ev: Pick<AdvisorEvaluation, 'plan' | 'price'>): Timing {
  const plan = ev.plan;
  if (!plan) return { kind: 'unknown', text: 'No entry range was returned, so no buying advice is shown.' };
  const low = plan.entry.low;
  const high = plan.entry.high;
  const price = ev.price?.value;
  const base = `Buy only near the entry range (${low} to ${high}). Do not chase the price.`;
  if (!price) return { kind: 'unknown', text: `${base} The latest price is unavailable, so check it first.` };
  const p = Dec.of(price);
  if (p.gt(high))
    return {
      kind: 'wait',
      text: `${base} The latest price (${price}) is above the range: wait for it to come back, do not chase.`,
    };
  if (p.lt(low))
    return {
      kind: 'below',
      text: `${base} The latest price (${price}) is below the range: check why before buying, and respect the stop-loss.`,
    };
  return { kind: 'now', text: `${base} The latest price (${price}) is inside the range.` };
}

export type ReasonGroup = 'Technical' | 'Fundamental' | 'Valuation' | 'Other';
export function reasonGroup(ruleId: string): ReasonGroup {
  if (ruleId.startsWith('T_')) return 'Technical';
  if (ruleId.startsWith('F_')) return 'Fundamental';
  if (ruleId.startsWith('V_')) return 'Valuation';
  return 'Other';
}

/** `/trade` link prefilled from the advisor's plan. Advisory only: the ticket still needs preview and approval. */
export function tradePrefillHref(ev: Pick<AdvisorEvaluation, 'symbol' | 'plan'>): string | null {
  const plan = ev.plan;
  if (!plan || !/^\d+$/.test(plan.size.quantity) || !/[1-9]/.test(plan.size.quantity)) return null;
  const q = new URLSearchParams({
    symbol: ev.symbol,
    side: 'BUY',
    qty: plan.size.quantity,
    type: 'LIMIT',
    limit: plan.entry.high,
  });
  return `/trade?${q.toString()}`;
}

export const MAX_RISK_PCT = '5';

/** Mirrors the API: 0 < r <= 5, at most 2 decimal places. Returns an error message or null. */
export function validateRiskPct(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Enter a percentage';
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(v)) return 'Use a number like 1 or 0.5 (at most 2 decimal places)';
  const d = Dec.of(v);
  if (!d.gt(0)) return 'Must be greater than 0';
  if (d.gt(MAX_RISK_PCT)) return `Must be at most ${MAX_RISK_PCT}`;
  return null;
}

/** Rupee amount at risk = equity x risk% / 100, from the API's own equity and the saved risk setting. */
export function riskAmount(equity: string, riskPct: string): string {
  return Dec.of(equity).mul(riskPct).div('100').round(2).toString();
}
