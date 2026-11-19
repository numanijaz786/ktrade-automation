/**
 * Wire shapes of apps/api/src/advisor and their mapping to web types. The API is the source of truth:
 * decimal strings stay strings, a missing value stays `null` (never zero, never a default price level), and
 * free-form JSON is read defensively so an unexpected shape degrades to "unavailable" rather than a crash.
 */
import { DATA_SOURCES, type DataSource } from '@ktrade/shared';
import {
  ADVISOR_HORIZONS,
  SCANNER_FILTERS,
  type AdvisorAction,
  type AdvisorConfidence,
  type AdvisorDataQuality,
  type AdvisorEvaluation,
  type AdvisorExplanation,
  type AdvisorHorizon,
  type AdvisorNewsItem,
  type AdvisorPlan,
  type AdvisorPrice,
  type AdvisorRunSummary,
  type AdvisorSettings,
  type ChangeEvent,
  type DailyReport,
  type EvaluationDataQuality,
  type HoldingAdvice,
  type HoldingAdviceKind,
  type HoldingPnl,
  type HoldingsAdviceReport,
  type NotEnoughData,
  type PortfolioNote,
  type RatioOutcome,
  type ScannerFilter,
  type ScannerReport,
  type ScannerResult,
  type StockReport,
  type StockTechnicals,
  type StockValuation,
} from '../types-advisor';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strOr = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
/** Decimal strings only; the API never sends JSON numbers for money. */
const dec = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');

/** An unknown source label is treated as ESTIMATED (never as verified data). */
export function mapSource(v: unknown): DataSource {
  return (DATA_SOURCES as readonly string[]).includes(v as string) ? (v as DataSource) : 'ESTIMATED';
}
const horizonOf = (v: unknown): AdvisorHorizon =>
  (ADVISOR_HORIZONS as readonly string[]).includes(v as string) ? (v as AdvisorHorizon) : 'SWING';

export function mapPrice(v: unknown): AdvisorPrice | null {
  const o = rec(v);
  const value = dec(o.value);
  if (!value) return null;
  const source = mapSource(o.source);
  return {
    value,
    source,
    asOfBar: strOr(o.asOfBar),
    barTs: strOr(o.barTs),
    // Only an explicit `true` from the API counts, and SIMULATED / ESTIMATED can never be verified.
    verified: o.verified === true && source !== 'SIMULATED' && source !== 'ESTIMATED',
  };
}

function mapConfidence(v: unknown): AdvisorConfidence | null {
  const o = rec(v);
  const score = dec(o.score);
  if (!score) return null;
  const level = o.level === 'HIGH' || o.level === 'MEDIUM' || o.level === 'LOW' ? o.level : 'LOW';
  return {
    score,
    level,
    components: arr(o.components).map((c) => {
      const x = rec(c);
      return {
        name: strOr(x.name),
        weight: int(x.weight) ?? 0,
        score: dec(x.score) ?? '0',
        contribution: dec(x.contribution) ?? '0',
        detail: strOr(x.detail),
      };
    }),
    caps: strs(o.caps),
  };
}

function mapPlan(v: unknown): AdvisorPlan | null {
  const o = rec(v);
  const entry = rec(o.entry);
  const stop = rec(o.stopLoss);
  const size = rec(o.size);
  const low = dec(entry.low);
  const high = dec(entry.high);
  const stopPrice = dec(stop.price);
  // A plan without an entry range and a stop is not a plan: show nothing rather than a partial one.
  if (!low || !high || !stopPrice) return null;
  return {
    entry: { low, high, basis: strOr(entry.basis) },
    stopLoss: { price: stopPrice, basis: strOr(stop.basis), downsidePct: dec(stop.downsidePct) ?? '' },
    targets: arr(o.targets).flatMap((t) => {
      const x = rec(t);
      const price = dec(x.price);
      if (!price) return [];
      return [
        {
          n: int(x.n) ?? 0,
          price,
          basis: strOr(x.basis),
          riskReward: dec(x.riskReward) ?? '',
          netRiskReward: dec(x.netRiskReward),
          upsidePct: dec(x.upsidePct) ?? '',
        },
      ];
    }),
    holdingPeriod: strOr(o.holdingPeriod),
    size: {
      quantity: dec(size.quantity) ?? '',
      allocationPct: dec(size.allocationPct) ?? '',
      binding: strOr(size.binding),
      estimatedCost: dec(size.estimatedCost) ?? '',
      estimatedBuyFees: dec(size.estimatedBuyFees) ?? '',
      maxLossAtStop: dec(size.maxLoss) ?? dec(size.maxLossAtStop) ?? '',
    },
  };
}

export function mapExplanation(v: unknown): AdvisorExplanation | null {
  if (v === null || v === undefined) return null;
  const o = rec(v);
  return {
    available: o.available === true,
    provider: strOr(o.provider),
    summary: str(o.summary),
    bullets: strs(o.bullets),
    risks: strs(o.risks),
    dataNotes: strs(o.dataNotes),
    reason: str(o.reason),
  };
}

function mapEvalQuality(v: unknown): EvaluationDataQuality {
  const o = rec(v);
  return {
    sourcesUsed: strs(o.sourcesUsed),
    latestBarSource: str(o.latestBarSource),
    latestBarTs: str(o.latestBarTs),
    barsUsed: int(o.barsUsed),
    priceAgeMinutes: dec(o.priceAgeMinutes),
    delayMinutes: int(o.delayMinutes),
    missingInputs: strs(o.missingInputs),
    warnings: strs(o.warnings),
  };
}

const ACTIONS = ['STRONG_BUY', 'BUY', 'HOLD', 'WATCHLIST', 'SELL', 'AVOID'];

export function mapEvaluation(v: unknown): AdvisorEvaluation {
  const o = rec(v);
  const scores = rec(o.scores);
  return {
    symbol: strOr(o.symbol),
    name: str(o.name),
    sector: str(o.sector),
    horizon: horizonOf(o.horizon),
    rank: int(o.rank),
    status: o.status === 'ACTIONABLE' ? 'ACTIONABLE' : 'NOT_ACTIONABLE',
    action: ACTIONS.includes(o.action as string) ? (o.action as AdvisorAction) : null,
    headline: strOr(o.headline),
    price: mapPrice(o.price),
    confidence: mapConfidence(o.confidence),
    scores:
      dec(scores.bull) && dec(scores.bear)
        ? { bull: dec(scores.bull)!, bear: dec(scores.bear)!, coveragePct: dec(scores.coveragePct) ?? '' }
        : null,
    plan: mapPlan(o.plan),
    reasons: arr(o.reasons).map((r) => {
      const x = rec(r);
      return {
        ruleId: strOr(x.ruleId),
        supports: x.supports === 'BEARISH' ? 'BEARISH' : 'BULLISH',
        text: strOr(x.text),
      };
    }),
    invalidation: strs(o.invalidation),
    watchFor: strs(o.watchFor),
    warnings: strs(o.warnings),
    notActionableReasons: strs(o.notActionableReasons),
    dataQuality: mapEvalQuality(o.dataQuality),
    explanation: mapExplanation(o.explanation),
    disclaimer: strOr(o.disclaimer),
  };
}

const ADVICE: HoldingAdviceKind[] = ['CONTINUE_HOLDING', 'PARTIAL_SELL', 'EXIT', 'TARGET_REACHED'];

function mapPnl(v: unknown): HoldingPnl | null {
  const o = rec(v);
  const lastPrice = dec(o.lastPrice);
  const costBasis = dec(o.costBasis);
  const marketValue = dec(o.marketValue);
  const gross = dec(o.unrealizedGross);
  if (!lastPrice || !costBasis || !marketValue || !gross) return null;
  return {
    lastPrice,
    costBasis,
    marketValue,
    unrealizedGross: gross,
    estimatedSellFees: dec(o.estimatedSellFees),
    unrealizedNet: dec(o.unrealizedNet),
    unrealizedNetPct: dec(o.unrealizedNetPct),
    realizedPnl: dec(o.realizedPnl),
    dividendsReceived: dec(o.dividendsReceived),
    totalReturn: dec(o.totalReturn),
    totalReturnPct: dec(o.totalReturnPct),
    priceSource: o.priceSource ? mapSource(o.priceSource) : null,
  };
}

export function mapHoldingAdvice(v: unknown): HoldingAdvice {
  const o = rec(v);
  const stop = rec(o.stop);
  const range = rec(o.sellRange);
  return {
    symbol: strOr(o.symbol),
    name: strOr(o.name),
    sector: str(o.sector),
    quantity: dec(o.quantity) ?? '0',
    avgCost: dec(o.avgCost) ?? '',
    price: mapPrice(o.price),
    marketValue: dec(o.marketValue),
    pnl: mapPnl(o.pnl),
    status: o.status === 'ACTIONABLE' ? 'ACTIONABLE' : 'NOT_ACTIONABLE',
    advice: ADVICE.includes(o.advice as HoldingAdviceKind) ? (o.advice as HoldingAdviceKind) : null,
    headline: strOr(o.headline),
    notActionableReasons: strs(o.notActionableReasons),
    reasons: strs(o.reasons),
    suggestedSellQty: dec(o.suggestedSellQty),
    stop: dec(stop.price)
      ? {
          price: dec(stop.price)!,
          origin: stop.origin === 'SUPPLIED' ? 'SUPPLIED' : 'SUGGESTED_FROM_ATR',
        }
      : null,
    targets: arr(o.targets).flatMap((t) => {
      const x = rec(t);
      const price = dec(x.price);
      return price ? [{ n: int(x.n) ?? 0, price }] : [];
    }),
    targetsReached: int(o.targetsReached) ?? 0,
    sellRange:
      dec(range.low) && dec(range.high)
        ? { low: dec(range.low)!, high: dec(range.high)!, basis: strOr(range.basis) }
        : null,
    planNote: str(o.planNote),
    invalidations: strs(o.invalidations),
    dividendsConsidered: dec(o.dividendsConsidered),
    warnings: strs(o.warnings),
    explanation: mapExplanation(o.explanation),
  };
}

export function mapHoldingsReport(v: unknown): HoldingsAdviceReport {
  const o = rec(v);
  return {
    portfolioId: strOr(o.portfolioId),
    horizon: horizonOf(o.horizon),
    generatedAt: strOr(o.generatedAt),
    holdings: arr(o.holdings).map(mapHoldingAdvice),
  };
}

function mapDataQuality(v: unknown): AdvisorDataQuality {
  const o = rec(v);
  const sources: Record<string, number> = {};
  for (const [k, n] of Object.entries(rec(o.sources))) if (typeof n === 'number') sources[k] = n;
  return {
    sources,
    freshest: str(o.freshest),
    staleCount: int(o.staleCount) ?? 0,
    simulatedShare: dec(o.simulatedShare),
    missingFundamentalsCount: int(o.missingFundamentalsCount) ?? 0,
    coverageNote: strOr(o.coverageNote),
  };
}

function mapNotEnough(v: unknown): NotEnoughData | null {
  if (!v) return null;
  const o = rec(v);
  return {
    summary: strOr(o.summary),
    evaluated: int(o.evaluated) ?? 0,
    simulated: int(o.simulated) ?? 0,
    stale: int(o.stale) ?? 0,
    reasons: arr(o.reasons).map((r) => {
      const x = rec(r);
      return { reason: strOr(x.reason), count: int(x.count) ?? 0, symbols: strs(x.symbols) };
    }),
  };
}

function mapChange(v: unknown): ChangeEvent {
  const o = rec(v);
  return {
    kind: strOr(o.kind),
    symbol: strOr(o.symbol),
    horizon: strOr(o.horizon),
    from: str(o.from),
    to: str(o.to),
    detail: strOr(o.detail),
    date: str(o.date),
  };
}

function mapNews(v: unknown): AdvisorNewsItem {
  const o = rec(v);
  return {
    id: strOr(o.id),
    symbols: strs(o.symbols),
    affects: arr(o.affects).map((a) => {
      const x = rec(a);
      return { symbol: strOr(x.symbol), relation: x.relation === 'HELD' ? 'HELD' : 'WATCHED' };
    }),
    title: strOr(o.title),
    category: str(o.category),
    source: o.source ? mapSource(o.source) : null,
    sourceName: str(o.sourceName),
    url: str(o.url),
    publishedAt: strOr(o.publishedAt),
    sentiment: str(o.sentiment),
  };
}

export function mapDailyReport(v: unknown): DailyReport {
  const o = rec(v);
  const pf = rec(o.portfolio);
  const wc = rec(o.whatChanged);
  const ni = rec(o.newsImpact);
  const notEnoughData = mapNotEnough(o.notEnoughData);
  const report: DailyReport = {
    generatedAt: strOr(o.generatedAt),
    dataAsOf: str(o.dataAsOf),
    horizon: horizonOf(o.horizon),
    portfolio: {
      id: strOr(pf.id),
      name: strOr(pf.name),
      cash: dec(pf.cash) ?? '',
      equity: dec(pf.equity) ?? '',
    },
    dataQuality: mapDataQuality(o.dataQuality),
    headline: strOr(o.headline),
    notEnoughData,
    topBuys: arr(o.topBuys).map(mapEvaluation),
    avoidOrSell: arr(o.avoidOrSell).map(mapEvaluation),
    holds: arr(o.holds).map((h) => {
      const x = rec(h);
      return { symbol: strOr(x.symbol), headline: strOr(x.headline), unrealizedNet: dec(x.unrealizedNet) };
    }),
    opportunities: arr(o.opportunities).map(mapEvaluation),
    holdingsAdvice: arr(o.holdingsAdvice).map(mapHoldingAdvice),
    whatChanged: {
      baseline: wc.baseline === true,
      compared: int(wc.compared) ?? 0,
      events: arr(wc.events).map(mapChange),
      note: str(wc.note),
    },
    newsImpact: {
      windowHours: int(ni.windowHours) ?? 72,
      coverage: strOr(ni.coverage),
      lastUpdated: str(ni.lastUpdated),
      items: arr(ni.items).map(mapNews),
      note: str(ni.note),
    },
    portfolioNotes: arr(o.portfolioNotes).map((n): PortfolioNote => {
      const x = rec(n);
      return {
        kind: strOr(x.kind),
        severity: x.severity === 'WARN' ? 'WARN' : 'INFO',
        text: strOr(x.text),
      };
    }),
    disclaimer: strOr(o.disclaimer),
  };
  // The safety invariant: when the API says there is not enough verified data, no level, target or
  // recommendation card is ever passed on, whatever else the payload carried.
  if (notEnoughData) {
    report.topBuys = [];
    report.opportunities = [];
    report.avoidOrSell = [];
  }
  return report;
}

export function mapRunSummary(v: unknown): AdvisorRunSummary {
  const o = rec(v);
  return {
    portfolioId: strOr(o.portfolioId),
    runAt: strOr(o.runAt),
    universe: int(o.universe) ?? 0,
    skippedNoBars: int(o.skippedNoBars) ?? 0,
    evaluated: int(o.evaluated) ?? 0,
    stored: int(o.stored) ?? 0,
    alreadyStored: int(o.alreadyStored) ?? 0,
    actionable: int(o.actionable) ?? 0,
    notActionable: int(o.notActionable) ?? 0,
    failed: Array.isArray(o.failed) ? o.failed.length : (int(o.failed) ?? 0),
  };
}

export function mapScannerReport(v: unknown): ScannerReport {
  const o = rec(v);
  const filter = (SCANNER_FILTERS as readonly string[]).includes(o.filter as string)
    ? (o.filter as ScannerFilter)
    : 'undervalued';
  return {
    horizon: horizonOf(o.horizon),
    filter,
    generatedAt: strOr(o.generatedAt),
    universe: int(o.universe) ?? 0,
    verifiedEvaluations: int(o.verifiedEvaluations) ?? 0,
    results: arr(o.results).map((r, i): ScannerResult => {
      const x = rec(r);
      const m = rec(x.matched);
      return {
        rank: int(x.rank) ?? i + 1,
        symbol: strOr(x.symbol),
        name: str(x.name),
        sector: str(x.sector),
        action: ACTIONS.includes(x.action as string) ? (x.action as AdvisorAction) : null,
        headline: strOr(x.headline),
        confidence: dec(x.confidence),
        price: mapPrice(x.price),
        matched: { metric: strOr(m.metric), value: strOr(m.value), threshold: strOr(m.threshold) },
      };
    }),
    note: str(o.note),
  };
}

function mapRatio(v: unknown): RatioOutcome {
  const o = rec(v);
  const value = dec(o.value);
  if (o.status === 'OK' && value)
    return { status: 'OK', value, unit: strOr(o.unit), formula: strOr(o.formula), flags: strs(o.flags) };
  return { status: 'UNAVAILABLE', missing: strs(o.missing), reason: strOr(o.reason, 'unavailable') };
}

function mapTechnicals(v: unknown): StockTechnicals | null {
  if (!v) return null;
  const o = rec(v);
  const trend = rec(o.trend);
  const vol = rec(o.volume);
  const brk = rec(o.breakout);
  return {
    basis: strOr(o.basis),
    notice: str(o.notice),
    trend: {
      classification: strOr(trend.classification, 'UNKNOWN'),
      sma20: dec(trend.sma20),
      sma50: dec(trend.sma50),
      sma100: dec(trend.sma100),
      sma200: dec(trend.sma200),
      explanation: strs(trend.explanation),
    },
    rsi14: dec(o.rsi14),
    macdHistogram: dec(o.macdHistogram),
    atr14: dec(o.atr14),
    adxExplanation: strs(rec(o.adx).explanation),
    support: dec(o.support),
    resistance: dec(o.resistance),
    volume: {
      relativeVolume: dec(vol.relativeVolume),
      avgVolume20: dec(vol.avgVolume20),
      avgTradedValue20: dec(vol.avgTradedValue20),
      adTrend: str(vol.adTrend),
    },
    momentumScore: dec(o.momentumScore),
    breakout: { crossed: brk.crossed === true, confirmed: brk.confirmed === true },
  };
}

function mapValuation(v: unknown): StockValuation {
  const o = rec(v);
  return {
    status: o.status === 'OK' ? 'OK' : 'UNAVAILABLE',
    facts: arr(o.facts).flatMap((f) => {
      const x = rec(f);
      const value = dec(x.value);
      return value
        ? [
            {
              name: strOr(x.name),
              value,
              period: strOr(x.period),
              currency: strOr(x.currency),
              source: strOr(x.source),
            },
          ]
        : [];
    }),
    assumptions: arr(o.assumptions).map((a) => {
      const x = rec(a);
      return { name: strOr(x.name), value: strOr(x.value), basis: strOr(x.basis) };
    }),
    fairValueLow: dec(o.fairValueLow),
    fairValueHigh: dec(o.fairValueHigh),
    marginOfSafetyPct: dec(o.marginOfSafetyPct),
    explanation: strs(o.explanation),
    reason: str(o.reason),
  };
}

export function mapStockReport(v: unknown): StockReport {
  const o = rec(v);
  const ratios = rec(o.ratios);
  const hasRatios = ratios.status !== 'UNAVAILABLE' && Object.keys(ratios).length > 0;
  const ds = rec(o.dataSources);
  const bars = rec(ds.bars);
  const fund = rec(ds.fundamentals);
  const quote = rec(ds.quote);
  const recs: StockReport['recommendations'] = {};
  for (const [k, r] of Object.entries(rec(o.recommendations)))
    if ((ADVISOR_HORIZONS as readonly string[]).includes(k)) recs[k as AdvisorHorizon] = mapEvaluation(r);
  return {
    symbol: strOr(o.symbol),
    name: strOr(o.name),
    sector: str(o.sector),
    generatedAt: strOr(o.generatedAt),
    price: mapPrice(o.price),
    technicals: mapTechnicals(o.technicals),
    ratios: hasRatios ? Object.fromEntries(Object.entries(ratios).map(([k, r]) => [k, mapRatio(r)])) : null,
    ratiosReason: hasRatios ? null : str(ratios.reason),
    valuation: mapValuation(o.valuation),
    announcements: arr(o.announcements).map((a) => {
      const x = rec(a);
      return {
        id: strOr(x.id),
        title: strOr(x.title),
        category: str(x.category),
        publishedAt: strOr(x.publishedAt),
        source: x.source ? mapSource(x.source) : null,
        sourceName: str(x.sourceName),
        url: str(x.url),
      };
    }),
    recommendations: recs,
    dataSources: {
      bars: {
        count: int(bars.count) ?? 0,
        latestBarTs: str(bars.latestBarTs),
        latestBarSource: str(bars.latestBarSource),
        sources: strs(bars.sources),
      },
      quote: ds.quote ? { source: str(quote.source), asOf: str(quote.asOf) ?? str(quote.ts) } : null,
      fundamentals: ds.fundamentals
        ? {
            period: strOr(fund.period),
            publishedAt: strOr(fund.publishedAt),
            source: strOr(fund.source),
            peersUsed: int(fund.peersUsed) ?? 0,
          }
        : null,
      stale: ds.stale === true,
    },
  };
}

export function mapAdvisorSettings(v: unknown): AdvisorSettings {
  const o = rec(v);
  return { riskPerTradePct: dec(o.riskPerTradePct) ?? '1', isDefault: o.isDefault !== false };
}
