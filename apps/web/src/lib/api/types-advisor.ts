/**
 * Advisor types (apps/api/src/advisor, ADR-036). Money and ratios are decimal STRINGS. A value the API did not
 * return is `null` here and is shown as "unavailable": the UI never fills in a price level, target or
 * confidence of its own.
 */
import type { DataSource } from '@ktrade/shared';
import type { Decimal, Instant, IsoDate } from './types';

export const ADVISOR_HORIZONS = ['SHORT_TERM', 'SWING', 'LONG_TERM', 'DIVIDEND', 'VALUE', 'GROWTH'] as const;
export type AdvisorHorizon = (typeof ADVISOR_HORIZONS)[number];

export type AdvisorAction = 'STRONG_BUY' | 'BUY' | 'HOLD' | 'WATCHLIST' | 'SELL' | 'AVOID';
export type HoldingAdviceKind = 'CONTINUE_HOLDING' | 'PARTIAL_SELL' | 'EXIT' | 'TARGET_REACHED';

export const SCANNER_FILTERS = [
  'undervalued',
  'earningsGrowth',
  'highDividend',
  'breakout',
  'nearSupport',
  'unusualVolume',
  'momentum',
  'improvingFundamentals',
  'deteriorating',
  'illiquid',
] as const;
export type ScannerFilter = (typeof SCANNER_FILTERS)[number];

export interface AdvisorPrice {
  value: Decimal;
  source: DataSource;
  asOfBar: IsoDate;
  barTs: Instant;
  /** Neither SIMULATED nor ESTIMATED, and not stale. */
  verified: boolean;
}

export interface ConfidenceComponent {
  name: string;
  weight: number;
  score: Decimal;
  contribution: Decimal;
  detail: string;
}

export interface AdvisorConfidence {
  score: Decimal;
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  components: ConfidenceComponent[];
  caps: string[];
}

export interface AdvisorTarget {
  n: number;
  price: Decimal;
  basis: string;
  riskReward: Decimal;
  netRiskReward: Decimal | null;
  upsidePct: Decimal;
}

export interface AdvisorPlan {
  entry: { low: Decimal; high: Decimal; basis: string };
  stopLoss: { price: Decimal; basis: string; downsidePct: Decimal };
  targets: AdvisorTarget[];
  holdingPeriod: string;
  size: {
    quantity: Decimal;
    allocationPct: Decimal;
    binding: string;
    estimatedCost: Decimal;
    estimatedBuyFees: Decimal;
    maxLossAtStop: Decimal;
  };
}

export interface AdvisorReason {
  ruleId: string;
  supports: 'BULLISH' | 'BEARISH';
  text: string;
}

export interface AdvisorExplanation {
  available: boolean;
  provider: string;
  summary: string | null;
  bullets: string[];
  risks: string[];
  dataNotes: string[];
  reason: string | null;
}

export interface EvaluationDataQuality {
  sourcesUsed: string[];
  latestBarSource: string | null;
  latestBarTs: Instant | null;
  barsUsed: number | null;
  priceAgeMinutes: Decimal | null;
  delayMinutes: number | null;
  missingInputs: string[];
  warnings: string[];
}

export interface AdvisorEvaluation {
  symbol: string;
  name: string | null;
  sector: string | null;
  horizon: AdvisorHorizon;
  rank: number | null;
  status: 'ACTIONABLE' | 'NOT_ACTIONABLE';
  action: AdvisorAction | null;
  headline: string;
  price: AdvisorPrice | null;
  confidence: AdvisorConfidence | null;
  scores: { bull: Decimal; bear: Decimal; coveragePct: Decimal } | null;
  plan: AdvisorPlan | null;
  reasons: AdvisorReason[];
  invalidation: string[];
  watchFor: string[];
  warnings: string[];
  notActionableReasons: string[];
  dataQuality: EvaluationDataQuality;
  explanation: AdvisorExplanation | null;
  disclaimer: string;
}

// ─── holdings advice ──────────────────────────────────────────────────────

export interface HoldingPnl {
  lastPrice: Decimal;
  costBasis: Decimal;
  marketValue: Decimal;
  unrealizedGross: Decimal;
  estimatedSellFees: Decimal | null;
  unrealizedNet: Decimal | null;
  unrealizedNetPct: Decimal | null;
  realizedPnl: Decimal | null;
  dividendsReceived: Decimal | null;
  totalReturn: Decimal | null;
  totalReturnPct: Decimal | null;
  priceSource: DataSource | null;
}

export interface HoldingAdvice {
  symbol: string;
  name: string;
  sector: string | null;
  quantity: Decimal;
  avgCost: Decimal;
  price: AdvisorPrice | null;
  marketValue: Decimal | null;
  pnl: HoldingPnl | null;
  status: 'ACTIONABLE' | 'NOT_ACTIONABLE';
  advice: HoldingAdviceKind | null;
  headline: string;
  notActionableReasons: string[];
  reasons: string[];
  suggestedSellQty: Decimal | null;
  stop: { price: Decimal; origin: 'SUPPLIED' | 'SUGGESTED_FROM_ATR' } | null;
  targets: { n: number; price: Decimal }[];
  targetsReached: number;
  sellRange: { low: Decimal; high: Decimal; basis: string } | null;
  planNote: string | null;
  invalidations: string[];
  dividendsConsidered: Decimal | null;
  warnings: string[];
  explanation: AdvisorExplanation | null;
}

export interface HoldingsAdviceReport {
  portfolioId: string;
  horizon: AdvisorHorizon;
  generatedAt: Instant;
  holdings: HoldingAdvice[];
}

// ─── daily report ─────────────────────────────────────────────────────────

export interface AdvisorDataQuality {
  sources: Record<string, number>;
  freshest: Instant | null;
  staleCount: number;
  simulatedShare: Decimal | null;
  missingFundamentalsCount: number;
  coverageNote: string;
}

export interface NotEnoughData {
  summary: string;
  evaluated: number;
  simulated: number;
  stale: number;
  reasons: { reason: string; count: number; symbols: string[] }[];
}

export interface ChangeEvent {
  kind: string;
  symbol: string;
  horizon: string;
  from: string | null;
  to: string | null;
  detail: string;
  date: string | null;
}

export interface AdvisorNewsItem {
  id: string;
  symbols: string[];
  affects: { symbol: string; relation: 'HELD' | 'WATCHED' }[];
  title: string;
  category: string | null;
  source: DataSource | null;
  sourceName: string | null;
  url: string | null;
  publishedAt: Instant;
  sentiment: string | null;
}

export interface PortfolioNote {
  kind: string;
  severity: 'INFO' | 'WARN';
  text: string;
}

export interface HoldSummary {
  symbol: string;
  headline: string;
  unrealizedNet: Decimal | null;
}

export interface DailyReport {
  generatedAt: Instant;
  dataAsOf: IsoDate | null;
  horizon: AdvisorHorizon;
  portfolio: { id: string; name: string; cash: Decimal; equity: Decimal };
  dataQuality: AdvisorDataQuality;
  headline: string;
  notEnoughData: NotEnoughData | null;
  topBuys: AdvisorEvaluation[];
  avoidOrSell: AdvisorEvaluation[];
  holds: HoldSummary[];
  opportunities: AdvisorEvaluation[];
  holdingsAdvice: HoldingAdvice[];
  whatChanged: { baseline: boolean; compared: number; events: ChangeEvent[]; note: string | null };
  newsImpact: {
    windowHours: number;
    coverage: string;
    lastUpdated: Instant | null;
    items: AdvisorNewsItem[];
    note: string | null;
  };
  portfolioNotes: PortfolioNote[];
  disclaimer: string;
}

export interface AdvisorRunSummary {
  portfolioId: string;
  runAt: Instant;
  universe: number;
  skippedNoBars: number;
  evaluated: number;
  stored: number;
  alreadyStored: number;
  actionable: number;
  notActionable: number;
  failed: number;
}

// ─── scanner ──────────────────────────────────────────────────────────────

export interface ScannerResult {
  rank: number;
  symbol: string;
  name: string | null;
  sector: string | null;
  action: AdvisorAction | null;
  headline: string;
  confidence: Decimal | null;
  price: AdvisorPrice | null;
  matched: { metric: string; value: string; threshold: string };
}

export interface ScannerReport {
  horizon: AdvisorHorizon;
  filter: ScannerFilter;
  generatedAt: Instant;
  universe: number;
  verifiedEvaluations: number;
  results: ScannerResult[];
  note: string | null;
}

// ─── stock research ───────────────────────────────────────────────────────

export type RatioOutcome =
  | { status: 'OK'; value: Decimal; unit: string; formula: string; flags: string[] }
  | { status: 'UNAVAILABLE'; missing: string[]; reason: string };

export interface StockTechnicals {
  basis: string;
  notice: string | null;
  trend: {
    classification: string;
    sma20: Decimal | null;
    sma50: Decimal | null;
    sma100: Decimal | null;
    sma200: Decimal | null;
    explanation: string[];
  };
  rsi14: Decimal | null;
  macdHistogram: Decimal | null;
  atr14: Decimal | null;
  adxExplanation: string[];
  support: Decimal | null;
  resistance: Decimal | null;
  volume: {
    relativeVolume: Decimal | null;
    avgVolume20: Decimal | null;
    avgTradedValue20: Decimal | null;
    adTrend: string | null;
  };
  momentumScore: Decimal | null;
  breakout: { crossed: boolean; confirmed: boolean };
}

export interface StockValuation {
  status: 'OK' | 'UNAVAILABLE';
  facts: { name: string; value: Decimal; period: string; currency: string; source: string }[];
  assumptions: { name: string; value: string; basis: string }[];
  fairValueLow: Decimal | null;
  fairValueHigh: Decimal | null;
  marginOfSafetyPct: Decimal | null;
  explanation: string[];
  reason: string | null;
}

export interface StockAnnouncement {
  id: string;
  title: string;
  category: string | null;
  publishedAt: Instant;
  source: DataSource | null;
  sourceName: string | null;
  url: string | null;
}

export interface StockReport {
  symbol: string;
  name: string;
  sector: string | null;
  generatedAt: Instant;
  price: AdvisorPrice | null;
  technicals: StockTechnicals | null;
  /** null when no financial statements are stored. */
  ratios: Record<string, RatioOutcome> | null;
  ratiosReason: string | null;
  valuation: StockValuation;
  announcements: StockAnnouncement[];
  recommendations: Partial<Record<AdvisorHorizon, AdvisorEvaluation>>;
  dataSources: {
    bars: { count: number; latestBarTs: Instant | null; latestBarSource: string | null; sources: string[] };
    quote: { source: string | null; asOf: Instant | null } | null;
    fundamentals: { period: string; publishedAt: Instant; source: string; peersUsed: number } | null;
    stale: boolean;
  };
}

export interface AdvisorSettings {
  riskPerTradePct: Decimal;
  isDefault: boolean;
}
