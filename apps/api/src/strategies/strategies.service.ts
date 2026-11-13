import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BACKTEST_DISCLAIMER,
  d,
  type Decimal,
  evaluateStrategyAt,
  HUNDRED,
  max,
  type OhlcvBar,
  round,
  runBacktest,
  sizePosition,
  type StrategyPosition,
  type StrategySignal,
  ZERO,
} from '@ktrade/finance-core';
import type { DataSource, SignalStatus } from '@ktrade/shared';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { Prisma, type StrategyParameter, type TradingStrategy } from '../generated/prisma/client.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { pktDateOf } from '../market-data/calendar.js';
import { MarketDataService } from '../market-data/market-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TradingService } from '../trading/trading.service.js';
import {
  type DefinitionSpec,
  resolveDefinition,
  type ResolvedDefinition,
  specFromStrategy,
} from './definition.js';
import type {
  CreateStrategyInput,
  UpdateStrategyInput,
  ValidateStrategyInput,
} from './strategies.schemas.js';
import { EVALUATION_LOOKBACK_BARS, StrategyDataService } from './strategy-data.service.js';

type StrategyRow = TradingStrategy & { parameters: StrategyParameter[]; stock: { symbol: string } };
const dec = (v: { toString(): string } | null | undefined): Decimal =>
  v === null || v === undefined ? ZERO : d(v.toString());
const json = (v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  v === null || v === undefined ? Prisma.JsonNull : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue);
const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
/** Fields whose change alters trading behaviour → bump `version` (signals record the version they came from). */
const DEFINITION_FIELDS = [
  'type',
  'parameters',
  'entryRules',
  'exitRules',
  'stopLossPct',
  'takeProfitPct',
  'trailingStopPct',
  'cooldownBars',
  'maxInvestment',
  'maxPositionQty',
  'riskPerTradePct',
] as const;
const DRY_RUN_CAPITAL = '1000000';

export const LIVE_AUTO_EXECUTION_FORBIDDEN = 'LIVE_AUTO_EXECUTION_FORBIDDEN';

const notFound = () => new NotFoundException({ message: 'Strategy not found', code: 'NOT_FOUND' });
const liveAutoForbidden = () =>
  new UnprocessableEntityException({
    message:
      'autoExecute is only available for PAPER strategies: live auto-execution is not authorized (ADR-021). Live signals need manual approval.',
    code: LIVE_AUTO_EXECUTION_FORBIDDEN,
  });

/** Serialise a strategy signal's explainability trace (all decimals as strings). */
export function signalView(s: StrategySignal) {
  return {
    type: s.type,
    reason: s.reason,
    side: s.side,
    ts: s.ts,
    price: s.price.toFixed(),
    summary: s.trace.summary,
    score: {
      total: s.score.total.toFixed(),
      direction: s.score.direction,
      components: s.score.components.map((c) => ({
        name: c.name,
        weight: c.weight,
        available: c.available,
        score: c.score?.toFixed() ?? null,
        detail: c.detail,
      })),
    },
    trace: JSON.parse(JSON.stringify(s.trace)) as unknown,
  };
}

/**
 * Strategy definitions, activation, dry runs and (manually triggered) evaluation (docs/08).
 * Safety: LIVE strategies never auto-execute — evaluation only records signals; PAPER strategies with
 * autoExecute route through TradingService's preview + system PAPER approval (all risk checks still run).
 */
@Injectable()
export class StrategiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly data: StrategyDataService,
    private readonly trading: TradingService,
    private readonly market: MarketDataService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async list(userId: string) {
    const rows = await this.prisma.tradingStrategy.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { parameters: true, stock: { select: { symbol: true } } },
    });
    return rows.map((r) => this.serialize(r));
  }

  async get(userId: string, id: string) {
    return this.serialize(await this.owned(userId, id));
  }

  async create(userId: string, input: CreateStrategyInput, meta: RequestMeta) {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: input.portfolioId, userId, archivedAt: null },
    });
    if (!portfolio) throw new NotFoundException({ message: 'Portfolio not found', code: 'NOT_FOUND' });
    const mode = portfolio.kind === 'PAPER' ? 'PAPER' : 'LIVE';
    if (mode === 'LIVE' && input.autoExecute) throw liveAutoForbidden();
    const stock = await this.data.stock(input.symbol);
    const resolved = resolveDefinition(input);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const s = await tx.tradingStrategy.create({
          data: {
            userId,
            portfolioId: portfolio.id,
            stockId: stock.id,
            name: input.name,
            type: input.type,
            mode,
            interval: 'D1',
            entryRules: json(resolved.entryRules),
            exitRules: json(resolved.exitRules),
            stopLossPct: input.stopLossPct ?? null,
            takeProfitPct: input.takeProfitPct ?? null,
            trailingStopPct: input.trailingStopPct ?? null,
            maxInvestment: input.maxInvestment,
            maxPositionQty: input.maxPositionQty ?? null,
            riskPerTradePct: input.riskPerTradePct ?? null,
            cooldownBars: input.cooldownBars,
            autoExecute: input.autoExecute,
            parameters: { create: resolved.parameters },
          },
        });
        await this.audit.record(
          {
            action: 'strategy.created',
            actorType: 'USER',
            actorUserId: userId,
            entityType: 'strategy',
            entityId: s.id,
            after: {
              name: input.name,
              type: input.type,
              mode,
              symbol: stock.symbol,
              autoExecute: input.autoExecute,
            },
            ...meta,
          },
          tx,
        );
        return s;
      });
      return this.get(userId, created.id);
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException({
          message: 'A strategy with this name already exists',
          code: 'NAME_TAKEN',
        });
      throw err;
    }
  }

  async update(userId: string, id: string, input: UpdateStrategyInput, meta: RequestMeta) {
    const current = await this.owned(userId, id);
    if (current.mode === 'LIVE' && input.autoExecute === true) throw liveAutoForbidden();
    const definitionChanged = DEFINITION_FIELDS.some((k) => input[k] !== undefined);
    let resolved: ResolvedDefinition | null = null;
    if (definitionChanged) {
      const base = specFromStrategy(current);
      const typeChanged = input.type !== undefined && input.type !== current.type;
      const spec: DefinitionSpec = {
        ...base,
        ...(typeChanged ? { parameters: {}, entryRules: undefined, exitRules: undefined } : {}),
        ...Object.fromEntries(
          (
            [
              'type',
              'parameters',
              'entryRules',
              'exitRules',
              'stopLossPct',
              'takeProfitPct',
              'trailingStopPct',
              'cooldownBars',
            ] as const
          )
            .filter((k) => input[k] !== undefined)
            .map((k) => [k, input[k]]),
        ),
      };
      resolved = resolveDefinition(spec);
    }
    const before = this.serialize(current);
    try {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.tradingStrategy.updateMany({
          where: { id, version: current.version },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.autoExecute !== undefined ? { autoExecute: input.autoExecute } : {}),
            ...(input.type !== undefined ? { type: input.type } : {}),
            ...(input.stopLossPct !== undefined ? { stopLossPct: input.stopLossPct } : {}),
            ...(input.takeProfitPct !== undefined ? { takeProfitPct: input.takeProfitPct } : {}),
            ...(input.trailingStopPct !== undefined ? { trailingStopPct: input.trailingStopPct } : {}),
            ...(input.cooldownBars !== undefined ? { cooldownBars: input.cooldownBars } : {}),
            ...(input.maxInvestment !== undefined ? { maxInvestment: input.maxInvestment } : {}),
            ...(input.maxPositionQty !== undefined ? { maxPositionQty: input.maxPositionQty } : {}),
            ...(input.riskPerTradePct !== undefined ? { riskPerTradePct: input.riskPerTradePct } : {}),
            ...(resolved
              ? {
                  entryRules: json(resolved.entryRules),
                  exitRules: json(resolved.exitRules),
                  version: { increment: 1 },
                }
              : {}),
          },
        });
        if (count !== 1)
          throw new ConflictException({
            message: 'Strategy changed concurrently — reload',
            code: 'CONCURRENT_MODIFICATION',
          });
        if (resolved) {
          await tx.strategyParameter.deleteMany({ where: { strategyId: id } });
          if (resolved.parameters.length > 0)
            await tx.strategyParameter.createMany({
              data: resolved.parameters.map((p) => ({ ...p, strategyId: id })),
            });
        }
        await this.audit.record(
          {
            action: 'strategy.updated',
            actorType: 'USER',
            actorUserId: userId,
            entityType: 'strategy',
            entityId: id,
            before,
            after: input,
            metadata: { versionBumped: resolved !== null },
            ...meta,
          },
          tx,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException({
          message:
            'Conflicts with another strategy (same name, or another ACTIVE strategy of this type for this stock and portfolio)',
          code: 'STRATEGY_CONFLICT',
        });
      throw err;
    }
    return this.get(userId, id);
  }

  async remove(userId: string, id: string, meta: RequestMeta): Promise<void> {
    const s = await this.owned(userId, id);
    if (s.isActive)
      throw new ConflictException({
        message: 'Deactivate the strategy before deleting it',
        code: 'STRATEGY_ACTIVE',
      });
    await this.prisma.$transaction(async (tx) => {
      await tx.tradingStrategy.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'strategy.deleted',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'strategy',
          entityId: id,
          before: this.serialize(s),
          ...meta,
        },
        tx,
      );
    });
  }

  // ── Activation ─────────────────────────────────────────────────────────────

  /** Mode of an owned strategy (lets the controller demand step-up for LIVE before anything changes). */
  async modeOf(userId: string, id: string): Promise<'PAPER' | 'LIVE'> {
    const s = await this.owned(userId, id);
    return s.mode === 'LIVE' ? 'LIVE' : 'PAPER';
  }

  async setActive(userId: string, id: string, active: boolean, meta: RequestMeta, stepUpVerified: boolean) {
    const s = await this.owned(userId, id);
    if (active && s.mode === 'LIVE') {
      // Defence in depth: the controller already demanded step-up for LIVE activations.
      if (!stepUpVerified)
        throw new ForbiddenException({
          message: 'Fresh second-factor verification required',
          code: 'STEP_UP_REQUIRED',
        });
      if (s.autoExecute) throw liveAutoForbidden();
    }
    if (s.isActive === active) return this.serialize(s);
    // Re-validate before activating: rules stored by an older engine version must still compile.
    if (active) resolveDefinition(specFromStrategy(s));
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.tradingStrategy.update({ where: { id }, data: { isActive: active } });
        await this.audit.record(
          {
            action: active ? 'strategy.activated' : 'strategy.deactivated',
            actorType: 'USER',
            actorUserId: userId,
            entityType: 'strategy',
            entityId: id,
            metadata: { mode: s.mode, stepUp: stepUpVerified },
            ...meta,
          },
          tx,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException({
          message: `Another ${s.type} strategy is already active for ${s.stock.symbol} in this portfolio`,
          code: 'ACTIVE_STRATEGY_EXISTS',
        });
      throw err;
    }
    return this.get(userId, id);
  }

  // ── Validate / dry run ─────────────────────────────────────────────────────

  /**
   * Validate a definition and replay it over the last N completed daily bars with hypothetical position tracking
   * (same fill model and fee engine as backtests). Nothing is persisted.
   */
  async validate(input: ValidateStrategyInput) {
    const resolved = resolveDefinition(input);
    const base = {
      valid: true as const,
      warmupBars: resolved.compiled.warmupBars,
      rules: { entryRules: resolved.entryRules, exitRules: resolved.exitRules },
      parameters: Object.fromEntries(resolved.parameters.map((p) => [p.key, p.value])),
    };
    if (!input.symbol) return { ...base, dryRun: null };
    const stock = await this.data.stock(input.symbol);
    const loaded = await this.data.latestCompleted(stock.id, input.bars);
    if (loaded.bars.length === 0)
      return {
        ...base,
        dryRun: {
          symbol: stock.symbol,
          bars: 0,
          dataSource: null,
          signals: [],
          disclaimer: BACKTEST_DISCLAIMER,
        },
      };
    const last = loaded.bars[loaded.bars.length - 1] as OhlcvBar;
    const fees = await this.data.feeModel(pktDateOf(new Date(last.ts)));
    const r = runBacktest({
      bars: loaded.bars,
      strategy: resolved.compiled,
      initialCapital: DRY_RUN_CAPITAL,
      fee: fees.fee,
    });
    return {
      ...base,
      dryRun: {
        symbol: stock.symbol,
        bars: loaded.bars.length,
        from: loaded.bars[0]?.ts ?? null,
        to: last.ts,
        dataSource: loaded.dataSource,
        warmupComplete: loaded.bars.length >= resolved.compiled.warmupBars,
        note: `Hypothetical replay with ${DRY_RUN_CAPITAL} PKR notional capital; signals at bar close, fills at the next open.`,
        signals: r.signals.map((s) => ({
          ...signalView(s.signal),
          barIndex: s.signal.barIndex,
          wouldFill: s.filled,
          note: s.note,
        })),
        disclaimer: BACKTEST_DISCLAIMER,
      },
    };
  }

  // ── Evaluation (manual trigger; the scheduler will call the same method) ────

  async evaluate(userId: string, id: string, meta: RequestMeta) {
    const s = await this.owned(userId, id);
    if (!s.isActive)
      throw new ConflictException({
        message: 'Activate the strategy before evaluating it',
        code: 'STRATEGY_INACTIVE',
      });
    const now = this.clock.now();
    const execution = await this.prisma.strategyExecution.create({
      data: { strategyId: s.id, mode: s.mode, status: 'RUNNING', startedAt: now },
    });
    try {
      const result = await this.evaluateInner(userId, s, meta);
      const finished = await this.prisma.strategyExecution.update({
        where: { id: execution.id },
        data: {
          status: 'SUCCEEDED',
          finishedAt: this.clock.now(),
          barTs: result.barTs,
          signalsGenerated: result.created ? 1 : 0,
          details: json(result.details) as Prisma.InputJsonValue,
        },
      });
      await this.prisma.tradingStrategy.update({ where: { id: s.id }, data: { lastEvaluatedAt: now } });
      await this.audit.record({
        action: 'strategy.evaluated',
        actorType: 'USER',
        actorUserId: userId,
        entityType: 'strategy',
        entityId: s.id,
        metadata: { executionId: execution.id, mode: s.mode, ...result.details },
        ...meta,
      });
      return {
        execution: this.executionView(finished),
        signal: result.signalId ? await this.signalById(userId, result.signalId) : null,
        duplicate: result.duplicate,
        order: result.order,
        note: result.note,
      };
    } catch (err) {
      await this.prisma.strategyExecution.update({
        where: { id: execution.id },
        data: {
          status: 'FAILED',
          finishedAt: this.clock.now(),
          error: err instanceof Error ? err.message.slice(0, 500) : 'evaluation failed',
        },
      });
      throw err;
    }
  }

  private async evaluateInner(userId: string, s: StrategyRow, meta: RequestMeta) {
    const resolved = resolveDefinition(specFromStrategy(s));
    const loaded = await this.data.latestCompleted(s.stockId, EVALUATION_LOOKBACK_BARS);
    const none = (note: string, barTs: Date | null = null) => ({
      barTs,
      created: false,
      duplicate: false,
      signalId: null as string | null,
      order: null as { id: string; status: string } | null,
      note,
      details: { signal: null, note } as Record<string, unknown>,
    });
    const lastBar = loaded.bars[loaded.bars.length - 1];
    if (!lastBar) return none('no completed daily bars for this stock');
    const lastIdx = loaded.bars.length - 1;
    const barTs = new Date(lastBar.ts);

    // Current position (from the portfolio's holding) and its per-bar history since entry.
    const holding = await this.prisma.holding.findUnique({
      where: { portfolioId_stockId: { portfolioId: s.portfolioId, stockId: s.stockId } },
    });
    const heldQty = holding ? dec(holding.quantity) : ZERO;
    const history: (StrategyPosition | null)[] = loaded.bars.map(() => null);
    let position: StrategyPosition | null = null;
    if (holding && heldQty.gt(0)) {
      const avgCost = dec(holding.avgCost);
      const entryDate = holding.firstBuyAt ? holding.firstBuyAt.toISOString().slice(0, 10) : null;
      let entryIdx =
        entryDate === null ? -1 : loaded.bars.findIndex((b) => pktDateOf(new Date(b.ts)) >= entryDate);
      // Bought after the last completed bar (e.g. a fill during today's session): no bar high belongs to it yet.
      const boughtAfterLastBar = entryIdx < 0;
      if (boughtAfterLastBar) entryIdx = lastIdx;
      let high = avgCost;
      for (let i = entryIdx; i <= lastIdx; i++) {
        if (!boughtAfterLastBar) high = max(high, (loaded.bars[i] as OhlcvBar).high);
        history[i] = { qty: heldQty, avgCost, barsHeld: i - entryIdx + 1, highSinceEntry: high };
      }
      position = history[lastIdx] ?? null;
    }
    // Cooldown: bars since this strategy's last exit signal (the exit fills on the following bar).
    let barsSinceLastExit: number | null = null;
    if (!position) {
      const lastExit = await this.prisma.strategySignal.findFirst({
        where: { strategyId: s.id, type: 'EXIT', status: { not: 'DISMISSED' } },
        orderBy: { barTs: 'desc' },
      });
      if (lastExit) {
        const k = loaded.bars.findIndex((b) => b.ts === lastExit.barTs.toISOString());
        if (k >= 0) barsSinceLastExit = Math.max(0, lastIdx - k - 1);
      }
    }

    const signal = evaluateStrategyAt(resolved.compiled, loaded.bars, position, {
      positionHistory: history,
      barsSinceLastExit,
    });
    if (!signal) return none('no signal at the latest completed bar', barTs);

    // Sizing (docs/08 §4). ENTRY: budget, max qty, risk-per-trade and the portfolio concentration cap.
    let suggestedQty: Decimal;
    let sizing: Record<string, unknown> = {};
    if (signal.type === 'ENTRY') {
      const price = signal.price;
      const budget = dec(s.maxInvestment);
      const fees = await this.data.feeModel(pktDateOf(barTs));
      const probeQty = budget.div(price).floor();
      const feeEstimatePct = probeQty.gt(0)
        ? fees.fee('BUY', probeQty, price).div(probeQty.times(price)).times(HUNDRED)
        : ZERO;
      const equity = await this.portfolioValue(s.portfolioId);
      const limits = await this.prisma.riskLimit.findUnique({ where: { portfolioId: s.portfolioId } });
      const stopPrice = s.stopLossPct ? price.times(d('1').minus(dec(s.stopLossPct).div(HUNDRED))) : null;
      const r = sizePosition({
        price,
        maxInvestmentRemaining: budget,
        feeEstimatePct: round(feeEstimatePct, 6),
        maxPositionQty: s.maxPositionQty ? dec(s.maxPositionQty) : null,
        riskPerTradePct: s.riskPerTradePct && stopPrice ? dec(s.riskPerTradePct) : null,
        equity,
        stopPrice: s.riskPerTradePct ? stopPrice : null,
        maxPositionPct: limits ? dec(limits.maxPositionPct) : null,
        portfolioValue: equity,
        currentPositionValue: ZERO,
      });
      suggestedQty = r.qty;
      sizing = {
        binding: r.binding,
        candidates: r.candidates.map((c) => ({ constraint: c.constraint, qty: c.qty.toFixed() })),
      };
      if (!r.tradable) {
        const res = none(`entry signal sized to 0 shares (binding: ${r.binding}); no signal emitted`, barTs);
        res.details = { ...res.details, wouldBe: signalView(signal), sizing };
        return res;
      }
    } else {
      suggestedQty = heldQty;
    }

    // Persist (idempotent on (strategyId, barTs, type, reason)).
    const priceSource: DataSource = loaded.sources[lastIdx] ?? 'SIMULATED';
    let signalRow;
    try {
      signalRow = await this.prisma.strategySignal.create({
        data: {
          strategyId: s.id,
          stockId: s.stockId,
          mode: s.mode,
          type: signal.type,
          reason: signal.reason,
          side: signal.side,
          barTs,
          price: signal.price.toFixed(),
          priceSource,
          suggestedQty: suggestedQty.toFixed(),
          indicators: json({
            ...signalView(signal),
            sizing,
            dataSource: loaded.dataSource,
          }) as Prisma.InputJsonValue,
          strategyVersion: s.version,
          status: 'NEW',
          createdAt: this.clock.now(),
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.prisma.strategySignal.findUniqueOrThrow({
        where: {
          strategyId_barTs_type_reason: { strategyId: s.id, barTs, type: signal.type, reason: signal.reason },
        },
        include: { order: { select: { id: true, status: true } } },
      });
      const note = 'signal for this bar already recorded; nothing new created';
      return {
        barTs,
        created: false,
        duplicate: true,
        signalId: existing.id,
        order: existing.order,
        note,
        details: { signalId: existing.id, duplicate: true, note },
      };
    }
    await this.audit.record({
      action: 'strategy.signal_created',
      actorType: 'STRATEGY',
      actorUserId: userId,
      entityType: 'strategy_signal',
      entityId: signalRow.id,
      metadata: { strategyId: s.id, type: signal.type, reason: signal.reason, mode: s.mode },
    });

    // Execution policy (docs/08 §7): only PAPER + autoExecute is approved automatically.
    let order: { id: string; status: string } | null = null;
    let note: string;
    if (s.mode === 'PAPER' && s.autoExecute) {
      ({ order, note } = await this.autoExecutePaper(userId, s, signalRow.id, signal, suggestedQty, meta));
    } else if (s.mode === 'LIVE') {
      note =
        'LIVE strategy: signal recorded only. Review it and place the order manually (approval needs step-up).';
    } else {
      note = 'PAPER strategy without autoExecute: signal recorded; prepare an order from it manually.';
    }
    return {
      barTs,
      created: true,
      duplicate: false,
      signalId: signalRow.id,
      order,
      note,
      details: {
        signalId: signalRow.id,
        type: signal.type,
        reason: signal.reason,
        orderId: order?.id ?? null,
        note,
      },
    };
  }

  /** PAPER + autoExecute: preview (origin STRATEGY) then the system PAPER approval; risk failures block the signal. */
  private async autoExecutePaper(
    userId: string,
    s: StrategyRow,
    signalId: string,
    signal: StrategySignal,
    qty: Decimal,
    meta: RequestMeta,
  ): Promise<{ order: { id: string; status: string } | null; note: string }> {
    if (s.mode !== 'PAPER') throw new Error('invariant: auto-execution is PAPER-only');
    const quote = await this.prisma.stockQuote.findUnique({ where: { stockId: s.stockId } });
    if (!quote) await this.market.refreshQuotes(true);
    const setStatus = (status: SignalStatus, orderId: string | null) =>
      this.prisma.strategySignal.update({ where: { id: signalId }, data: { status, orderId } });

    const preview = await this.trading.preview(
      userId,
      {
        portfolioId: s.portfolioId,
        symbol: s.stock.symbol,
        side: signal.side,
        type: 'MARKET',
        quantity: qty.toFixed(0),
        origin: 'STRATEGY',
        strategyId: s.id,
      },
      `strategy-signal-${signalId}`,
      meta,
      'STRATEGY',
    );
    if (preview.status !== 'PREVIEWED' || !preview.previewHash) {
      await setStatus('BLOCKED_BY_RISK', preview.id);
      return {
        order: { id: preview.id, status: preview.status },
        note: `paper order blocked by risk checks: ${preview.rejectionReason ?? preview.status}`,
      };
    }
    try {
      const approved = await this.trading.approveSystemPaper(userId, preview.id, preview.previewHash, meta);
      await setStatus('AUTO_EXECUTED_PAPER', approved.id);
      return {
        order: { id: approved.id, status: approved.status },
        note: `paper order auto-executed (${approved.status})`,
      };
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 422) {
        await setStatus('BLOCKED_BY_RISK', preview.id);
        return {
          order: { id: preview.id, status: 'REJECTED_BY_RISK' },
          note: 'paper order blocked by risk checks at approval',
        };
      }
      await setStatus('NEW', preview.id);
      throw err;
    }
  }

  /** Cash + holdings at their latest quote (avg cost when no quote). */
  private async portfolioValue(portfolioId: string): Promise<Decimal> {
    const cash = await this.ledger.cashBalance(this.prisma, portfolioId);
    const holdings = await this.prisma.holding.findMany({
      where: { portfolioId },
      include: { stock: { select: { quote: { select: { last: true } } } } },
    });
    return holdings.reduce(
      (acc, h) => acc.plus(dec(h.quantity).times(h.stock.quote ? dec(h.stock.quote.last) : dec(h.avgCost))),
      cash,
    );
  }

  // ── Signals & executions ───────────────────────────────────────────────────

  async signals(userId: string, q: { strategyId?: string; status?: SignalStatus; limit: number }) {
    if (q.strategyId) await this.owned(userId, q.strategyId);
    const rows = await this.prisma.strategySignal.findMany({
      where: {
        strategy: { userId },
        ...(q.strategyId ? { strategyId: q.strategyId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit,
      include: { stock: { select: { symbol: true } }, strategy: { select: { name: true } } },
    });
    return rows.map((r) => this.signalRowView(r));
  }

  async signalById(userId: string, id: string) {
    const r = await this.prisma.strategySignal.findFirst({
      where: { id, strategy: { userId } },
      include: { stock: { select: { symbol: true } }, strategy: { select: { name: true } } },
    });
    if (!r) throw new NotFoundException({ message: 'Signal not found', code: 'NOT_FOUND' });
    return { ...this.signalRowView(r), trace: r.indicators };
  }

  async executions(userId: string, id: string) {
    await this.owned(userId, id);
    const rows = await this.prisma.strategyExecution.findMany({
      where: { strategyId: id },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.executionView(r));
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Owner-scoped load; other users' strategies are 404 (ids are not disclosed). */
  async owned(userId: string, id: string): Promise<StrategyRow> {
    const s = await this.prisma.tradingStrategy.findFirst({
      where: { id, userId },
      include: { parameters: true, stock: { select: { symbol: true } } },
    });
    if (!s) throw notFound();
    return s;
  }

  private signalRowView(r: {
    id: string;
    strategyId: string;
    mode: string;
    type: string;
    reason: string;
    side: string;
    barTs: Date;
    price: { toString(): string };
    priceSource: DataSource;
    suggestedQty: { toString(): string } | null;
    strategyVersion: number;
    status: string;
    orderId: string | null;
    createdAt: Date;
    stock: { symbol: string };
    strategy: { name: string };
  }) {
    return {
      id: r.id,
      strategyId: r.strategyId,
      strategyName: r.strategy.name,
      symbol: r.stock.symbol,
      mode: r.mode,
      type: r.type,
      reason: r.reason,
      side: r.side,
      barTs: r.barTs.toISOString(),
      price: { value: r.price.toString(), source: r.priceSource },
      suggestedQty: r.suggestedQty?.toString() ?? null,
      strategyVersion: r.strategyVersion,
      status: r.status,
      orderId: r.orderId,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private executionView(r: {
    id: string;
    mode: string;
    status: string;
    startedAt: Date;
    finishedAt: Date | null;
    barTs: Date | null;
    signalsGenerated: number;
    details: unknown;
    error: string | null;
  }) {
    return {
      id: r.id,
      mode: r.mode,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      barTs: r.barTs?.toISOString() ?? null,
      signalsGenerated: r.signalsGenerated,
      details: r.details,
      error: r.error,
    };
  }

  serialize(s: StrategyRow) {
    const spec = specFromStrategy(s);
    return {
      id: s.id,
      name: s.name,
      portfolioId: s.portfolioId,
      symbol: s.stock.symbol,
      type: s.type,
      mode: s.mode,
      interval: s.interval,
      isActive: s.isActive,
      autoExecute: s.autoExecute,
      version: s.version,
      parameters: spec.parameters ?? {},
      entryRules: s.entryRules,
      exitRules: s.exitRules,
      stopLossPct: s.stopLossPct?.toString() ?? null,
      takeProfitPct: s.takeProfitPct?.toString() ?? null,
      trailingStopPct: s.trailingStopPct?.toString() ?? null,
      cooldownBars: s.cooldownBars,
      maxInvestment: s.maxInvestment.toString(),
      maxPositionQty: s.maxPositionQty?.toString() ?? null,
      riskPerTradePct: s.riskPerTradePct?.toString() ?? null,
      lastEvaluatedAt: s.lastEvaluatedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }
}
