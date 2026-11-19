/**
 * Research data (news, financials, macro, providers) and recommendation history/performance.
 * Shapes mirror apps/api/src/research-data and apps/api/src/recommendations (ADR-034). Money, prices and
 * ratios are decimal STRINGS; the client never computes ratios or returns.
 */
import type {
  AnnouncementCategory,
  ConfidenceLevel,
  DataSource,
  FinancialPeriodType,
  MacroSeries,
  OutcomeStatus,
  ProviderStatusKind,
  RecommendationAction,
  RecommendationHorizon,
  RecommendationStatus,
  ResearchDataType,
  SentimentLabel,
  SentimentSource,
} from '@ktrade/shared';

export type {
  AnnouncementCategory,
  ConfidenceLevel,
  FinancialPeriodType,
  MacroSeries,
  OutcomeStatus,
  ProviderStatusKind,
  RecommendationAction,
  RecommendationHorizon,
  RecommendationStatus,
  ResearchDataType,
  SentimentLabel,
  SentimentSource,
};

type Decimal = string;
type Instant = string;
type IsoDate = string;

// ─── news / announcements ─────────────────────────────────────────────────

export interface NewsItem {
  id: string;
  /** Primary symbol, when the item is about one company. */
  symbol: string | null;
  symbols: string[];
  title: string;
  summary: string | null;
  url: string | null;
  category: AnnouncementCategory;
  source: DataSource;
  sourceName: string;
  publishedAt: Instant;
  retrievedAt: Instant;
  /** null = not assessed (the platform never guesses a sentiment). */
  sentiment: SentimentLabel | null;
  sentimentSource: SentimentSource;
  relevance: number | null;
  affectsHoldings: boolean;
  /** The held symbols this item mentions (the reason behind the flag). */
  affectedSymbols: string[];
}

export interface NewsFeed {
  generatedAt: Instant;
  windowHours: number;
  /** When the owner last added anything; null = nothing has ever been added. */
  lastUpdated: Instant | null;
  coverage: string;
  count: number;
  items: NewsItem[];
  note: string | null;
}

export interface NewsFeedQuery {
  windowHours?: number;
  symbol?: string;
}

export interface AnnouncementInput {
  title: string;
  summary?: string;
  url?: string;
  category: AnnouncementCategory;
  /** YYYY-MM-DD or an ISO timestamp with offset. */
  publishedAt: string;
  symbols: string[];
  sourceName?: string;
  sentiment?: SentimentLabel;
}

export interface AnnouncementsImportResult {
  rows: number;
  inserted: number;
  /** Rows already on file (same title, link and time), or repeated inside the file. */
  skipped: number;
  source: DataSource;
}

// ─── financial statements ─────────────────────────────────────────────────

export const FINANCIAL_ITEM_KEYS = [
  'revenue',
  'grossProfit',
  'operatingProfit',
  'netProfit',
  'eps',
  'totalAssets',
  'totalEquity',
  'totalDebt',
  'operatingCashFlow',
  'capex',
  'sharesOutstanding',
  'dividendPerShare',
] as const;
export type FinancialItemKey = (typeof FINANCIAL_ITEM_KEYS)[number];

export interface FinancialPeriod {
  id: string;
  symbol: string;
  periodType: FinancialPeriodType;
  periodEnd: IsoDate;
  publishedAt: Instant;
  currency: string;
  source: DataSource;
  sourceRef: string;
  sourceUrl: string | null;
  /** Only the items that were entered; an absent key means "not available" (never zero). */
  items: Partial<Record<FinancialItemKey, Decimal>>;
}

export interface FinancialsList {
  symbol: string;
  data: FinancialPeriod[];
  note: string | null;
}

export interface FinancialInput {
  symbol: string;
  periodType: FinancialPeriodType;
  periodEnd: IsoDate;
  publishedAt: string;
  currency: string;
  sourceRef: string;
  sourceUrl?: string;
  items: Partial<Record<FinancialItemKey, Decimal>>;
}

export interface FinancialSaved extends FinancialPeriod {
  /** false = an existing period was corrected in place. */
  created: boolean;
}

export interface FinancialsImportResult {
  rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  symbols: string[];
  source: DataSource;
}

// ─── macro ────────────────────────────────────────────────────────────────

export interface MacroObservation {
  id: string;
  series: MacroSeries;
  date: IsoDate;
  value: Decimal;
  source: DataSource;
  sourceRef: string;
}

export interface MacroList {
  data: MacroObservation[];
  note: string | null;
}

export interface MacroInput {
  series: MacroSeries;
  date: IsoDate;
  value: Decimal;
  sourceRef: string;
}

// ─── providers ────────────────────────────────────────────────────────────

export interface ResearchProviderStatus {
  providerKey: string;
  displayName: string;
  dataType: ResearchDataType;
  enabled: boolean;
  source: DataSource;
  status: ProviderStatusKind;
  lastAttemptAt: Instant;
  lastSuccessAt: Instant | null;
  freshnessMinutes: number | null;
  message: string | null;
  freshness: ('realtime' | 'delayed' | 'eod' | 'historical')[];
  delayMinutes: number;
  licenseNote: string;
  commercialUseAllowed: boolean;
  /** Exactly what is missing to enable it (empty when nothing is). */
  missing: string[];
}

/** One row of the Data Providers page: a research provider or a market-data provider, same shape. */
export interface ProviderRow {
  key: string;
  displayName: string;
  /** "Prices", "Announcements", "Fundamentals", "Macro". */
  dataType: string;
  status: ProviderStatusKind;
  source: DataSource;
  /** Realtime / delayed / end-of-day, in words. */
  timeliness: string;
  lastSuccessAt: Instant | null;
  freshnessMinutes: number | null;
  licenseNote: string | null;
  message: string | null;
  missing: string[];
  active: boolean | null;
}

// ─── recommendations ──────────────────────────────────────────────────────

export interface RecommendationOutcome {
  id: string;
  evaluatedAt: Instant;
  lastBarDate: IsoDate;
  status: OutcomeStatus;
  maxFavourablePct: Decimal | null;
  maxAdversePct: Decimal | null;
  target1HitAt: IsoDate | null;
  target2HitAt: IsoDate | null;
  target3HitAt: IsoDate | null;
  stopHitAt: IsoDate | null;
  closedAt: IsoDate | null;
  exitPrice: Decimal | null;
  returnPct: Decimal | null;
  holdingDays: number;
  benchmarkReturnPct: Decimal | null;
}

export interface RecommendationDataQuality {
  latestBarSource: string | null;
  latestBarTs: Instant | null;
  barsUsed: number | null;
  missingInputs: string[];
  warnings: string[];
}

export interface Recommendation {
  id: string;
  symbol: string;
  horizon: RecommendationHorizon;
  action: RecommendationAction;
  status: RecommendationStatus;
  generatedAt: Instant;
  asOfBar: IsoDate;
  price: Decimal | null;
  priceSource: DataSource;
  /** Priced on SIMULATED data: for testing only. */
  simulated: boolean;
  entryLow: Decimal | null;
  entryHigh: Decimal | null;
  stop: Decimal | null;
  target1: Decimal | null;
  target2: Decimal | null;
  target3: Decimal | null;
  riskReward: Decimal | null;
  holdingPeriod: string | null;
  holdingDaysMax: number | null;
  confidence: Decimal | null;
  confidenceLevel: ConfidenceLevel;
  /** Plain-text reasons (the rule text the engine recorded). */
  reasons: string[];
  /** Plain-text conditions that would invalidate the call. */
  invalidations: string[];
  dataQuality: RecommendationDataQuality;
  engineVersion: string;
  latestOutcome: RecommendationOutcome | null;
}

export interface RecommendationDetail extends Recommendation {
  /** Oldest first. */
  outcomes: RecommendationOutcome[];
}

export interface RecommendationQuery {
  action?: RecommendationAction;
  horizon?: RecommendationHorizon;
  status?: RecommendationStatus;
  symbol?: string;
  from?: IsoDate;
  to?: IsoDate;
  limit?: number;
  offset?: number;
}

export interface RecommendationPage {
  total: number;
  data: Recommendation[];
}

export interface PerformanceStats {
  recommendations: number;
  evaluated: number;
  open: number;
  closed: number;
  winRatePct: Decimal | null;
  avgReturnPct: Decimal | null;
  targetHitRatePct: Decimal | null;
  stopFrequencyPct: Decimal | null;
  avgHoldingDays: Decimal | null;
  avgBenchmarkReturnPct: Decimal | null;
  benchmarkSamples: number;
}

export interface RecommendationPerformance extends PerformanceStats {
  scope: { onlyActionable: boolean; includesSimulated: boolean };
  perHorizon: Record<RecommendationHorizon, PerformanceStats>;
  /** null when no KSE-100 series covers the recommendations. */
  benchmark: { series: string; avgReturnPct: Decimal; samples: number } | null;
  benchmarkNote: string | null;
  note: string;
}

export interface PerformanceQuery {
  action?: RecommendationAction;
  horizon?: RecommendationHorizon;
  symbol?: string;
  from?: IsoDate;
  to?: IsoDate;
  includeSimulated?: boolean;
}

export interface EvaluationSummary {
  considered: number;
  appended: number;
  closed: number;
  noNewData: number;
  evaluatedAt: Instant;
}
