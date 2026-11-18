/**
 * Recommendation engine: evaluateStock (docs/12). Deterministic and pure: same input => same output.
 * Pipeline: input validation -> HARD GATES -> technical snapshot -> fundamentals/valuation -> rule table ->
 * action decision -> liquidity cap -> confidence check -> trade plan (BUY only) -> final confidence.
 * "No strong opportunity" (HOLD / WATCHLIST / NOT_ACTIONABLE) is a valid outcome.
 */
import { d, type Decimal, ZERO } from '../decimal.js';
import {
  annualEps,
  computeFundamentalRatios,
  type FundamentalsContext,
  type FundamentalsReport,
  statementProblem,
} from './fundamentals.js';
import { buildPlan } from './plan.js';
import {
  type Confidence,
  type ConfidenceComponent,
  type DataQualityReport,
  DEFAULT_RECOMMENDATION_CONFIG,
  DISCLAIMER,
  ENGINE_VERSION,
  type EvaluateStockInput,
  type Reason,
  type RecommendationConfig,
  type RuleOutcome,
  type RuleScores,
  SIMULATED_REASON,
  type StockEvaluation,
  type TradePlan,
} from './rec-types.js';
import {
  computeTechSnapshot,
  dividendRecordAnalysis,
  evaluateRules,
  scoreRules,
  type TechSnapshot,
} from './rules.js';
import {
  type Horizon,
  isFundamentalHorizon,
  type RecommendationAction,
  type ResearchBar,
  type ResearchDataSource,
} from './types.js';
import {
  earningsFairValue,
  gordonGrowth,
  peerMedianMultiples,
  simpleDcf,
  summariseValuation,
  type ValuationResult,
  type ValuationSummary,
} from './valuation.js';
import { clamp, fmt, minutesBetween, parseTs, tryParseTs } from './util.js';

export interface EvaluationRun {
  readonly evaluation: StockEvaluation;
  /** Present when the gates passed far enough to compute indicators. */
  readonly tech: TechSnapshot | null;
  /** The bars actually used (future bars removed). */
  readonly bars: readonly ResearchBar[];
  readonly cfg: RecommendationConfig;
}

const HUNDRED = d('100');
const NON_CONFIRMED: readonly ResearchDataSource[] = ['SIMULATED', 'ESTIMATED'];
const SOURCE_PENALTY: Record<ResearchDataSource, number> = {
  BROKER_CONFIRMED: 0,
  PROVIDER: 0,
  BROKER_DISPLAYED: 10,
  USER_REPORTED: 30,
  ESTIMATED: 70,
  SIMULATED: 100,
};

export function requiredBars(h: Horizon, cfg: RecommendationConfig): number {
  return h === 'SHORT_TERM' || h === 'SWING' ? cfg.minBarsShort : cfg.minBarsLong;
}

function validateBars(bars: readonly ResearchBar[]): string | null {
  let prev: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i] as ResearchBar;
    const ts = tryParseTs(b.ts);
    if (ts === null) return `bar ${i}: invalid timestamp ${b.ts}`;
    if (prev !== null && ts <= prev) return `bar ${i}: timestamps must be strictly ascending`;
    prev = ts;
    if (!b.open.gt(0) || !b.high.gt(0) || !b.low.gt(0) || !b.close.gt(0))
      return `bar ${i}: prices must be > 0`;
    if (
      b.high.lt(b.low) ||
      b.high.lt(b.open) ||
      b.high.lt(b.close) ||
      b.low.gt(b.open) ||
      b.low.gt(b.close)
    ) {
      return `bar ${i}: inconsistent OHLC`;
    }
    if (b.volume.isNeg()) return `bar ${i}: negative volume`;
  }
  return null;
}

function assertInputs(input: EvaluateStockInput): void {
  const { risk, portfolio } = input;
  if (!risk.riskPerTradePct.gt(0)) throw new RangeError('risk.riskPerTradePct must be > 0');
  if (!risk.maxPositionPct.gt(0)) throw new RangeError('risk.maxPositionPct must be > 0');
  if (!portfolio.equity.gt(0)) throw new RangeError('portfolio.equity must be > 0');
  if (portfolio.cash.isNeg() || portfolio.holdingQty.isNeg())
    throw new RangeError('portfolio cash/holdingQty must be >= 0');
  parseTs(input.asOf);
}

function emptyQuality(
  bars: readonly ResearchBar[],
  ignored: number,
  input: EvaluateStockInput,
  missing: string[],
  warnings: string[],
  fundSources: ResearchDataSource[],
): DataQualityReport {
  const last = bars.length > 0 ? (bars[bars.length - 1] as ResearchBar) : null;
  const priceTs = tryParseTs(input.marketData.priceAsOf);
  const age = priceTs !== null ? minutesBetween(input.marketData.priceAsOf, input.asOf) : null;
  const window = bars.slice(-60);
  return {
    sourcesUsed: [...new Set(bars.map((b) => b.source))].sort(),
    latestBarSource: last?.source ?? null,
    latestBarTs: last?.ts ?? null,
    barsUsed: bars.length,
    ignoredFutureBars: ignored,
    priceAgeMinutes: age,
    freshnessLimitMinutes: input.marketData.freshnessLimitMinutes,
    delayMinutes: input.marketData.delayMinutes ?? null,
    nonConfirmedBarsInWindow: window.filter((b) => NON_CONFIRMED.includes(b.source)).length,
    fundamentalsSources: [...new Set(fundSources)].sort(),
    missingInputs: missing,
    warnings,
  };
}

function notActionable(
  input: EvaluateStockInput,
  reasons: string[],
  dq: DataQualityReport,
  extra: Partial<Pick<StockEvaluation, 'rules' | 'scores' | 'fundamentals' | 'valuation'>> = {},
): StockEvaluation {
  return {
    engineVersion: ENGINE_VERSION,
    symbol: input.symbol,
    horizon: input.horizon,
    asOf: input.asOf,
    status: 'NOT_ACTIONABLE',
    action: null,
    headline: `Not actionable: ${reasons[0] ?? 'insufficient data'}`,
    notActionableReasons: reasons,
    reasons: [],
    invalidation: [],
    watchFor: [],
    warnings: dq.warnings,
    scores: extra.scores ?? null,
    rules: extra.rules ?? [],
    plan: null,
    confidence: null,
    valuation: extra.valuation ?? null,
    fundamentals: extra.fundamentals ?? null,
    dataQuality: dq,
    disclaimer: DISCLAIMER,
  };
}

function computeConfidence(args: {
  scores: RuleScores;
  action: RecommendationAction;
  avgTradedValue: Decimal | null;
  cfg: RecommendationConfig;
  dq: DataQualityReport;
  fundamentalsUserReported: boolean;
}): Confidence {
  const { scores, action, cfg, dq } = args;
  const dir = action === 'STRONG_BUY' || action === 'BUY';
  const bearish = action === 'SELL' || action === 'AVOID';
  const agreement = dir
    ? clamp(scores.bull.minus(scores.bear), ZERO, HUNDRED)
    : bearish
      ? clamp(scores.bear.minus(scores.bull), ZERO, HUNDRED)
      : clamp(HUNDRED.minus(scores.bull.gt(scores.bear) ? scores.bull : scores.bear), ZERO, HUNDRED);
  const liq =
    args.avgTradedValue === null
      ? ZERO
      : clamp(args.avgTradedValue.div(cfg.liquidityFloorTradedValue.times(4)).times(HUNDRED), ZERO, HUNDRED);

  const penalties: string[] = [];
  let q = HUNDRED;
  const latest = dq.latestBarSource;
  if (latest !== null && SOURCE_PENALTY[latest] > 0) {
    q = q.minus(SOURCE_PENALTY[latest]);
    penalties.push(`latest bar source ${latest}: -${SOURCE_PENALTY[latest]}`);
  }
  if (dq.delayMinutes !== null && dq.delayMinutes > 15) {
    q = q.minus(20);
    penalties.push(`feed delay ${dq.delayMinutes} min > 15: -20`);
  }
  if (dq.priceAgeMinutes !== null && dq.freshnessLimitMinutes > 0 && dq.priceAgeMinutes.gt(0)) {
    const stale = clamp(dq.priceAgeMinutes.div(dq.freshnessLimitMinutes).times(30), ZERO, d('30'));
    if (stale.gt(0)) {
      q = q.minus(stale);
      penalties.push(
        `price age ${fmt(dq.priceAgeMinutes, 0)} of ${dq.freshnessLimitMinutes} min allowed: -${fmt(stale)}`,
      );
    }
  }
  if (dq.nonConfirmedBarsInWindow > 0) {
    q = q.minus(20);
    penalties.push(`${dq.nonConfirmedBarsInWindow} SIMULATED/ESTIMATED bars in the last 60: -20`);
  }
  if (args.fundamentalsUserReported) {
    q = q.minus(10);
    penalties.push('fundamentals are USER_REPORTED: -10');
  }
  q = clamp(q, ZERO, HUNDRED);

  const mk = (
    name: ConfidenceComponent['name'],
    weight: number,
    score: Decimal,
    detail: string,
  ): ConfidenceComponent => ({
    name,
    weight,
    score,
    contribution: score.times(weight).div(HUNDRED),
    detail,
  });
  const components = [
    mk(
      'DATA_COVERAGE',
      30,
      scores.coveragePct,
      `${fmt(scores.coveragePct)}% of rule weight had its inputs available`,
    ),
    mk(
      'SIGNAL_AGREEMENT',
      30,
      agreement,
      dir
        ? `bull ${fmt(scores.bull)} - bear ${fmt(scores.bear)}`
        : bearish
          ? `bear ${fmt(scores.bear)} - bull ${fmt(scores.bull)}`
          : `100 - max(bull ${fmt(scores.bull)}, bear ${fmt(scores.bear)})`,
    ),
    mk(
      'LIQUIDITY',
      20,
      liq,
      args.avgTradedValue === null
        ? 'average traded value not available'
        : `avg traded value ${fmt(args.avgTradedValue, 0)} vs floor ${fmt(cfg.liquidityFloorTradedValue, 0)} (100 at 4x floor)`,
    ),
    mk(
      'DATA_QUALITY',
      20,
      q,
      penalties.length > 0 ? penalties.join('; ') : 'confirmed, fresh, undelayed data',
    ),
  ];
  let score = components.reduce((a, c) => a.plus(c.contribution), ZERO);
  const caps: string[] = [];
  if (latest === 'ESTIMATED' && score.gt(39)) {
    score = d('39');
    caps.push('latest bar is ESTIMATED: confidence capped at 39 (LOW)');
  }
  return { score, level: score.lt(40) ? 'LOW' : score.lt(70) ? 'MEDIUM' : 'HIGH', components, caps };
}

function decideAction(
  s: RuleScores,
  holding: boolean,
  cfg: RecommendationConfig,
): { action: RecommendationAction; why: string } {
  if (s.bear.gte(cfg.sellBearMin) && s.bull.lte(cfg.sellBullMax) && s.structuralBearPassed > 0) {
    return holding
      ? {
          action: 'SELL',
          why: `bear ${fmt(s.bear)} >= ${fmt(cfg.sellBearMin, 0)}, bull ${fmt(s.bull)} <= ${fmt(cfg.sellBullMax, 0)}, with ${s.structuralBearPassed} structural deterioration rule(s)`,
        }
      : {
          action: 'AVOID',
          why: `bearish structure (bear ${fmt(s.bear)}, bull ${fmt(s.bull)}); no position to sell`,
        };
  }
  if (s.bear.gte(cfg.avoidBearMin)) {
    return holding
      ? {
          action: 'HOLD',
          why: `bear ${fmt(s.bear)} is high but no structural deterioration; a temporary decline alone is not a sell reason`,
        }
      : { action: 'AVOID', why: `bear ${fmt(s.bear)} >= ${fmt(cfg.avoidBearMin, 0)}` };
  }
  if (s.bear.gte(cfg.avoidSoftBearMin) && s.bull.lt(cfg.avoidSoftBullMax)) {
    return holding
      ? {
          action: 'HOLD',
          why: `weak signals (bear ${fmt(s.bear)}, bull ${fmt(s.bull)}) without structural deterioration`,
        }
      : {
          action: 'AVOID',
          why: `bear ${fmt(s.bear)} >= ${fmt(cfg.avoidSoftBearMin, 0)} and bull ${fmt(s.bull)} < ${fmt(cfg.avoidSoftBullMax, 0)}`,
        };
  }
  if (s.bull.gte(cfg.strongBuyBullMin) && s.bear.lte(cfg.strongBuyBearMax)) {
    return {
      action: 'STRONG_BUY',
      why: `bull ${fmt(s.bull)} >= ${fmt(cfg.strongBuyBullMin, 0)} and bear ${fmt(s.bear)} <= ${fmt(cfg.strongBuyBearMax, 0)}`,
    };
  }
  if (s.bull.gte(cfg.buyBullMin) && s.bear.lte(cfg.buyBearMax)) {
    return {
      action: 'BUY',
      why: `bull ${fmt(s.bull)} >= ${fmt(cfg.buyBullMin, 0)} and bear ${fmt(s.bear)} <= ${fmt(cfg.buyBearMax, 0)}`,
    };
  }
  if (s.bull.gte(cfg.watchBullMin)) {
    return {
      action: 'WATCHLIST',
      why: `bull ${fmt(s.bull)} >= ${fmt(cfg.watchBullMin, 0)} but not enough for a BUY`,
    };
  }
  return { action: 'HOLD', why: `no strong opportunity (bull ${fmt(s.bull)}, bear ${fmt(s.bear)})` };
}

function buildReasons(rules: readonly RuleOutcome[]): Reason[] {
  return rules
    .filter((r) => r.status === 'PASS' && r.value !== null)
    .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => ({
      domain: r.domain,
      ruleId: r.id,
      supports: r.side === 'BULL' ? ('BULLISH' as const) : ('BEARISH' as const),
      text: `${r.label}: ${r.value} (threshold ${r.threshold})`,
      value: r.value as string,
      threshold: r.threshold,
    }));
}

function invalidationConditions(
  horizon: Horizon,
  tech: TechSnapshot,
  plan: TradePlan | null,
  cfg: RecommendationConfig,
): string[] {
  const out: string[] = [];
  if (plan) out.push(`Daily close at or below the stop-loss ${fmt(plan.stopLoss)}`);
  if (horizon === 'SHORT_TERM' || horizon === 'SWING') {
    if (tech.trend.sma50) out.push(`Daily close below SMA50 (${fmt(tech.trend.sma50)})`);
    out.push(`ADX turns bearish (-DI above +DI with ADX >= ${fmt(cfg.adxTrend, 0)})`);
  } else if (tech.trend.sma200) {
    out.push(`Daily close below SMA200 (${fmt(tech.trend.sma200)})`);
  }
  if (isFundamentalHorizon(horizon)) {
    out.push('Net margin turns negative in a newly published statement');
    out.push('Year-on-year revenue growth turns negative in a newly published statement');
  }
  if (horizon === 'DIVIDEND') out.push('A dividend cut, or a payout ratio above 100%');
  if (horizon === 'VALUE')
    out.push('Price rises above the conservative fair value (margin of safety below 0%)');
  if (horizon === 'GROWTH')
    out.push(`Revenue or EPS growth falls below ${fmt(cfg.growthHighPct, 0)}% year on year`);
  out.push('Any later price or statement that is stale or flagged SIMULATED/ESTIMATED voids this evaluation');
  return out;
}

/** Full evaluation plus the intermediate snapshot (used by evaluateHolding). */
export function runEvaluation(input: EvaluateStockInput): EvaluationRun {
  assertInputs(input);
  const cfg: RecommendationConfig = { ...DEFAULT_RECOMMENDATION_CONFIG, ...input.config };
  const asOfMs = parseTs(input.asOf);
  const horizon = input.horizon;
  const fundSources: ResearchDataSource[] = input.fundamentals ? [input.fundamentals.current.source] : [];

  // Look-ahead guard: ignore bars strictly after the decision time.
  const kept = input.bars.filter((b) => {
    const t = tryParseTs(b.ts);
    return t === null || t <= asOfMs;
  });
  const ignored = input.bars.length - kept.length;
  const warnings: string[] = [];
  if (ignored > 0) warnings.push(`${ignored} bar(s) after the decision time were ignored`);
  const missing: string[] = [];

  const last = kept.length > 0 ? (kept[kept.length - 1] as ResearchBar) : null;
  if (last === null) {
    const dq = emptyQuality(kept, ignored, input, ['price bars'], warnings, fundSources);
    return { evaluation: notActionable(input, ['no price bars supplied'], dq), tech: null, bars: kept, cfg };
  }

  // GATE 1 — simulated data is never investment evidence. No entry, stop, targets or size are produced.
  if (last.source === 'SIMULATED') {
    const dq = emptyQuality(
      kept,
      ignored,
      input,
      missing,
      [...warnings, 'latest bar is SIMULATED'],
      fundSources,
    );
    return { evaluation: notActionable(input, [SIMULATED_REASON], dq), tech: null, bars: kept, cfg };
  }

  const reasons: string[] = [];
  const bad = validateBars(kept);
  if (bad) reasons.push(`invalid bar data: ${bad}`);
  const need = requiredBars(horizon, cfg);
  if (kept.length < need) {
    reasons.push(`insufficient history: ${kept.length} daily bars, ${need} required for ${horizon}`);
    missing.push(`${need - kept.length} more daily bars`);
  }
  const priceTs = tryParseTs(input.marketData.priceAsOf);
  if (priceTs === null) reasons.push('price timestamp is invalid');
  else if (priceTs > asOfMs) reasons.push('price timestamp is after the decision time');
  else {
    const age = minutesBetween(input.marketData.priceAsOf, input.asOf);
    if (age.gt(input.marketData.freshnessLimitMinutes)) {
      reasons.push(
        `latest price is stale: ${fmt(age, 0)} minutes old, freshness limit ${input.marketData.freshnessLimitMinutes} minutes`,
      );
    }
  }
  const needsFundamentals = isFundamentalHorizon(horizon);
  if (needsFundamentals && !input.fundamentals) {
    reasons.push(`${horizon} requires fundamentals; none supplied`);
    missing.push('fundamentals');
  }
  if (reasons.length > 0) {
    return {
      evaluation: notActionable(
        input,
        reasons,
        emptyQuality(kept, ignored, input, missing, warnings, fundSources),
      ),
      tech: null,
      bars: kept,
      cfg,
    };
  }

  const tech = computeTechSnapshot(kept, cfg);

  // Fundamentals and valuation (only from supplied inputs).
  let fundReport: FundamentalsReport | null = null;
  let valuation: ValuationSummary | null = null;
  if (input.fundamentals) {
    const fb = input.fundamentals;
    const fctx: FundamentalsContext = {
      asOf: input.asOf,
      maxAgeDays: cfg.maxFundamentalAgeDays,
      annualiseQuarterly: cfg.annualiseQuarterly,
      maxPriceAgeDays: 7,
    };
    fundReport = computeFundamentalRatios(
      {
        current: fb.current,
        priorYear: fb.priorYear,
        priorQuarter: fb.priorQuarter,
        price: { value: last.close, currency: input.currency, source: last.source, asOf: last.ts },
        dividendHistory: input.dividendHistory,
      },
      fctx,
    );
    for (const u of fundReport.unavailable)
      missing.push(`${u.key}: ${u.missing.length > 0 ? u.missing.join(', ') : u.reason}`);
    const methods: ValuationResult[] = [];
    const peers = fb.peers ? peerMedianMultiples(fb.peers) : null;
    const justified =
      peers && peers.pe.status === 'OK'
        ? {
            value: peers.pe.median,
            basis: `median P/E of ${peers.pe.count} supplied peers (${peers.pe.symbols.join(', ')})`,
          }
        : (fb.valuation?.historicalPe ?? null);
    if (justified) {
      methods.push(
        earningsFairValue({
          annualEps: annualEps(fb.current, fctx),
          justifiedPe: justified,
          priceCurrency: input.currency,
        }),
      );
    }
    if (fb.valuation?.ddm) {
      methods.push(
        gordonGrowth({
          lastAnnualDps: fb.valuation.ddm.lastAnnualDps,
          growthPct: fb.valuation.ddm.growthPct,
          requiredReturnPct: fb.valuation.ddm.requiredReturnPct,
          growthBasis: fb.valuation.ddm.basis,
          requiredReturnBasis: fb.valuation.ddm.basis,
        }),
      );
    }
    if (fb.valuation?.dcf) methods.push(simpleDcf(fb.valuation.dcf));
    if (methods.length > 0) valuation = summariseValuation(last.close, input.currency, methods);
    else missing.push('valuation inputs (peer multiples, historical P/E, DDM or DCF assumptions)');
    if (needsFundamentals && fundReport.available.length === 0) {
      const dq = emptyQuality(kept, ignored, input, missing, warnings, fundSources);
      return {
        evaluation: notActionable(
          input,
          [
            `${horizon} requires usable fundamentals; none of the ratios could be computed (${
              statementProblem(fb.current, fctx) ??
              fundReport.unavailable
                .slice(0, 2)
                .map((u) => u.reason)
                .join(' | ')
            })`,
          ],
          dq,
          { fundamentals: fundReport },
        ),
        tech,
        bars: kept,
        cfg,
      };
    }
  }

  const rules = evaluateRules(horizon, {
    tech,
    fund: fundReport,
    val: valuation,
    divs: dividendRecordAnalysis(input.dividendHistory, input.asOf),
    cfg,
  });
  const scores = scoreRules(rules);
  const dq0 = emptyQuality(kept, ignored, input, missing, warnings, fundSources);
  if (scores.coveragePct.lt(cfg.minCoveragePct)) {
    return {
      evaluation: notActionable(
        input,
        [
          `insufficient evidence: only ${fmt(scores.coveragePct)}% of the rule weight had its inputs (minimum ${fmt(cfg.minCoveragePct, 0)}%)`,
        ],
        dq0,
        { rules, scores, fundamentals: fundReport, valuation },
      ),
      tech,
      bars: kept,
      cfg,
    };
  }

  const holding = input.portfolio.holdingQty.gt(0);
  let { action, why } = decideAction(scores, holding, cfg);
  const wnotes = [...warnings];
  const watchFor: string[] = [];
  const fundUserReported = fundSources.includes('USER_REPORTED');
  const conf = (a: RecommendationAction): Confidence =>
    computeConfidence({
      scores,
      action: a,
      avgTradedValue: tech.vol.avgTradedValue20,
      cfg,
      dq: dq0,
      fundamentalsUserReported: fundUserReported,
    });

  // Liquidity floor: caps BUY-class actions at WATCHLIST and always warns.
  const illiquid =
    tech.vol.avgTradedValue20 === null || tech.vol.avgTradedValue20.lt(cfg.liquidityFloorTradedValue);
  if (illiquid) {
    wnotes.push(
      `illiquid: average daily traded value ${tech.vol.avgTradedValue20 ? fmt(tech.vol.avgTradedValue20, 0) : 'n/a'} is below the floor ${fmt(cfg.liquidityFloorTradedValue, 0)}; exits may be hard and prices may gap`,
    );
  }
  if (dq0.nonConfirmedBarsInWindow > 0)
    wnotes.push(`${dq0.nonConfirmedBarsInWindow} SIMULATED/ESTIMATED bars in the last 60 daily bars`);
  if (last.source === 'ESTIMATED')
    wnotes.push('latest bar is ESTIMATED, not a confirmed market price; confidence is capped LOW');
  if (dq0.delayMinutes !== null && dq0.delayMinutes > 15)
    wnotes.push(`feed is delayed ${dq0.delayMinutes} minutes`);

  const isBuy = (a: RecommendationAction): boolean => a === 'STRONG_BUY' || a === 'BUY';
  if (isBuy(action) && illiquid) {
    action = 'WATCHLIST';
    why += '; capped at WATCHLIST by the liquidity floor';
  }
  if (isBuy(action)) {
    const c = conf(action);
    if (c.score.lt(cfg.buyConfidenceMin)) {
      action = 'WATCHLIST';
      why += `; confidence ${fmt(c.score)} < ${fmt(cfg.buyConfidenceMin, 0)} required for a BUY`;
    } else if (action === 'STRONG_BUY' && c.score.lt(cfg.strongBuyConfidenceMin)) {
      action = 'BUY';
      why += `; downgraded from STRONG_BUY: confidence ${fmt(c.score)} < ${fmt(cfg.strongBuyConfidenceMin, 0)}`;
    }
  }
  if (isBuy(action) && tech.atr !== null && tech.trend.sma20 !== null) {
    const ext = tech.close.minus(tech.trend.sma20).div(tech.atr);
    if (ext.gt(cfg.extensionAtr)) {
      action = 'WATCHLIST';
      why += `; price is extended ${fmt(ext)} ATR above SMA20 (limit ${fmt(cfg.extensionAtr)}); wait for a pullback`;
      watchFor.push(`price back within ${fmt(cfg.extensionAtr)} ATR of SMA20 (${fmt(tech.trend.sma20)})`);
    }
  }

  let plan: TradePlan | null = null;
  if (isBuy(action)) {
    const built = buildPlan({ tech, horizon, cfg, portfolio: input.portfolio, risk: input.risk, valuation });
    if ('blocked' in built) {
      action = 'WATCHLIST';
      why += `; no executable plan: ${built.blocked}`;
    } else {
      const t2 = built.plan.targets[1];
      const rr = t2 ? t2.riskReward : ZERO;
      if (rr.lt(cfg.minRiskReward)) {
        action = 'WATCHLIST';
        why += `; risk:reward to Target 2 is ${fmt(rr)}, below the ${fmt(cfg.minRiskReward)} minimum`;
        watchFor.push(`a setup with risk:reward >= ${fmt(cfg.minRiskReward)} to Target 2`);
      } else {
        if (action === 'STRONG_BUY' && rr.lt(cfg.strongRiskReward)) {
          action = 'BUY';
          why += `; downgraded from STRONG_BUY: risk:reward to Target 2 ${fmt(rr)} < ${fmt(cfg.strongRiskReward)}`;
        }
        plan = built.plan;
      }
    }
  }

  const failedBull = rules
    .filter((r) => r.side === 'BULL' && r.status === 'FAIL')
    .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 3);
  if (action === 'WATCHLIST') {
    for (const r of failedBull) watchFor.push(`${r.label} (${r.threshold}; now ${r.value ?? 'n/a'})`);
  }
  if (action === 'HOLD' && !holding) wnotes.push('no strong opportunity: staying out is the recommendation');

  const confidence = conf(action);
  const headline = `${action}: ${why}`;
  return {
    evaluation: {
      engineVersion: ENGINE_VERSION,
      symbol: input.symbol,
      horizon,
      asOf: input.asOf,
      status: 'ACTIONABLE',
      action,
      headline,
      notActionableReasons: [],
      reasons: buildReasons(rules),
      invalidation: invalidationConditions(horizon, tech, plan, cfg),
      watchFor,
      warnings: wnotes,
      scores,
      rules,
      plan,
      confidence,
      valuation,
      fundamentals: fundReport,
      dataQuality: { ...dq0, warnings: wnotes },
      disclaimer: DISCLAIMER,
    },
    tech,
    bars: kept,
    cfg,
  };
}

export function evaluateStock(input: EvaluateStockInput): StockEvaluation {
  return runEvaluation(input).evaluation;
}

export const ALL_HORIZONS_ORDER: readonly Horizon[] = [
  'SHORT_TERM',
  'SWING',
  'LONG_TERM',
  'DIVIDEND',
  'VALUE',
  'GROWTH',
];

/** Evaluate every horizon independently (each applies its own gates). */
export function evaluateAllHorizons(
  input: Omit<EvaluateStockInput, 'horizon'>,
): Record<Horizon, StockEvaluation> {
  const out = {} as Record<Horizon, StockEvaluation>;
  for (const h of ALL_HORIZONS_ORDER) out[h] = evaluateStock({ ...input, horizon: h });
  return out;
}
