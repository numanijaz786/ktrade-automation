/**
 * Wire shapes of apps/api/src/research-data and apps/api/src/recommendations, and their mapping to web types.
 * The API is the source of truth: values are passed through untouched (decimal strings stay strings) and
 * absent optional items stay absent. Free-form JSON the engine stores (reasons, invalidations, data quality)
 * is read defensively, so an unexpected shape degrades to "nothing shown" instead of a crash.
 */
import { RECOMMENDATION_HORIZONS, type DataSource } from '@ktrade/shared';
import { FINANCIAL_ITEM_KEYS } from '../types';
import type {
  AnnouncementInput,
  AnnouncementsImportResult,
  EvaluationSummary,
  FinancialInput,
  FinancialItemKey,
  FinancialPeriod,
  FinancialSaved,
  FinancialsImportResult,
  FinancialsList,
  MacroList,
  MacroObservation,
  MarketProvider,
  NewsFeed,
  NewsItem,
  PerformanceQuery,
  PerformanceStats,
  ProviderRow,
  Recommendation,
  RecommendationDataQuality,
  RecommendationDetail,
  RecommendationOutcome,
  RecommendationPage,
  RecommendationPerformance,
  RecommendationQuery,
  ResearchProviderStatus,
} from '../types';

// ─── small helpers ─────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A JSON list of strings or of `{ text | message | condition | label }` objects → plain strings. */
export function textList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string' && x.trim()) out.push(x);
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      const t = str(o.text) ?? str(o.message) ?? str(o.condition) ?? str(o.label);
      if (t?.trim()) out.push(t);
    }
  }
  return out;
}

// ─── news ──────────────────────────────────────────────────────────────────

export interface ApiNewsItem {
  id: string;
  symbol: string | null;
  symbols: string[];
  title: string;
  summary: string | null;
  url: string | null;
  category: NewsItem['category'];
  source: DataSource;
  sourceName: string;
  publishedAt: string;
  retrievedAt: string;
  sentiment: NewsItem['sentiment'];
  sentimentSource: NewsItem['sentimentSource'];
  relevance: number | null;
  affectsHoldings: boolean;
  affectedSymbols: string[];
}

export interface ApiNewsFeed {
  generatedAt: string;
  windowHours: number;
  lastUpdated: string | null;
  coverage: string;
  count: number;
  items: ApiNewsItem[];
  note?: string;
}

export const mapNewsItem = (i: ApiNewsItem): NewsItem => ({
  id: i.id,
  symbol: i.symbol ?? null,
  symbols: i.symbols ?? [],
  title: i.title,
  summary: i.summary ?? null,
  url: i.url ?? null,
  category: i.category,
  source: i.source,
  sourceName: i.sourceName,
  publishedAt: i.publishedAt,
  retrievedAt: i.retrievedAt,
  sentiment: i.sentiment ?? null,
  sentimentSource: i.sentimentSource ?? 'NONE',
  relevance: i.relevance ?? null,
  affectsHoldings: !!i.affectsHoldings,
  affectedSymbols: i.affectedSymbols ?? [],
});

export const mapNewsFeed = (f: ApiNewsFeed): NewsFeed => ({
  generatedAt: f.generatedAt,
  windowHours: f.windowHours,
  lastUpdated: f.lastUpdated ?? null,
  coverage: f.coverage,
  count: f.count,
  items: f.items.map(mapNewsItem),
  note: f.note ?? null,
});

/** The first symbol becomes the primary `symbol` (it links the item to a stock); all go in `symbols`. */
export function toApiAnnouncement(i: AnnouncementInput): Record<string, unknown> {
  const symbols = [...new Set(i.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  return {
    title: i.title.trim(),
    category: i.category,
    publishedAt: i.publishedAt,
    ...(i.summary?.trim() ? { summary: i.summary.trim() } : {}),
    ...(i.url?.trim() ? { url: i.url.trim() } : {}),
    ...(symbols[0] ? { symbol: symbols[0] } : {}),
    symbols,
    ...(i.sourceName?.trim() ? { sourceName: i.sourceName.trim() } : {}),
    ...(i.sentiment ? { sentiment: i.sentiment } : {}),
  };
}

export const mapAnnouncementsImport = (r: AnnouncementsImportResult): AnnouncementsImportResult => ({
  rows: r.rows,
  inserted: r.inserted,
  skipped: r.skipped,
  source: r.source,
});

// ─── financials ────────────────────────────────────────────────────────────

export type ApiFinancial = {
  id: string;
  symbol: string;
  periodType: FinancialPeriod['periodType'];
  periodEnd: string;
  publishedAt: string;
  currency: string;
  source: DataSource;
  sourceRef: string;
  sourceUrl?: string;
} & Partial<Record<FinancialItemKey, string>>;

export function mapFinancial(r: ApiFinancial): FinancialPeriod {
  const items: FinancialPeriod['items'] = {};
  for (const k of FINANCIAL_ITEM_KEYS) {
    const v = r[k];
    if (typeof v === 'string') items[k] = v;
  }
  return {
    id: r.id,
    symbol: r.symbol,
    periodType: r.periodType,
    periodEnd: r.periodEnd,
    publishedAt: r.publishedAt,
    currency: r.currency,
    source: r.source,
    sourceRef: r.sourceRef,
    sourceUrl: r.sourceUrl ?? null,
    items,
  };
}

export const mapFinancialsList = (r: {
  symbol: string;
  data: ApiFinancial[];
  note?: string;
}): FinancialsList => ({
  symbol: r.symbol,
  data: r.data.map(mapFinancial),
  note: r.note ?? null,
});

export const mapFinancialSaved = (r: ApiFinancial & { created: boolean }): FinancialSaved => ({
  ...mapFinancial(r),
  created: !!r.created,
});

export function toApiFinancial(i: FinancialInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    symbol: i.symbol.trim().toUpperCase(),
    periodType: i.periodType,
    periodEnd: i.periodEnd,
    publishedAt: i.publishedAt,
    currency: i.currency.trim().toUpperCase(),
    sourceRef: i.sourceRef.trim(),
  };
  if (i.sourceUrl?.trim()) body.sourceUrl = i.sourceUrl.trim();
  for (const k of FINANCIAL_ITEM_KEYS) {
    const v = i.items[k];
    if (v !== undefined && v.trim() !== '') body[k] = v.trim();
  }
  return body;
}

export const mapFinancialsImport = (r: FinancialsImportResult): FinancialsImportResult => ({
  rows: r.rows,
  inserted: r.inserted,
  updated: r.updated,
  unchanged: r.unchanged,
  symbols: r.symbols ?? [],
  source: r.source,
});

// ─── macro ─────────────────────────────────────────────────────────────────

export type ApiMacro = {
  id?: string;
  series: MacroObservation['series'];
  date: string;
  value: string;
  source: DataSource;
  sourceRef: string;
};

export const mapMacro = (m: ApiMacro): MacroObservation => ({
  id: m.id ?? `${m.series}:${m.date}:${m.source}`,
  series: m.series,
  date: m.date,
  value: m.value,
  source: m.source,
  sourceRef: m.sourceRef,
});

export const mapMacroList = (r: { data: ApiMacro[]; note?: string }): MacroList => ({
  data: r.data.map(mapMacro),
  note: r.note ?? null,
});

// ─── providers ─────────────────────────────────────────────────────────────

export interface ApiResearchProvider {
  providerKey: string;
  displayName: string;
  dataType: ResearchProviderStatus['dataType'];
  enabled: boolean;
  source: DataSource;
  status: ResearchProviderStatus['status'];
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  freshnessMinutes: number | null;
  message: string | null;
  capabilities: {
    freshness: ResearchProviderStatus['freshness'];
    delayMinutes: number;
    licenseNote: string;
    commercialUseAllowed: boolean;
  };
  licenseNote: string;
  commercialUseAllowed: boolean;
  missing: string[];
}

export const mapResearchProvider = (p: ApiResearchProvider): ResearchProviderStatus => ({
  providerKey: p.providerKey,
  displayName: p.displayName,
  dataType: p.dataType,
  enabled: p.enabled,
  source: p.source,
  status: p.status,
  lastAttemptAt: p.lastAttemptAt,
  lastSuccessAt: p.lastSuccessAt ?? null,
  freshnessMinutes: p.freshnessMinutes ?? null,
  message: p.message ?? null,
  freshness: p.capabilities?.freshness ?? [],
  delayMinutes: p.capabilities?.delayMinutes ?? 0,
  licenseNote: p.licenseNote,
  commercialUseAllowed: !!p.commercialUseAllowed,
  missing: p.missing ?? [],
});

const DATA_TYPE_LABEL: Record<string, string> = {
  FUNDAMENTALS: 'Fundamentals',
  ANNOUNCEMENTS: 'Announcements',
  MACRO: 'Macro',
};

function researchTimeliness(p: ResearchProviderStatus): string {
  if (p.freshness.includes('realtime')) return 'Realtime';
  if (p.freshness.includes('delayed'))
    return p.delayMinutes > 0 ? `Delayed (${p.delayMinutes} min)` : 'Delayed';
  if (p.freshness.includes('eod')) return 'End of day';
  if (p.freshness.includes('historical')) return 'Historical only';
  return 'Owner-entered (no feed)';
}

/** A disabled provider is NOT_CONFIGURED; the API's own status wins for enabled ones. */
export function researchProviderRow(p: ResearchProviderStatus): ProviderRow {
  return {
    key: `research:${p.providerKey}`,
    displayName: p.displayName,
    dataType: DATA_TYPE_LABEL[p.dataType] ?? p.dataType,
    status: p.enabled ? p.status : 'NOT_CONFIGURED',
    source: p.source,
    timeliness: researchTimeliness(p),
    lastSuccessAt: p.lastSuccessAt,
    freshnessMinutes: p.freshnessMinutes,
    licenseNote: p.licenseNote || null,
    message: p.message,
    missing: p.missing,
    active: null,
  };
}

function marketTimeliness(p: MarketProvider): string {
  const c = p.capabilities;
  if (c.streaming && c.delayMinutes === 0) return 'Realtime';
  if (c.delayMinutes >= 1440 || (!c.quotes && c.eodBars)) return 'End of day';
  if (c.delayMinutes > 0) return `Delayed (${c.delayMinutes} min)`;
  return c.quotes ? 'Realtime' : 'End of day';
}

/**
 * Market-data providers: disabled = NOT_CONFIGURED (the reason is the API's own text), enabled and health ok
 * = OK, enabled but unhealthy = DEGRADED.
 */
export function marketProviderRow(p: MarketProvider): ProviderRow {
  const status: ProviderRow['status'] = !p.enabled ? 'NOT_CONFIGURED' : p.health?.ok ? 'OK' : 'DEGRADED';
  return {
    key: `market:${p.key}`,
    displayName: p.displayName,
    dataType: 'Prices',
    status,
    source: p.source,
    timeliness: marketTimeliness(p),
    lastSuccessAt: p.health?.ok ? p.health.checkedAt : null,
    freshnessMinutes: null,
    licenseNote: null,
    message: p.enabled ? (p.health?.message ?? null) : null,
    missing: !p.enabled && p.disabledReason ? [p.disabledReason] : [],
    active: p.active,
  };
}

// ─── recommendations ───────────────────────────────────────────────────────

export interface ApiOutcome {
  id: string;
  evaluatedAt: string;
  lastBarDate: string;
  status: RecommendationOutcome['status'];
  maxFavourablePct: string | null;
  maxAdversePct: string | null;
  target1HitAt: string | null;
  target2HitAt: string | null;
  target3HitAt: string | null;
  stopHitAt: string | null;
  closedAt: string | null;
  exitPrice: string | null;
  returnPct: string | null;
  holdingDays: number;
  benchmarkReturnPct: string | null;
}

export const mapOutcome = (o: ApiOutcome): RecommendationOutcome => ({
  id: o.id,
  evaluatedAt: o.evaluatedAt,
  lastBarDate: o.lastBarDate,
  status: o.status,
  maxFavourablePct: o.maxFavourablePct ?? null,
  maxAdversePct: o.maxAdversePct ?? null,
  target1HitAt: o.target1HitAt ?? null,
  target2HitAt: o.target2HitAt ?? null,
  target3HitAt: o.target3HitAt ?? null,
  stopHitAt: o.stopHitAt ?? null,
  closedAt: o.closedAt ?? null,
  exitPrice: o.exitPrice ?? null,
  returnPct: o.returnPct ?? null,
  holdingDays: o.holdingDays,
  benchmarkReturnPct: o.benchmarkReturnPct ?? null,
});

export interface ApiRecommendation {
  id: string;
  symbol: string;
  horizon: Recommendation['horizon'];
  action: Recommendation['action'];
  status: Recommendation['status'];
  generatedAt: string;
  asOfBar: string;
  price: string | null;
  priceSource: DataSource;
  simulated?: boolean;
  entryLow: string | null;
  entryHigh: string | null;
  stop: string | null;
  target1: string | null;
  target2: string | null;
  target3: string | null;
  riskReward: string | null;
  holdingPeriod: string | null;
  holdingDaysMax: number | null;
  confidence: string | null;
  confidenceLevel: Recommendation['confidenceLevel'];
  reasons: unknown;
  invalidations: unknown;
  dataQuality: unknown;
  engineVersion: string;
  latestOutcome?: ApiOutcome | null;
  outcomes?: ApiOutcome[];
}

export function mapDataQuality(v: unknown): RecommendationDataQuality {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const src = str(o.latestBarSource);
  return {
    latestBarSource: src,
    latestBarTs: str(o.latestBarTs),
    barsUsed: num(o.barsUsed),
    missingInputs: textList(o.missingInputs),
    warnings: textList(o.warnings),
  };
}

export function mapRecommendation(r: ApiRecommendation): Recommendation {
  return {
    id: r.id,
    symbol: r.symbol,
    horizon: r.horizon,
    action: r.action,
    status: r.status,
    generatedAt: r.generatedAt,
    asOfBar: r.asOfBar,
    price: r.price ?? null,
    priceSource: r.priceSource,
    simulated: r.simulated ?? r.priceSource === 'SIMULATED',
    entryLow: r.entryLow ?? null,
    entryHigh: r.entryHigh ?? null,
    stop: r.stop ?? null,
    target1: r.target1 ?? null,
    target2: r.target2 ?? null,
    target3: r.target3 ?? null,
    riskReward: r.riskReward ?? null,
    holdingPeriod: r.holdingPeriod ?? null,
    holdingDaysMax: r.holdingDaysMax ?? null,
    confidence: r.confidence ?? null,
    confidenceLevel: r.confidenceLevel,
    reasons: textList(r.reasons),
    invalidations: textList(r.invalidations),
    dataQuality: mapDataQuality(r.dataQuality),
    engineVersion: r.engineVersion,
    latestOutcome: r.latestOutcome ? mapOutcome(r.latestOutcome) : null,
  };
}

export const mapRecommendationDetail = (r: ApiRecommendation): RecommendationDetail => ({
  ...mapRecommendation(r),
  outcomes: (r.outcomes ?? []).map(mapOutcome),
});

export const mapRecommendationPage = (r: {
  total: number;
  data: ApiRecommendation[];
}): RecommendationPage => ({
  total: r.total,
  data: r.data.map(mapRecommendation),
});

export function toRecommendationQuery(q: RecommendationQuery): Record<string, string | number | undefined> {
  return {
    action: q.action,
    horizon: q.horizon,
    status: q.status,
    symbol: q.symbol?.trim() ? q.symbol.trim().toUpperCase() : undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    limit: q.limit,
    offset: q.offset,
  };
}

export function toPerformanceQuery(q: PerformanceQuery): Record<string, string | undefined> {
  return {
    action: q.action,
    horizon: q.horizon,
    symbol: q.symbol?.trim() ? q.symbol.trim().toUpperCase() : undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    includeSimulated: q.includeSimulated ? 'true' : 'false',
  };
}

export type ApiPerformanceStats = PerformanceStats;

export interface ApiRecPerformance extends PerformanceStats {
  scope: { onlyActionable: boolean; includesSimulated: boolean };
  perHorizon: Partial<Record<(typeof RECOMMENDATION_HORIZONS)[number], PerformanceStats>>;
  benchmark: { series: string; avgReturnPct: string; samples: number } | null;
  benchmarkNote: string | null;
  note: string;
}

const EMPTY_STATS: PerformanceStats = {
  recommendations: 0,
  evaluated: 0,
  open: 0,
  closed: 0,
  winRatePct: null,
  avgReturnPct: null,
  targetHitRatePct: null,
  stopFrequencyPct: null,
  avgHoldingDays: null,
  avgBenchmarkReturnPct: null,
  benchmarkSamples: 0,
};

const mapStats = (s: PerformanceStats | undefined): PerformanceStats => ({ ...EMPTY_STATS, ...(s ?? {}) });

export function mapPerformanceReport(p: ApiRecPerformance): RecommendationPerformance {
  const perHorizon = Object.fromEntries(
    RECOMMENDATION_HORIZONS.map((h) => [h, mapStats(p.perHorizon?.[h])]),
  ) as RecommendationPerformance['perHorizon'];
  return {
    ...mapStats(p),
    scope: p.scope,
    perHorizon,
    benchmark: p.benchmark ?? null,
    benchmarkNote: p.benchmarkNote ?? null,
    note: p.note,
  };
}

export const mapEvaluationSummary = (e: EvaluationSummary): EvaluationSummary => ({
  considered: e.considered,
  appended: e.appended,
  closed: e.closed,
  noNewData: e.noNewData,
  evaluatedAt: e.evaluatedAt,
});
