import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  BACKTEST_DISCLAIMER,
  type BacktestMetrics,
  type BacktestResult as EngineResult,
  type Decimal,
  round,
  runBacktest,
  ZERO,
} from '@ktrade/finance-core';
import type { DataSource, StrategyType } from '@ktrade/shared';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type DefinitionSpec, resolveDefinition, specFromStrategy } from './definition.js';
import type { CompareBacktestsInput, RunBacktestInput } from './strategies.schemas.js';
import { StrategiesService } from './strategies.service.js';
import { type LoadedBars, StrategyDataService } from './strategy-data.service.js';

const PCT_COLUMN_LIMIT = '999999'; // NUMERIC(12,6)
const s6 = (x: Decimal | null): string | null => (x === null ? null : round(x, 6).toFixed());
const s4 = (x: Decimal | null): string | null => (x === null ? null : round(x, 4).toFixed());
/** A value for a NUMERIC(12,6) column, or null when it would overflow (the full value stays in `params.metrics`). */
const col6 = (x: Decimal | null): string | null =>
  x === null || round(x, 6).abs().gte(PCT_COLUMN_LIMIT) ? null : round(x, 6).toFixed();

interface RunTarget {
  label: string;
  strategyId: string | null;
  spec: DefinitionSpec;
  /** Sizing carried over from a saved strategy. */
  maxPositionQty: string | null;
}

/** Metrics as decimal strings (percentages in percent units). */
export function metricsView(m: BacktestMetrics) {
  return {
    initialCapital: s4(m.initialCapital),
    finalEquity: s4(m.finalEquity),
    totalReturnPct: s6(m.totalReturnPct),
    cagrPct: s6(m.cagrPct),
    annualizedReturnPct: s6(m.annualizedReturnPct),
    maxDrawdownPct: s6(m.maxDrawdownPct),
    sharpe: s6(m.sharpe),
    sortino: s6(m.sortino),
    tradeCount: m.tradeCount,
    winRatePct: s6(m.winRatePct),
    profitFactor: s6(m.profitFactor),
    avgWin: s4(m.avgWin),
    avgLoss: s4(m.avgLoss),
    riskReward: s6(m.riskReward),
    exposurePct: s6(m.exposurePct),
    feesTotal: s4(m.feesTotal),
    buyAndHoldReturnPct: s6(m.buyAndHoldReturnPct),
    calendarDays: s6(m.calendarDays),
  };
}

/**
 * Synchronous D1 backtests on `stock_prices` with the real fee engine (docs/08 §5). Results are labelled with
 * the weakest provenance of the bars used and always carry the disclaimer.
 */
@Injectable()
export class BacktestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly data: StrategyDataService,
    private readonly strategies: StrategiesService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async target(userId: string, strategyId: string): Promise<RunTarget & { symbol: string }> {
    const s = await this.strategies.owned(userId, strategyId);
    return {
      label: s.name,
      strategyId: s.id,
      spec: specFromStrategy(s),
      maxPositionQty: s.maxPositionQty?.toString() ?? null,
      symbol: s.stock.symbol,
    };
  }

  private async loadBars(symbol: string, from: string, to: string) {
    const stock = await this.data.stock(symbol);
    const loaded = await this.data.range(stock.id, from, to);
    if (loaded.bars.length < 2) {
      throw new UnprocessableEntityException({
        message: `Not enough daily bars for ${symbol} between ${from} and ${to} (need at least 2, found ${loaded.bars.length})`,
        code: 'INSUFFICIENT_DATA',
      });
    }
    return { stock, loaded };
  }

  private async simulate(
    t: RunTarget,
    loaded: LoadedBars,
    input: { to: string; initialCapital: string; slippageBps: string },
  ) {
    const resolved = resolveDefinition(t.spec);
    const fees = await this.data.feeModel(input.to);
    const result = runBacktest({
      bars: loaded.bars,
      strategy: resolved.compiled,
      initialCapital: input.initialCapital,
      slippageBps: input.slippageBps,
      fee: fees.fee,
      maxPositionQty: t.maxPositionQty,
    });
    return { resolved, fees, result };
  }

  async run(userId: string, input: RunBacktestInput, meta: RequestMeta) {
    const t = input.strategyId
      ? await this.target(userId, input.strategyId)
      : {
          label: 'inline',
          strategyId: null,
          spec: input.definition as DefinitionSpec,
          maxPositionQty: null,
          symbol: input.symbol as string,
        };
    const symbol = input.symbol ?? t.symbol;
    resolveDefinition(t.spec); // 422 with JSON paths before touching data
    const { loaded } = await this.loadBars(symbol, input.from, input.to);

    const row = await this.prisma.backtestResult.create({
      data: {
        userId,
        strategyId: t.strategyId,
        strategyType: t.spec.type,
        symbol,
        interval: 'D1',
        params: {} as Prisma.InputJsonValue,
        fromDate: new Date(`${input.from}T00:00:00Z`),
        toDate: new Date(`${input.to}T00:00:00Z`),
        initialCapital: input.initialCapital,
        dataSource: loaded.dataSource as DataSource,
        status: 'RUNNING',
        createdAt: this.clock.now(),
      },
    });

    let finalRow;
    try {
      const { resolved, fees, result } = await this.simulate(t, loaded, input);
      const m = result.metrics;
      const params = {
        definition: {
          type: t.spec.type,
          parameters: Object.fromEntries(resolved.parameters.map((p) => [p.key, p.value])),
          entryRules: resolved.entryRules,
          exitRules: resolved.exitRules,
          stopLossPct: t.spec.stopLossPct ?? null,
          takeProfitPct: t.spec.takeProfitPct ?? null,
          trailingStopPct: t.spec.trailingStopPct ?? null,
          cooldownBars: t.spec.cooldownBars ?? 1,
          maxPositionQty: t.maxPositionQty,
        },
        slippageBps: input.slippageBps,
        fillModel: 'signal at close t, market fill at open t+1 ± slippage',
        fees: {
          engine: 'finance-core computeTradeFees',
          scheduleId: fees.scheduleId,
          schedule: fees.scheduleName,
          effectiveFrom: fees.effectiveFrom,
        },
        bars: loaded.bars.length,
        firstBarTs: loaded.bars[0]?.ts,
        lastBarTs: loaded.bars[loaded.bars.length - 1]?.ts,
        metrics: metricsView(m),
        openPosition: result.openPosition
          ? {
              qty: result.openPosition.qty.toFixed(),
              avgCost: result.openPosition.avgCost.toFixed(),
              entryTs: result.openPosition.entryTs,
              marketValue: s4(result.openPosition.marketValue),
            }
          : null,
        signals: result.signals.length,
      };
      finalRow = await this.prisma.$transaction(async (tx) => {
        await tx.backtestTrade.createMany({ data: this.tradeRows(row.id, result) });
        const updated = await tx.backtestResult.update({
          where: { id: row.id },
          data: {
            params: params as Prisma.InputJsonValue,
            finalEquity: s4(m.finalEquity),
            totalReturnPct: col6(m.totalReturnPct),
            cagrPct: col6(m.cagrPct),
            maxDrawdownPct: col6(m.maxDrawdownPct),
            sharpe: col6(m.sharpe),
            winRatePct: col6(m.winRatePct),
            tradesCount: m.tradeCount,
            feesTotal: s4(m.feesTotal),
            benchmarkReturn: col6(m.buyAndHoldReturnPct),
            equityCurve: result.equityCurve.map((p) => ({
              t: p.ts,
              equity: s4(p.equity),
              drawdown: s6(p.drawdownPct),
            })),
            status: 'SUCCEEDED',
            finishedAt: this.clock.now(),
          },
        });
        await this.audit.record(
          {
            action: 'backtest.completed',
            actorType: 'USER',
            actorUserId: userId,
            entityType: 'backtest',
            entityId: row.id,
            metadata: {
              strategyId: t.strategyId,
              symbol,
              from: input.from,
              to: input.to,
              dataSource: loaded.dataSource,
            },
            ...meta,
          },
          tx,
        );
        return updated;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : 'backtest failed';
      finalRow = await this.prisma.backtestResult.update({
        where: { id: row.id },
        data: { status: 'FAILED', error: message, finishedAt: this.clock.now() },
      });
      await this.audit.record({
        action: 'backtest.failed',
        actorType: 'USER',
        actorUserId: userId,
        entityType: 'backtest',
        entityId: row.id,
        metadata: { strategyId: t.strategyId, symbol, error: message },
        ...meta,
      });
    }
    return this.view(finalRow, true);
  }

  private tradeRows(backtestId: string, r: EngineResult): Prisma.BacktestTradeCreateManyInput[] {
    const rows: Prisma.BacktestTradeCreateManyInput[] = r.trades.map((t) => ({
      backtestId,
      entryTs: new Date(t.entryTs),
      exitTs: new Date(t.exitTs),
      quantity: t.qty.toFixed(),
      entryPrice: round(t.entryPrice, 6).toFixed(),
      exitPrice: round(t.exitPrice, 6).toFixed(),
      fees: round(t.entryFees.plus(t.exitFees), 4).toFixed(),
      pnl: round(t.netPnl, 4).toFixed(),
      exitReason: t.exitReason,
    }));
    if (r.openPosition) {
      const entryFill = [...r.fills].reverse().find((f) => f.side === 'BUY');
      rows.push({
        backtestId,
        entryTs: new Date(r.openPosition.entryTs),
        exitTs: null,
        quantity: r.openPosition.qty.toFixed(),
        entryPrice: round(r.openPosition.avgCost, 6).toFixed(),
        exitPrice: null,
        fees: round(entryFill ? entryFill.fee : ZERO, 4).toFixed(),
        pnl: null,
        exitReason: null,
      });
    }
    return rows;
  }

  async compare(userId: string, input: CompareBacktestsInput, meta: RequestMeta) {
    const targets: (RunTarget & { symbol?: string })[] = [];
    for (const id of input.strategyIds) targets.push(await this.target(userId, id));
    input.definitions.forEach((def, i) => {
      const { label, ...spec } = def;
      targets.push({ label: label ?? `definition ${i + 1}`, strategyId: null, spec, maxPositionQty: null });
    });
    const symbol = input.symbol ?? (targets[0]?.symbol as string);
    targets.forEach((t) => resolveDefinition(t.spec));
    const { loaded } = await this.loadBars(symbol, input.from, input.to);

    const rows: {
      label: string;
      strategyId: string | null;
      strategyType: StrategyType;
      metrics: ReturnType<typeof metricsView>;
    }[] = [];
    let benchmark: string | null = null;
    for (const t of targets) {
      const { result } = await this.simulate(t, loaded, input);
      benchmark = s6(result.metrics.buyAndHoldReturnPct);
      rows.push({
        label: t.label,
        strategyId: t.strategyId,
        strategyType: t.spec.type,
        metrics: metricsView(result.metrics),
      });
    }
    await this.audit.record({
      action: 'backtest.compared',
      actorType: 'USER',
      actorUserId: userId,
      entityType: 'backtest',
      metadata: {
        symbol,
        from: input.from,
        to: input.to,
        strategies: rows.map((r) => r.strategyId ?? r.label),
      },
      ...meta,
    });
    return {
      symbol,
      interval: 'D1',
      from: input.from,
      to: input.to,
      initialCapital: input.initialCapital,
      slippageBps: input.slippageBps,
      bars: loaded.bars.length,
      dataSource: loaded.dataSource,
      rows,
      benchmark: { label: 'Buy & hold', totalReturnPct: benchmark },
      disclaimer: BACKTEST_DISCLAIMER,
    };
  }

  async list(userId: string, q: { strategyId?: string; limit: number }) {
    const rows = await this.prisma.backtestResult.findMany({
      where: { userId, ...(q.strategyId ? { strategyId: q.strategyId } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit,
    });
    return { data: rows.map((r) => this.view(r, false)), disclaimer: BACKTEST_DISCLAIMER };
  }

  async get(userId: string, id: string) {
    return this.view(await this.owned(userId, id), true);
  }

  async trades(userId: string, id: string) {
    await this.owned(userId, id);
    const rows = await this.prisma.backtestTrade.findMany({
      where: { backtestId: id },
      orderBy: [{ entryTs: 'asc' }, { id: 'asc' }],
    });
    return {
      data: rows.map((t) => ({
        id: t.id,
        entryTs: t.entryTs.toISOString(),
        exitTs: t.exitTs?.toISOString() ?? null,
        quantity: t.quantity.toString(),
        entryPrice: t.entryPrice.toString(),
        exitPrice: t.exitPrice?.toString() ?? null,
        fees: t.fees.toString(),
        pnl: t.pnl?.toString() ?? null,
        exitReason: t.exitReason,
        open: t.exitTs === null,
      })),
      source: 'SIMULATED' as const,
      disclaimer: BACKTEST_DISCLAIMER,
    };
  }

  private async owned(userId: string, id: string) {
    const r = await this.prisma.backtestResult.findFirst({ where: { id, userId } });
    if (!r) throw new NotFoundException({ message: 'Backtest not found', code: 'NOT_FOUND' });
    return r;
  }

  private view(r: Prisma.BacktestResultGetPayload<Record<string, never>>, detailed: boolean) {
    const params = (r.params ?? {}) as { metrics?: unknown };
    return {
      id: r.id,
      status: r.status,
      strategyId: r.strategyId,
      strategyType: r.strategyType,
      symbol: r.symbol,
      interval: r.interval,
      from: r.fromDate.toISOString().slice(0, 10),
      to: r.toDate.toISOString().slice(0, 10),
      initialCapital: r.initialCapital.toString(),
      finalEquity: r.finalEquity?.toString() ?? null,
      totalReturnPct: r.totalReturnPct?.toString() ?? null,
      cagrPct: r.cagrPct?.toString() ?? null,
      maxDrawdownPct: r.maxDrawdownPct?.toString() ?? null,
      sharpe: r.sharpe?.toString() ?? null,
      winRatePct: r.winRatePct?.toString() ?? null,
      tradesCount: r.tradesCount,
      feesTotal: r.feesTotal?.toString() ?? null,
      benchmark: { label: 'Buy & hold', totalReturnPct: r.benchmarkReturn?.toString() ?? null },
      metrics: params.metrics ?? null,
      dataSource: r.dataSource,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      ...(detailed ? { params: r.params, equityCurve: r.equityCurve } : {}),
      disclaimer: BACKTEST_DISCLAIMER,
    };
  }
}
