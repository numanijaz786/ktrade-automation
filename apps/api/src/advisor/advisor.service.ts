import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ACTIONS,
  computeFundamentalRatios,
  computeTechSnapshot,
  computeTradeFees,
  DEFAULT_RECOMMENDATION_CONFIG,
  type Decimal,
  d,
  evaluateHolding,
  evaluateStock,
  type FundamentalsContext,
  type Horizon,
  HORIZONS,
  HUNDRED,
  rankOpportunities,
  RATIO_KEYS,
  ratioValue,
  round,
  type StockEvaluation,
  type HoldingEvaluation,
  ZERO,
} from '@ktrade/finance-core';
import type { RecordRecommendationInput } from '../recommendations/recommendations.schemas.js';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { pktDateOf } from '../market-data/calendar.js';
import { fromDb } from '../market-data/decimal-format.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RecommendationsStore } from '../recommendations/recommendations.store.js';
import { PerformanceService } from '../snapshots/performance.service.js';
import { type ChangeEvent, diffRecommendation, recInfo } from './advisor-changes.js';
import {
  AdvisorDataService,
  type AdvisorContext,
  type HoldingFact,
  type StockBundle,
} from './advisor-data.service.js';
import {
  type DailyReportQuery,
  type HoldingsQuery,
  type RunAdvisorInput,
  type ScannerFilter,
  type ScannerQuery,
  type StockQuery,
} from './advisor.schemas.js';
import { evaluationView, jsonSafe, num, plain, priceView } from './advisor.views.js';
import { LlmExplainer, TemplateExplainer } from './explanation.js';

const NEWS_WINDOW_HOURS = 72;
const COVERAGE_NOTE = 'sources: owner-entered only';
const UNUSUAL_VOLUME_X = d('2');
const BUY_CLASS = new Set(['STRONG_BUY', 'BUY']);

const round2 = (x: Decimal): string => round(x, 2, 'HALF_EVEN').toFixed(2);
const bearWeight = (ev: StockEvaluation): Decimal => ev.scores?.bear ?? ZERO;

export interface RunSummary {
  portfolioId: string;
  runAt: string;
  horizons: readonly Horizon[];
  universe: number;
  skippedNoBars: number;
  evaluated: number;
  stored: number;
  alreadyStored: number;
  actionable: number;
  notActionable: number;
  byAction: Record<string, number>;
  failed: { symbol: string; horizon: string; error: string }[];
}

@Injectable()
export class AdvisorService {
  constructor(
    private readonly data: AdvisorDataService,
    private readonly prisma: PrismaService,
    private readonly store: RecommendationsStore,
    private readonly audit: AuditService,
    private readonly explainer: TemplateExplainer,
    private readonly llm: LlmExplainer,
    private readonly performance: PerformanceService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── run (persist) ─────────────

  async run(
    userId: string,
    input: RunAdvisorInput,
    actor: 'USER' | 'SYSTEM' = 'USER',
    meta: RequestMeta = {},
  ): Promise<RunSummary> {
    const ctx = await this.data.load(userId, input.portfolioId);
    const horizons = input.horizons ?? HORIZONS;
    const universe = ctx.bundles.filter((b) => b.input !== null);
    const s: RunSummary = {
      portfolioId: input.portfolioId,
      runAt: ctx.now.toISOString(),
      horizons,
      universe: ctx.bundles.length,
      skippedNoBars: ctx.bundles.length - universe.length,
      evaluated: 0,
      stored: 0,
      alreadyStored: 0,
      actionable: 0,
      notActionable: 0,
      byAction: {},
      failed: [],
    };
    for (const horizon of horizons) {
      for (const b of universe) {
        const ev = evaluateStock({ ...(b.input as NonNullable<StockBundle['input']>), horizon });
        s.evaluated++;
        if (ev.status === 'ACTIONABLE') s.actionable++;
        else s.notActionable++;
        const key = ev.action ?? 'NOT_ACTIONABLE';
        s.byAction[key] = (s.byAction[key] ?? 0) + 1;
        try {
          const res = await this.store.record(this.toRecord(userId, ctx, b, ev));
          if (res.created) s.stored++;
          else s.alreadyStored++;
        } catch (e) {
          s.failed.push({ symbol: b.stock.symbol, horizon, error: (e as Error).message.slice(0, 200) });
        }
      }
    }
    await this.audit.record({
      action: 'advisor.run',
      actorType: actor,
      actorUserId: userId,
      entityType: 'portfolio',
      entityId: input.portfolioId,
      after: { ...s, failed: s.failed.length },
      ...meta,
    });
    return s;
  }

  private toRecord(
    userId: string,
    ctx: AdvisorContext,
    b: StockBundle,
    ev: StockEvaluation,
  ): RecordRecommendationInput {
    const last = b.lastBar!;
    const plan = ev.plan;
    const px = (x: Decimal) => round(x, 6, 'HALF_EVEN').toFixed();
    const t = plan?.targets ?? [];
    // The ledger's `ACTIONABLE` means "a trade idea with levels"; the engine's own status/action live in components.
    const rr = t[1]?.riskReward ?? null;
    return {
      userId,
      symbol: b.stock.symbol,
      horizon: ev.horizon,
      action:
        ev.action === 'STRONG_BUY' || ev.action === null ? (ev.action === null ? 'HOLD' : 'BUY') : ev.action,
      status: plan ? 'ACTIONABLE' : 'NOT_ACTIONABLE',
      generatedAt: ctx.now,
      asOfBar: b.asOfBar as string,
      price: px(last.close),
      priceSource: last.source,
      ...(plan
        ? {
            entryLow: px(plan.entryLow),
            entryHigh: px(plan.entryHigh),
            stop: px(plan.stopLoss),
            target1: t[0] ? px(t[0].price) : undefined,
            target2: t[1] ? px(t[1].price) : undefined,
            target3: t[2] ? px(t[2].price) : undefined,
            riskReward: rr && rr.gt(0) ? round(rr, 4, 'HALF_EVEN').toFixed() : undefined,
            holdingPeriod: plan.holdingPeriod.label,
            holdingDaysMax: Math.min(3650, Math.ceil((plan.holdingPeriod.maxTradingDays * 7) / 5)),
          }
        : {}),
      confidence: ev.confidence ? round(ev.confidence.score, 2, 'HALF_EVEN').toFixed(2) : '0',
      confidenceLevel: ev.confidence?.level ?? 'LOW',
      components: jsonSafe({
        engineAction: ev.action,
        engineStatus: ev.status,
        headline: ev.headline,
        scores: ev.scores,
        confidence: ev.confidence,
        notActionableReasons: ev.notActionableReasons,
        warnings: ev.warnings,
        watchFor: ev.watchFor,
        sizing: plan
          ? {
              quantity: plan.quantity,
              allocationPct: plan.allocationPct,
              maxLoss: plan.maxLoss,
              fees: plan.estimatedBuyFees,
            }
          : null,
      }) as never,
      reasons: jsonSafe(ev.reasons) as never,
      invalidations: jsonSafe(ev.invalidation) as never,
      dataQuality: jsonSafe(ev.dataQuality) as never,
      engineVersion: ev.engineVersion,
      inputsSnapshot: jsonSafe({
        portfolioId: ctx.portfolio.id,
        decisionTime: ev.asOf,
        barsUsed: ev.dataQuality.barsUsed,
        lastBar: { ts: last.ts, source: last.source },
        quote: b.quote,
        fundamentals: b.fundamentals
          ? {
              period: b.fundamentals.current.period,
              publishedAt: b.fundamentals.current.publishedAt,
              source: b.fundamentals.current.source,
              peers: b.fundamentals.peers?.length ?? 0,
            }
          : null,
        cash: ctx.cash,
        equity: ctx.equity,
        holdingQty: b.holding?.qty ?? ZERO,
        riskPerTradePct: ctx.riskPerTradePct,
        maxPositionPct: ctx.maxPositionPct,
      }) as never,
    };
  }

  // ───────────── daily report ─────────────

  async dailyReport(userId: string, q: DailyReportQuery) {
    const ctx = await this.data.load(userId, q.portfolioId);
    const horizon = q.horizon;
    const universe = ctx.bundles.filter((b) => b.input !== null);
    const bySymbol = new Map(universe.map((b) => [b.stock.symbol, b]));
    const scan = rankOpportunities(
      universe.map((b) => b.input as NonNullable<StockBundle['input']>),
      horizon,
      { actions: ACTIONS },
    );
    const view = (ev: StockEvaluation) =>
      evaluationView(ev, this.explainer.explain(ev), bySymbol.get(ev.symbol));
    const buys = scan.ranked.filter((r) => r.evaluation.action && BUY_CLASS.has(r.evaluation.action));
    const topBuys = buys.slice(0, 5).map((r) => view(r.evaluation));
    const opportunities = buys.slice(0, 20).map((r, i) => ({ rank: i + 1, ...view(r.evaluation) }));
    const avoidOrSell = scan.ranked
      .filter((r) => r.evaluation.action === 'SELL' || r.evaluation.action === 'AVOID')
      .sort(
        (a, b) => bearWeight(b.evaluation).cmp(bearWeight(a.evaluation)) || (a.symbol < b.symbol ? -1 : 1),
      )
      .slice(0, 5)
      .map((r) => view(r.evaluation));

    const holdingsAdvice = await this.holdingsAdvice(userId, ctx, horizon);
    const holds = holdingsAdvice
      .filter((h) => h.advice === 'CONTINUE_HOLDING')
      .map((h) => ({ symbol: h.symbol, headline: h.headline, unrealizedNet: h.pnl?.unrealizedNet ?? null }));

    // data quality
    const sources: Record<string, number> = {};
    for (const b of universe) sources[b.lastBar!.source] = (sources[b.lastBar!.source] ?? 0) + 1;
    const freshest = universe.reduce<string | null>(
      (m, b) => (m === null || b.lastBar!.ts > m ? b.lastBar!.ts : m),
      null,
    );
    const simulated = universe.filter((b) => b.lastBar!.source === 'SIMULATED').length;
    const staleCount = universe.filter((b) => b.stale).length;
    const missingFundamentalsCount = universe.filter((b) => !b.hasFundamentals).length;
    const verified =
      scan.evaluated - scan.excluded.filter((e) => e.reason.startsWith('NOT_ACTIONABLE')).length;
    const simulatedShare =
      universe.length > 0 ? round2(d(String(simulated)).div(String(universe.length)).times(HUNDRED)) : null;

    // why nothing is evaluable
    const groups = new Map<string, { reason: string; count: number; symbols: string[] }>();
    for (const e of scan.excluded) {
      const reason = e.reason.replace(/^NOT_ACTIONABLE: /, '');
      const key = reason.replace(/\d+(\.\d+)?/g, '#');
      const g = groups.get(key) ?? { reason, count: 0, symbols: [] };
      g.count++;
      if (g.symbols.length < 5) g.symbols.push(e.symbol);
      groups.set(key, g);
    }
    const notEnoughData = verified === 0;
    const headline = notEnoughData
      ? 'Not enough verified data to recommend anything'
      : buys.length === 0
        ? 'No strong buying opportunity today'
        : `${buys.length} buy candidate${buys.length === 1 ? '' : 's'} today; the best ranked is ${buys[0]!.symbol}`;

    const whatChanged = await this.whatChanged(
      userId,
      universe,
      scan.ranked.map((r) => r.evaluation),
      horizon,
    );
    const newsImpact = await this.newsImpact(userId, ctx);
    const portfolioNotes = await this.portfolioNotes(userId, ctx, holdingsAdvice, topBuys);

    return {
      generatedAt: ctx.now.toISOString(),
      dataAsOf: freshest ? pktDateOf(new Date(freshest)) : null,
      horizon,
      portfolio: {
        id: ctx.portfolio.id,
        name: ctx.portfolio.name,
        cash: num(ctx.cash, 2),
        equity: num(ctx.equity, 2),
      },
      dataQuality: {
        sources,
        freshest,
        staleCount,
        simulatedShare,
        missingFundamentalsCount,
        coverageNote:
          `${universe.length} stocks have stored daily bars (${ctx.bundles.length - universe.length} have none); ` +
          `${verified} could be evaluated on verified, fresh data; ${simulated} use SIMULATED prices; ${staleCount} are stale; ` +
          `${missingFundamentalsCount} have no stored financial statements (long-term, dividend, value and growth views need them). ` +
          `News is owner-entered only.`,
      },
      headline,
      notEnoughData: notEnoughData
        ? {
            summary: `None of the ${universe.length} stocks could be evaluated on verified data: ${simulated} are SIMULATED, ${staleCount} are stale. No target, entry or stop is given for any of them.`,
            evaluated: universe.length,
            simulated,
            stale: staleCount,
            reasons: [...groups.values()].sort((a, b) => b.count - a.count),
          }
        : null,
      topBuys,
      avoidOrSell,
      holds,
      opportunities,
      holdingsAdvice,
      whatChanged,
      newsImpact,
      portfolioNotes,
      disclaimer:
        'Research aid generated by deterministic rules from stored data. Not financial advice; no return is guaranteed. Execution is always a separate, human-approved step.',
    };
  }

  private async whatChanged(
    userId: string,
    universe: readonly StockBundle[],
    evals: readonly StockEvaluation[],
    horizon: Horizon,
  ) {
    const ids = universe.map((b) => b.stock.id);
    const rows = ids.length
      ? await this.prisma.recommendation.findMany({
          where: { userId, horizon, stockId: { in: ids } },
          orderBy: [{ asOfBar: 'desc' }, { generatedAt: 'desc' }],
          include: { stock: { select: { symbol: true } } },
        })
      : [];
    const evBy = new Map(evals.map((e) => [e.symbol, e]));
    const events: ChangeEvent[] = [];
    let compared = 0;
    for (const b of universe) {
      const cur = b.asOfBar as string;
      const prevRow = rows.find(
        (r) => r.stockId === b.stock.id && r.asOfBar.toISOString().slice(0, 10) < cur,
      );
      if (!prevRow) continue;
      compared++;
      const ev = evBy.get(b.stock.symbol);
      events.push(
        ...diffRecommendation(
          recInfo(prevRow),
          ev
            ? { engineStatus: 'ACTIONABLE', engineAction: ev.action }
            : {
                engineStatus: 'NOT_ACTIONABLE',
                engineAction: null,
                reason: 'not evaluable on verified data',
              },
          b.bars,
        ),
      );
    }
    return {
      baseline: compared > 0,
      compared,
      events,
      note:
        compared === 0
          ? 'No earlier stored recommendation for this horizon to compare with: run POST /advisor/run on consecutive bars to build a history.'
          : undefined,
    };
  }

  private async newsImpact(userId: string, ctx: AdvisorContext) {
    const cutoff = new Date(ctx.now.getTime() - NEWS_WINDOW_HOURS * 3_600_000);
    const watched = await this.prisma.watchlistStock.findMany({
      where: { watchlist: { userId } },
      select: { stock: { select: { symbol: true } } },
    });
    const held = new Set(ctx.holdings.map((h) => h.symbol));
    const watchSet = new Set(watched.map((w) => w.stock.symbol));
    const [rows, latest] = await Promise.all([
      this.prisma.announcement.findMany({
        where: { publishedAt: { gte: cutoff, lte: ctx.now } },
        include: { stock: { select: { symbol: true } } },
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      }),
      this.prisma.announcement.aggregate({ _max: { retrievedAt: true } }),
    ]);
    const items = rows.flatMap((r) => {
      const symbols = [...new Set([...(r.stock ? [r.stock.symbol] : []), ...r.symbols])];
      const affects = symbols.flatMap((s): { symbol: string; relation: 'HELD' | 'WATCHED' }[] =>
        held.has(s)
          ? [{ symbol: s, relation: 'HELD' as const }]
          : watchSet.has(s)
            ? [{ symbol: s, relation: 'WATCHED' as const }]
            : [],
      );
      return affects.length === 0
        ? []
        : [
            {
              id: r.id,
              symbols,
              affects,
              title: r.title,
              category: r.category,
              source: r.source,
              sourceName: r.sourceName,
              url: r.url,
              publishedAt: r.publishedAt.toISOString(),
              sentiment: r.sentiment,
              sentimentSource: r.sentimentSource,
            },
          ];
    });
    return {
      windowHours: NEWS_WINDOW_HOURS,
      coverage: COVERAGE_NOTE,
      lastUpdated: latest._max.retrievedAt?.toISOString() ?? null,
      items,
      note:
        items.length === 0
          ? `No announcements for held or watched symbols in the last ${NEWS_WINDOW_HOURS} hours.`
          : undefined,
    };
  }

  private async portfolioNotes(
    userId: string,
    ctx: AdvisorContext,
    holdingsAdvice: readonly {
      symbol: string;
      marketValue: string | null;
      price: { source: string } | null;
    }[],
    topBuys: readonly { symbol: string; plan: { size: { estimatedCost: string } } | null }[],
  ) {
    const notes: { kind: string; severity: 'INFO' | 'WARN'; text: string }[] = [];
    for (const h of holdingsAdvice) {
      if (h.marketValue === null) continue;
      const w = d(h.marketValue).div(ctx.equity).times(HUNDRED);
      if (w.gt(ctx.maxPositionPct))
        notes.push({
          kind: 'POSITION_CONCENTRATION',
          severity: 'WARN',
          text: `${h.symbol} is ${round2(w)}% of the portfolio, above your single-stock limit of ${num(ctx.maxPositionPct, 2)}%. Do not add to it.`,
        });
    }
    for (const [sector, pctv] of ctx.sectorExposure) {
      notes.push({
        kind: 'SECTOR_EXPOSURE',
        severity: pctv.gt(ctx.maxSectorPct) ? 'WARN' : 'INFO',
        text: pctv.gt(ctx.maxSectorPct)
          ? `${sector} is ${round2(pctv)}% of the portfolio, above the ${num(ctx.maxSectorPct, 0)}% sector guideline.`
          : `${sector} is ${round2(pctv)}% of the portfolio (guideline ${num(ctx.maxSectorPct, 0)}%).`,
      });
    }
    const cashPct = ctx.cash.div(ctx.equity).times(HUNDRED);
    const planned = topBuys.reduce((a, b) => a.plus(b.plan ? d(b.plan.size.estimatedCost) : ZERO), ZERO);
    notes.push({
      kind: 'CASH_ALLOCATION',
      severity: planned.gt(ctx.cash) ? 'WARN' : 'INFO',
      text:
        `Cash available is ${round2(ctx.cash)} (${round2(cashPct)}% of the portfolio).` +
        (topBuys.length > 0
          ? ` The top buy ideas would cost ${round2(planned)} in total${planned.gt(ctx.cash) ? ', more than your cash: choose by rank' : ''}.`
          : ' There are no buy ideas to allocate it to.'),
    });
    try {
      const perf = await this.performance.performance(userId, ctx.portfolio.id, 'ALL');
      notes.push({
        kind: 'DRAWDOWN',
        severity: 'INFO',
        text: perf.maxDrawdown
          ? `Maximum drawdown so far is ${perf.maxDrawdown.valuePct}% (peak ${perf.maxDrawdown.peakDate}, trough ${perf.maxDrawdown.troughDate}).`
          : 'Drawdown is unavailable: there are no portfolio snapshots yet.',
      });
    } catch {
      notes.push({ kind: 'DRAWDOWN', severity: 'INFO', text: 'Drawdown is unavailable.' });
    }
    if (ctx.unpricedHoldings.length > 0)
      notes.push({
        kind: 'UNPRICED_HOLDINGS',
        severity: 'WARN',
        text: `No stored price for ${ctx.unpricedHoldings.join(', ')}: they are excluded from portfolio value.`,
      });
    if (holdingsAdvice.some((h) => h.price?.source === 'SIMULATED'))
      notes.push({
        kind: 'SIMULATED_PRICES',
        severity: 'WARN',
        text: 'Some holdings are valued on SIMULATED prices: the profit and loss shown is for testing only.',
      });
    return notes;
  }

  // ───────────── holdings ─────────────

  async holdings(userId: string, q: HoldingsQuery) {
    const ctx = await this.data.load(userId, q.portfolioId);
    const advice = await this.holdingsAdvice(userId, ctx, q.horizon);
    return {
      portfolioId: q.portfolioId,
      horizon: q.horizon,
      generatedAt: ctx.now.toISOString(),
      holdings: advice,
    };
  }

  private async holdingsAdvice(userId: string, ctx: AdvisorContext, horizon: Horizon) {
    const plans = ctx.holdings.length
      ? await this.prisma.recommendation.findMany({
          where: {
            userId,
            horizon,
            status: 'ACTIONABLE',
            stockId: { in: ctx.holdings.map((h) => h.stockId) },
          },
          orderBy: [{ asOfBar: 'desc' }, { generatedAt: 'desc' }],
          include: { stock: { select: { symbol: true } } },
        })
      : [];
    const out = [];
    for (const h of ctx.holdings) {
      const b = ctx.bundles.find((x) => x.stock.id === h.stockId) as StockBundle;
      out.push(this.holdingView(ctx, h, b, horizon, plans.find((p) => p.stockId === h.stockId) ?? null));
    }
    return out;
  }

  private holdingView(
    ctx: AdvisorContext,
    h: HoldingFact,
    b: StockBundle,
    horizon: Horizon,
    plan: Awaited<ReturnType<PrismaService['recommendation']['findFirst']>> | null,
  ) {
    const price = priceView(b);
    const targets = plan
      ? [plan.target1, plan.target2, plan.target3].filter((t) => t !== null).map((t) => fromDb(t!))
      : [];
    const storedStop = plan?.stop ? fromDb(plan.stop) : null;
    let ev: HoldingEvaluation | null = null;
    if (b.input && h.avgCost.gt(0)) {
      try {
        ev = evaluateHolding({
          ...b.input,
          horizon,
          position: {
            qty: h.qty,
            avgCost: h.avgCost,
            realizedPnl: h.realizedPnl,
            dividendsReceived: h.dividendsReceived,
            stopLoss: storedStop,
            targets,
          },
        });
      } catch {
        ev = null;
      }
    }
    // P&L facts are always present when any stored price exists; they carry the price's own source.
    const pnl = ev?.pnl ?? null;
    let marketValue: Decimal | null = null;
    let factsOnly = null as null | Record<string, string | null>;
    if (b.lastBar) {
      const last = b.lastBar.close;
      marketValue = h.qty.times(last);
      if (!pnl) {
        const fees = computeTradeFees(ctx.feeSchedule, { side: 'SELL', quantity: h.qty, price: last }).total;
        const gross = marketValue.minus(h.qty.times(h.avgCost));
        const net = gross.minus(fees);
        const cost = h.qty.times(h.avgCost);
        const total = net.plus(h.realizedPnl).plus(h.dividendsReceived);
        factsOnly = {
          lastPrice: num(last),
          costBasis: num(cost, 2),
          marketValue: num(marketValue, 2),
          unrealizedGross: num(gross, 2),
          estimatedSellFees: num(fees, 2),
          unrealizedNet: num(net, 2),
          unrealizedNetPct: cost.gt(0) ? num(net.div(cost).times(HUNDRED), 2) : null,
          realizedPnl: num(h.realizedPnl, 2),
          dividendsReceived: num(h.dividendsReceived, 2),
          totalReturn: num(total, 2),
          totalReturnPct: cost.gt(0) ? num(total.div(cost).times(HUNDRED), 2) : null,
        };
      }
    }
    const pnlView = pnl
      ? {
          lastPrice: num(pnl.lastPrice),
          costBasis: num(pnl.costBasis, 2),
          marketValue: num(pnl.marketValue, 2),
          unrealizedGross: num(pnl.unrealizedGross, 2),
          estimatedSellFees: num(pnl.estimatedSellFees, 2),
          unrealizedNet: num(pnl.unrealizedNet, 2),
          unrealizedNetPct: pnl.unrealizedNetPct ? num(pnl.unrealizedNetPct, 2) : null,
          realizedPnl: num(pnl.realizedPnl, 2),
          dividendsReceived: num(pnl.dividendsReceived, 2),
          totalReturn: num(pnl.totalReturn, 2),
          totalReturnPct: pnl.totalReturnPct ? num(pnl.totalReturnPct, 2) : null,
          feesAware: true,
          priceSource: price?.source ?? null,
        }
      : factsOnly
        ? { ...factsOnly, feesAware: true, priceSource: price?.source ?? null }
        : null;
    const sellTargets = targets.length > 0 ? targets : [];
    return {
      symbol: h.symbol,
      name: h.name,
      sector: h.sector,
      quantity: h.qty.toFixed(),
      avgCost: num(h.avgCost, 6),
      price,
      marketValue: marketValue ? num(marketValue, 2) : null,
      pnl: pnlView,
      status: ev?.status ?? 'NOT_ACTIONABLE',
      advice: ev?.advice ?? null,
      headline:
        ev?.headline ??
        (b.input
          ? 'No holding advice: the position could not be evaluated'
          : 'No holding advice: no stored prices'),
      notActionableReasons: ev?.notActionableReasons ?? (b.input ? [] : ['no stored daily bars']),
      reasons: ev?.reasons ?? [],
      suggestedSellQty: ev?.suggestedSellQty ? ev.suggestedSellQty.toFixed(0) : null,
      stop: ev?.stopLoss ? { price: num(ev.stopLoss.price), origin: ev.stopLoss.origin } : null,
      targets: sellTargets.map((t, i) => ({ n: i + 1, price: num(t) })),
      targetsReached: ev?.targetsReached ?? 0,
      sellRange:
        sellTargets.length > 0
          ? {
              low: num(sellTargets[0] as Decimal),
              high: num(sellTargets[sellTargets.length - 1] as Decimal),
              basis: `targets of the stored ${horizon} plan from ${plan!.asOfBar.toISOString().slice(0, 10)}`,
            }
          : null,
      planNote: plan
        ? null
        : 'No stored BUY plan for this stock and horizon, so no targets are shown and the stop (if any) is an ATR suggestion.',
      invalidations: ev?.stockEvaluation.invalidation ?? [],
      feesConsidered: pnlView
        ? { estimatedSellFees: pnlView.estimatedSellFees, schedule: 'effective KTrade fee schedule' }
        : null,
      dividendsConsidered: num(h.dividendsReceived, 2),
      warnings: ev?.warnings ?? [],
      explanation: ev ? this.explainer.explain(ev.stockEvaluation) : null,
    };
  }

  // ───────────── scanner ─────────────

  async scanner(userId: string, q: ScannerQuery) {
    const portfolioId = q.portfolioId ?? (await this.data.defaultPortfolioId(userId));
    const ctx = await this.data.load(userId, portfolioId);
    const universe = ctx.bundles.filter((b) => b.input !== null);
    const scan = rankOpportunities(
      universe.map((b) => b.input as NonNullable<StockBundle['input']>),
      q.horizon,
      { actions: ACTIONS },
    );
    const cfg = DEFAULT_RECOMMENDATION_CONFIG;
    const results: unknown[] = [];
    for (const r of scan.ranked) {
      const b = universe.find((x) => x.stock.symbol === r.symbol) as StockBundle;
      const m = this.matchFilter(q.filter, r.evaluation, b, cfg);
      if (!m) continue;
      results.push({
        rank: results.length + 1,
        symbol: r.symbol,
        name: b.stock.name,
        sector: b.stock.sector,
        action: r.evaluation.action,
        headline: r.evaluation.headline,
        confidence: r.evaluation.confidence ? num(r.evaluation.confidence.score, 2) : null,
        price: priceView(b),
        matched: m,
      });
      if (results.length >= 20) break;
    }
    return {
      horizon: q.horizon,
      filter: q.filter,
      generatedAt: ctx.now.toISOString(),
      universe: universe.length,
      verifiedEvaluations: scan.ranked.length,
      results,
      note:
        results.length === 0
          ? scan.ranked.length === 0
            ? 'No stock has verified, fresh data to scan.'
            : 'No stock matches this filter on verified data.'
          : undefined,
    };
  }

  private matchFilter(
    f: ScannerFilter,
    ev: StockEvaluation,
    b: StockBundle,
    cfg: typeof DEFAULT_RECOMMENDATION_CONFIG,
  ): { metric: string; value: string; threshold: string } | null {
    const fund = ev.fundamentals;
    const ratio = (k: Parameters<typeof ratioValue>[1]) => (fund ? ratioValue(fund, k) : null);
    const tech = b.bars.length > 0 ? computeTechSnapshot(b.bars, cfg) : null;
    const hit = (metric: string, value: Decimal, threshold: string) => ({
      metric,
      value: num(value, 2),
      threshold,
    });
    switch (f) {
      case 'undervalued': {
        const mos = ev.valuation?.marginOfSafetyPct ?? null;
        if (mos && mos.gte(cfg.mosMinPct)) return hit('margin of safety %', mos, `>= ${cfg.mosMinPct}`);
        const pe = ratio('pe');
        const pb = ratio('pb');
        if (pe && pb && pe.gt(0) && pe.lte(cfg.peMaxValue) && pb.lte(cfg.pbMaxValue))
          return hit('P/E', pe, `<= ${cfg.peMaxValue} and P/B <= ${cfg.pbMaxValue} (P/B ${num(pb, 2)})`);
        return null;
      }
      case 'earningsGrowth': {
        const g = ratio('epsGrowthYoY');
        return g && g.gte(cfg.growthHighPct) ? hit('EPS growth YoY %', g, `>= ${cfg.growthHighPct}`) : null;
      }
      case 'highDividend': {
        const y = ratio('dividendYield');
        return y && y.gte(cfg.dividendYieldMinPct)
          ? hit('dividend yield %', y, `>= ${cfg.dividendYieldMinPct}`)
          : null;
      }
      case 'breakout':
        return tech?.breakout.crossed && tech.breakout.level
          ? hit(
              'close crossed resistance',
              tech.breakout.level.price,
              `confirmed by volume: ${tech.breakout.confirmed}`,
            )
          : null;
      case 'nearSupport': {
        if (!tech?.sr.support || !tech.atr || !tech.atr.gt(0)) return null;
        const dist = tech.close.minus(tech.sr.support.price).div(tech.atr);
        return dist.lte(cfg.nearSupportAtr)
          ? hit('ATRs above support', dist, `<= ${cfg.nearSupportAtr}`)
          : null;
      }
      case 'unusualVolume': {
        const rv = tech?.vol.relativeVolume ?? null;
        return rv && rv.gte(UNUSUAL_VOLUME_X) ? hit('relative volume', rv, `>= ${UNUSUAL_VOLUME_X}`) : null;
      }
      case 'momentum': {
        const s = tech?.momentum.score ?? null;
        return s && s.gte(cfg.momentumStrong) ? hit('momentum score', s, `>= ${cfg.momentumStrong}`) : null;
      }
      case 'improvingFundamentals': {
        const rg = ratio('revenueGrowthYoY');
        const eg = ratio('epsGrowthYoY');
        return rg && eg && rg.gt(0) && eg.gt(0)
          ? hit('revenue growth YoY %', rg, `> 0 and EPS growth YoY ${num(eg, 2)}% > 0`)
          : null;
      }
      case 'deteriorating': {
        const rg = ratio('revenueGrowthYoY');
        const eg = ratio('epsGrowthYoY');
        const nm = ratio('netMargin');
        if (rg && rg.isNeg()) return hit('revenue growth YoY %', rg, '< 0');
        if (eg && eg.isNeg()) return hit('EPS growth YoY %', eg, '< 0');
        if (nm && nm.isNeg()) return hit('net margin %', nm, '< 0');
        return null;
      }
      case 'illiquid': {
        const v = tech?.vol.avgTradedValue20 ?? null;
        return v === null || v.lt(cfg.liquidityFloorTradedValue)
          ? {
              metric: 'average daily traded value',
              value: v ? num(v, 0) : 'n/a',
              threshold: `< ${cfg.liquidityFloorTradedValue}`,
            }
          : null;
      }
    }
  }

  // ───────────── single stock ─────────────

  async stockReport(userId: string, symbol: string, q: StockQuery) {
    const portfolioId = q.portfolioId ?? (await this.data.defaultPortfolioId(userId));
    const ctx = await this.data.load(userId, portfolioId);
    const b = ctx.bundles.find((x) => x.stock.symbol === symbol);
    if (!b)
      throw new NotFoundException({
        message: `Unknown or inactive symbol: ${symbol}`,
        code: 'UNKNOWN_SYMBOL',
      });
    const cfg = DEFAULT_RECOMMENDATION_CONFIG;
    const recs = {} as Record<string, unknown>;
    let valuation: StockEvaluation['valuation'] = null;
    if (b.input) {
      for (const horizon of HORIZONS) {
        const ev = evaluateStock({ ...b.input, horizon });
        valuation ??= ev.valuation;
        recs[horizon] = evaluationView(ev, this.explainer.explain(ev), b);
      }
    }
    const tech = b.bars.length > 0 ? computeTechSnapshot(b.bars, cfg) : null;
    const price = priceView(b);
    const fctx: FundamentalsContext = {
      asOf: ctx.now.toISOString(),
      maxAgeDays: cfg.maxFundamentalAgeDays,
      maxPriceAgeDays: 7,
    };
    const ratios =
      b.fundamentals && b.lastBar
        ? computeFundamentalRatios(
            {
              current: b.fundamentals.current,
              priorYear: b.fundamentals.priorYear,
              priorQuarter: b.fundamentals.priorQuarter,
              price: {
                value: b.lastBar.close,
                currency: ctx.portfolio.baseCurrency,
                source: b.lastBar.source,
                asOf: b.lastBar.ts,
              },
              dividendHistory: b.dividends,
            },
            fctx,
          )
        : null;
    const news = await this.prisma.announcement.findMany({
      where: { publishedAt: { lte: ctx.now }, OR: [{ stockId: b.stock.id }, { symbols: { has: symbol } }] },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 10,
    });
    return {
      symbol,
      name: b.stock.name,
      sector: b.stock.sector,
      generatedAt: ctx.now.toISOString(),
      price,
      technicals: tech
        ? {
            basis: `${b.bars.length} daily bars up to ${b.asOfBar}; latest bar source ${b.lastBar!.source}`,
            notice:
              b.lastBar!.source === 'SIMULATED'
                ? 'Computed on SIMULATED bars: for testing only, never investment evidence.'
                : null,
            trend: plain({
              classification: tech.trend.classification,
              sma20: tech.trend.sma20,
              sma50: tech.trend.sma50,
              sma100: tech.trend.sma100,
              sma200: tech.trend.sma200,
              explanation: tech.trend.explanation,
            }),
            rsi14: tech.rsi ? num(tech.rsi, 2) : null,
            macdHistogram: tech.macdHistogram ? num(tech.macdHistogram) : null,
            atr14: tech.atr ? num(tech.atr) : null,
            adx: plain({ explanation: tech.adx.explanation }),
            support: tech.sr.support ? num(tech.sr.support.price) : null,
            resistance: tech.sr.resistance ? num(tech.sr.resistance.price) : null,
            volume: plain({
              relativeVolume: tech.vol.relativeVolume,
              avgVolume20: tech.vol.avgVolume20,
              avgTradedValue20: tech.vol.avgTradedValue20,
              adTrend: tech.vol.adTrend,
            }),
            momentumScore: tech.momentum.score ? num(tech.momentum.score, 2) : null,
            breakout: { crossed: tech.breakout.crossed, confirmed: tech.breakout.confirmed },
          }
        : null,
      ratios: ratios
        ? plain(Object.fromEntries(RATIO_KEYS.map((k) => [k, ratios.ratios[k]])))
        : {
            status: 'UNAVAILABLE',
            reason: 'no financial statements are stored for this symbol (or no price)',
          },
      valuation: valuation
        ? plain({
            status: valuation.status,
            facts: valuation.reportedFacts,
            assumptions: valuation.assumptions,
            methods: valuation.methods,
            fairValueLow: valuation.fairValueLow,
            fairValueHigh: valuation.fairValueHigh,
            marginOfSafetyPct: valuation.marginOfSafetyPct,
            explanation: valuation.explanation,
          })
        : {
            status: 'UNAVAILABLE',
            reason:
              'needs financial statements and at least 3 same-sector peers (or supplied valuation assumptions)',
          },
      announcements: news.map((n) => ({
        id: n.id,
        title: n.title,
        category: n.category,
        publishedAt: n.publishedAt.toISOString(),
        source: n.source,
        sourceName: n.sourceName,
        url: n.url,
      })),
      recommendations: recs,
      dataSources: {
        bars: {
          count: b.bars.length,
          latestBarTs: b.lastBar?.ts ?? null,
          latestBarSource: b.lastBar?.source ?? null,
          sources: [...new Set(b.bars.map((x) => x.source))].sort(),
        },
        quote: b.quote ? plain(b.quote) : null,
        fundamentals: b.fundamentals
          ? {
              period: b.fundamentals.current.period,
              publishedAt: b.fundamentals.current.publishedAt,
              source: b.fundamentals.current.source,
              peersUsed: b.fundamentals.peers?.length ?? 0,
            }
          : null,
        stale: b.stale,
      },
      explanation: {
        template: 'see recommendations[horizon].explanation',
        llm: this.llm.explain({} as StockEvaluation),
      },
    };
  }
}
