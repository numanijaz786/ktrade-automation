import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  d,
  type Decimal,
  evaluateRisk,
  HUNDRED,
  paperFill,
  previewHash,
  type RiskEvaluation,
  roundMoney,
  ZERO,
} from '@ktrade/finance-core';
import type { ActorType, DataSource, OrderStatus } from '@ktrade/shared';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { isPsxSessionOpen, pktTradeDate } from '../common/market-hours.js';
import type { Order, Prisma } from '../generated/prisma/client.js';
import { FeeService } from '../ledger/fee.service.js';
import { feeLinesFromBreakdown, LedgerService } from '../ledger/ledger.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PerformanceService } from '../snapshots/performance.service.js';
import { MarketDataService } from '../market-data/market-data.service.js';
import type { PreviewOrderInput, RecordFillInput } from './trading.schemas.js';

type Tx = Prisma.TransactionClient;
const dec = (v: { toString(): string } | null | undefined): Decimal =>
  v === null || v === undefined ? ZERO : d(v.toString());

export const PREVIEW_TTL_MS = 5 * 60_000;
export const QUOTE_FRESHNESS_MS = 15 * 60_000;
export const PAPER_SLIPPAGE_BPS = d('5');
export const KILL_SWITCH_KEY = 'trading.live.enabled';

/** Statuses whose BUY value / SELL quantity is committed but not yet filled. */
const WORKING: OrderStatus[] = [
  'APPROVED',
  'AWAITING_MANUAL_PLACEMENT',
  'PLACED_BY_USER',
  'SUBMITTED',
  'ACCEPTED',
  'PARTIALLY_FILLED',
];
const FINAL: OrderStatus[] = ['FILLED', 'CANCELLED', 'REJECTED_BY_RISK', 'REJECTED_BY_BROKER', 'EXPIRED'];

export type ExecutionPath = 'PAPER_AUTO' | 'MANUAL_TICKET' | 'ADAPTER';

/** Who drives an order transition: a human (step-up verified by the guard) or the strategy engine (PAPER only). */
export type OrderActor = Extract<ActorType, 'USER' | 'STRATEGY'>;
type ApprovalKind = 'USER_STEP_UP' | 'SYSTEM_PAPER';

/** Error code when a system (non-human) approval is attempted on anything but a PAPER strategy order. */
export const SYSTEM_APPROVAL_FORBIDDEN = 'SYSTEM_APPROVAL_FORBIDDEN';

/**
 * Order pipeline (docs/08 §7): preview → risk checks → approval (step-up, bound to the preview hash) → execution.
 *  - PAPER  : simulated fill against the latest quote (source SIMULATED).
 *  - LIVE   : no broker adapter is authorized → MANUAL_TICKET: the user places it in the KTrade app, marks it placed,
 *             and records the fill (USER_REPORTED) until a contract note confirms it (BROKER_CONFIRMED).
 * Never claims execution without a fill. Live orders are never retried automatically.
 */
@Injectable()
export class TradingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly fees: FeeService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly notifications: NotificationsService,
    private readonly performance: PerformanceService,
    private readonly market: MarketDataService,
  ) {}

  /**
   * Today's P&L in PERCENT (finance-core risk convention: 5 = 5 %) for the DAILY_LOSS rule (ADR-028):
   * the same figure the dashboard shows (PerformanceService.today: snapshot after the close, otherwise live
   * quotes vs the previous close, net of deposits/withdrawals). Without a previous close there is no baseline,
   * so it is 0 — the rule then cannot block (documented limitation; backfill snapshots to arm it).
   */
  private async todayPnlPct(portfolioId: string): Promise<Decimal> {
    const t = await this.performance.today(portfolioId, await this.performance.liveValuation(portfolioId));
    return t?.ret ? t.ret.times(HUNDRED) : ZERO;
  }

  // ── Preview ────────────────────────────────────────────────────────────────

  async preview(
    userId: string,
    input: PreviewOrderInput,
    idempotencyKey: string,
    meta: RequestMeta,
    actorType: OrderActor = 'USER',
  ) {
    const replayed = await this.prisma.order.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
    if (replayed) return this.present(replayed.id, userId); // idempotent replay: same response, nothing new created

    const portfolio = await this.ownedPortfolio(userId, input.portfolioId);
    const findStock = () =>
      this.prisma.stock.findUnique({
        where: { symbol: input.symbol.toUpperCase() },
        include: { quote: true },
      });
    let stock = await findStock();
    if (!stock)
      throw new NotFoundException({ message: `Unknown symbol ${input.symbol}`, code: 'UNKNOWN_SYMBOL' });
    if (!stock.quote) {
      // Quotes refresh lazily; pull them once rather than depending on the UI having read market data first.
      await this.market.refreshQuotes(true);
      stock = (await findStock())!;
    }
    if (!stock.quote)
      throw new ConflictException({
        message: `No market price available for ${stock.symbol}`,
        code: 'NO_PRICE',
      });

    const mode = portfolio.kind === 'PAPER' ? 'PAPER' : 'LIVE';
    const now = this.clock.now();
    const qty = d(input.quantity);
    const limitPrice = input.limitPrice ? d(input.limitPrice) : null;
    const stopPrice = input.stopPrice ? d(input.stopPrice) : null;
    const refPrice = dec(stock.quote.last);
    const pricedAt = limitPrice ?? refPrice;
    const fees = await this.fees.estimate(input.side, qty, pricedAt, pktTradeDate(now));
    const gross = roundMoney(qty.times(pricedAt));
    const estTotal = input.side === 'BUY' ? gross.plus(fees.total) : gross.minus(fees.total);
    const executionPath: ExecutionPath = mode === 'PAPER' ? 'PAPER_AUTO' : 'MANUAL_TICKET';

    const hash = previewHash({
      symbol: stock.symbol,
      side: input.side,
      type: input.type,
      qty,
      limitPrice,
      stopPrice,
      portfolioId: portfolio.id,
      mode,
    });

    const order = await this.prisma.$transaction(async (tx) => {
      await this.lockPortfolio(tx, portfolio.id);
      const risk = await this.runRisk(tx, {
        portfolioId: portfolio.id,
        stockId: stock.id,
        mode,
        side: input.side,
        type: input.type,
        qty,
        limitPrice,
        stopPrice,
        refPrice,
        estTotal,
        quote: stock.quote!,
        now,
      });
      const status: OrderStatus = risk.passed ? 'PREVIEWED' : 'REJECTED_BY_RISK';
      const created = await tx.order.create({
        data: {
          userId,
          portfolioId: portfolio.id,
          stockId: stock.id,
          mode,
          origin: input.origin,
          side: input.side,
          type: input.type,
          timeInForce: 'DAY',
          quantity: qty.toFixed(),
          limitPrice: limitPrice?.toFixed() ?? null,
          stopPrice: stopPrice?.toFixed() ?? null,
          referencePrice: refPrice.toFixed(),
          referencePriceSrc: stock.quote!.source,
          status,
          statusSource: mode === 'PAPER' ? 'SIMULATED' : 'USER_REPORTED',
          idempotencyKey,
          previewHash: hash,
          previewExpiresAt: new Date(now.getTime() + PREVIEW_TTL_MS),
          estNotional: gross.toFixed(4),
          estFees: roundMoney(fees.total).toFixed(4),
          estTotal: roundMoney(estTotal).toFixed(4),
          rejectionReason: risk.passed ? null : risk.failedRules.join(', '),
          strategyId: input.strategyId ?? null,
          createdAt: now, // same time source as the daily-limit window
          riskChecks: {
            create: risk.results.map((r) => ({
              rule: r.rule,
              passed: r.passed,
              observed: r.observed,
              limit: r.limit,
              message: r.message,
            })),
          },
          events: { create: { toStatus: status, actorType, actorId: userId, reason: 'preview' } },
        },
      });
      await this.audit.record(
        {
          action: risk.passed ? 'order.previewed' : 'order.rejected_by_risk',
          actorType,
          actorUserId: userId,
          entityType: 'order',
          entityId: created.id,
          after: {
            symbol: stock.symbol,
            side: input.side,
            type: input.type,
            qty: qty.toFixed(),
            mode,
            failedRules: risk.failedRules,
          },
          ...meta,
        },
        tx,
      );
      if (!risk.passed) await this.notifyOrder(tx, created, 'REJECTED_BY_RISK', stock.symbol);
      return created;
    });

    return {
      ...(await this.present(order.id, userId)),
      executionPath,
      feeBreakdown: fees.lines.map((l) => ({
        component: l.component,
        amount: l.amount.toFixed(2),
        source: 'ESTIMATED' as DataSource,
        ...(l.atActual ? { note: 'at actual — known after contract note' } : {}),
      })),
    };
  }

  // ── Approve ────────────────────────────────────────────────────────────────

  async approve(userId: string, orderId: string, previewHashIn: string, meta: RequestMeta) {
    return this.approveInternal(userId, orderId, previewHashIn, meta, 'USER_STEP_UP');
  }

  /**
   * System-originated approval for PAPER strategy orders (docs/08 §7 PaperAutoPolicy: PAPER + autoExecute).
   * Not exposed over HTTP. Runs the same hash binding, expiry and full risk re-check as a human approval, but
   * refuses (inside the locked transaction, before any state change) anything that is not a PAPER order of
   * origin STRATEGY in a PAPER portfolio. LIVE orders always need a human with step-up (ADR-021).
   */
  async approveSystemPaper(userId: string, orderId: string, previewHashIn: string, meta: RequestMeta) {
    return this.approveInternal(userId, orderId, previewHashIn, meta, 'SYSTEM_PAPER');
  }

  private async approveInternal(
    userId: string,
    orderId: string,
    previewHashIn: string,
    meta: RequestMeta,
    kind: ApprovalKind,
  ) {
    const actor: OrderActor = kind === 'SYSTEM_PAPER' ? 'STRATEGY' : 'USER';
    const now = this.clock.now();
    const result = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId, userId);
      if (kind === 'SYSTEM_PAPER') {
        const portfolio = await tx.portfolio.findUniqueOrThrow({
          where: { id: order.portfolioId },
          select: { kind: true },
        });
        if (order.mode !== 'PAPER' || portfolio.kind !== 'PAPER' || order.origin !== 'STRATEGY') {
          throw new ForbiddenException({
            message:
              'System approval is only permitted for PAPER strategy orders; live orders need manual approval',
            code: SYSTEM_APPROVAL_FORBIDDEN,
          });
        }
      }
      if (order.status !== 'PREVIEWED') {
        throw new ConflictException({
          message: `Order is ${order.status}, not awaiting approval`,
          code: 'INVALID_ORDER_STATE',
        });
      }
      if (!order.previewExpiresAt || order.previewExpiresAt <= now) {
        await this.transition(tx, order, 'EXPIRED', userId, 'preview expired', {}, actor);
        return { expired: true as const };
      }
      if (order.previewHash !== previewHashIn) {
        throw new ConflictException({
          message: 'Preview changed — re-preview before approving',
          code: 'PREVIEW_MISMATCH',
        });
      }
      await this.lockPortfolio(tx, order.portfolioId);
      const quote = await tx.stockQuote.findUnique({ where: { stockId: order.stockId } });
      if (!quote) throw new ConflictException({ message: 'No market price available', code: 'NO_PRICE' });

      // Re-check risk with fresh state: limits may have been consumed since the preview.
      const risk = await this.runRisk(tx, {
        portfolioId: order.portfolioId,
        stockId: order.stockId,
        mode: order.mode === 'PAPER' ? 'PAPER' : 'LIVE',
        side: order.side,
        type: order.type,
        qty: dec(order.quantity),
        limitPrice: order.limitPrice ? dec(order.limitPrice) : null,
        stopPrice: order.stopPrice ? dec(order.stopPrice) : null,
        refPrice: dec(quote.last),
        estTotal: dec(order.estTotal),
        quote,
        now,
        excludeOrderId: order.id,
      });
      if (!risk.passed) {
        await tx.orderRiskCheck.createMany({
          data: risk.results.map((r) => ({
            orderId: order.id,
            rule: r.rule,
            passed: r.passed,
            observed: r.observed,
            limit: r.limit,
            message: `[at approval] ${r.message}`,
          })),
        });
        await this.transition(
          tx,
          order,
          'REJECTED_BY_RISK',
          userId,
          `at approval: ${risk.failedRules.join(', ')}`,
          {},
          actor,
        );
        return { rejected: risk.failedRules };
      }

      await this.transition(
        tx,
        order,
        'APPROVED',
        userId,
        kind === 'SYSTEM_PAPER' ? 'auto-approved: PAPER strategy (autoExecute)' : 'approved with step-up',
        { approvedById: userId, approvedAt: now },
        actor,
      );
      await this.audit.record(
        {
          action: kind === 'SYSTEM_PAPER' ? 'order.auto_approved_paper' : 'order.approved',
          actorType: actor,
          actorUserId: userId,
          entityType: 'order',
          entityId: order.id,
          ...(kind === 'SYSTEM_PAPER' ? { metadata: { strategyId: order.strategyId } } : {}),
          ...meta,
        },
        tx,
      );

      if (order.mode === 'PAPER') {
        await this.paperExecute(tx, { ...order, status: 'APPROVED' }, quote, now, userId, actor);
      } else {
        await this.transition(
          tx,
          { ...order, status: 'APPROVED' },
          'AWAITING_MANUAL_PLACEMENT',
          userId,
          'no authorized broker adapter — place this order in the KTrade app',
        );
      }
      return { ok: true as const };
    });

    if ('expired' in result)
      throw new ConflictException({ message: 'Preview expired — preview again', code: 'PREVIEW_EXPIRED' });
    if ('rejected' in result && result.rejected) {
      throw new UnprocessableEntityException({
        message: `Risk checks failed at approval: ${result.rejected.join(', ')}`,
        code: 'RISK_CHECK_FAILED',
      });
    }
    return this.present(orderId, userId);
  }

  // ── Manual live path ───────────────────────────────────────────────────────

  async markPlaced(userId: string, orderId: string, brokerOrderRef: string | undefined, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId, userId);
      if (order.mode !== 'LIVE' || order.status !== 'AWAITING_MANUAL_PLACEMENT') {
        throw new ConflictException({
          message: `Cannot mark a ${order.mode} ${order.status} order as placed`,
          code: 'INVALID_ORDER_STATE',
        });
      }
      await this.transition(tx, order, 'PLACED_BY_USER', userId, 'user reports placing it in KTrade', {
        brokerOrderRef: brokerOrderRef ?? null,
        adapter: 'MANUAL_IMPORT',
        submittedAt: this.clock.now(),
      });
      await this.audit.record(
        {
          action: 'order.placed_manually',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'order',
          entityId: orderId,
          ...meta,
        },
        tx,
      );
    });
    return this.present(orderId, userId);
  }

  /** User-reported fill for a manually placed live order. Fees are ESTIMATED until a contract note reconciles them. */
  async recordFill(userId: string, orderId: string, input: RecordFillInput, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId, userId);
      if (
        order.mode !== 'LIVE' ||
        !['PLACED_BY_USER', 'PARTIALLY_FILLED', 'AWAITING_MANUAL_PLACEMENT'].includes(order.status)
      ) {
        throw new ConflictException({
          message: `Cannot record a fill on a ${order.mode} ${order.status} order`,
          code: 'INVALID_ORDER_STATE',
        });
      }
      const qty = d(input.quantity);
      const price = d(input.price);
      const remaining = dec(order.quantity).minus(dec(order.filledQuantity));
      if (qty.gt(remaining))
        throw new UnprocessableEntityException({
          message: `Fill exceeds remaining ${remaining.toFixed()}`,
          code: 'OVERFILL',
        });
      const executedAt = new Date(input.executedAt);
      // A recorded fill implies the user placed the order; make that explicit in the event log.
      if (order.status === 'AWAITING_MANUAL_PLACEMENT') {
        await this.transition(tx, order, 'PLACED_BY_USER', userId, 'implied by recorded fill', {
          adapter: 'MANUAL_IMPORT',
          submittedAt: executedAt,
        });
      }
      await this.fillOrder(tx, order, qty, price, executedAt, 'USER_REPORTED', userId);
      await this.audit.record(
        {
          action: 'order.fill_recorded',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'order',
          entityId: orderId,
          after: { qty: qty.toFixed(), price: price.toFixed() },
          ...meta,
        },
        tx,
      );
    });
    return this.present(orderId, userId);
  }

  async cancel(userId: string, orderId: string, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId, userId);
      if (FINAL.includes(order.status))
        throw new ConflictException({
          message: `Order already ${order.status}`,
          code: 'INVALID_ORDER_STATE',
        });
      const atBroker =
        order.mode === 'LIVE' &&
        ['PLACED_BY_USER', 'PARTIALLY_FILLED', 'SUBMITTED', 'ACCEPTED'].includes(order.status);
      // A manually placed live order can only be cancelled by the user in KTrade; we record the request, not the outcome.
      await this.transition(
        tx,
        order,
        atBroker ? 'CANCEL_REQUESTED' : 'CANCELLED',
        userId,
        atBroker
          ? 'cancel it in the KTrade app, then record the outcome'
          : 'cancelled before reaching the broker',
      );
      await this.audit.record(
        {
          action: 'order.cancelled',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'order',
          entityId: orderId,
          metadata: { atBroker },
          ...meta,
        },
        tx,
      );
    });
    return this.present(orderId, userId);
  }

  async list(
    userId: string,
    q: { status?: OrderStatus; portfolioId?: string; limit: number; cursor?: string },
  ) {
    const rows = await this.prisma.order.findMany({
      where: {
        userId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.portfolioId ? { portfolioId: q.portfolioId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { stock: { select: { symbol: true, name: true } } },
    });
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((o) => this.serialize(o, o.stock)),
      nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
    };
  }

  async present(orderId: string, userId: string) {
    const o = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: {
        stock: { select: { symbol: true, name: true } },
        riskChecks: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        executions: { orderBy: { executedAt: 'asc' } },
      },
    });
    if (!o) throw new NotFoundException({ message: 'Order not found', code: 'NOT_FOUND' });
    return {
      ...this.serialize(o, o.stock),
      riskChecks: o.riskChecks.map((r) => ({
        rule: r.rule,
        passed: r.passed,
        observed: r.observed,
        limit: r.limit,
        message: r.message,
      })),
      events: o.events.map((e) => ({
        from: e.fromStatus,
        to: e.toStatus,
        actorType: e.actorType,
        reason: e.reason,
        at: e.createdAt.toISOString(),
      })),
      executions: o.executions.map((x) => ({
        quantity: x.quantity.toString(),
        price: x.price.toString(),
        executedAt: x.executedAt.toISOString(),
        source: x.source,
      })),
      warnings:
        o.mode === 'LIVE'
          ? [
              'Live execution is manual: place approved orders in the KTrade app, then record the fill. Contract notes confirm it.',
            ]
          : ['Paper trading: simulated fills, no real money.'],
    };
  }

  // ── Kill switch ────────────────────────────────────────────────────────────

  async killSwitch(): Promise<{ liveTradingEnabled: boolean }> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: KILL_SWITCH_KEY } });
    return { liveTradingEnabled: row?.value === true };
  }

  async setKillSwitch(userId: string, enabled: boolean, reason: string, meta: RequestMeta) {
    const before = await this.killSwitch();
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: KILL_SWITCH_KEY },
        create: { key: KILL_SWITCH_KEY, value: enabled, updatedById: userId },
        update: { value: enabled, updatedById: userId },
      });
      await this.audit.record(
        {
          action: 'killswitch.toggled',
          actorType: 'USER',
          actorUserId: userId,
          before,
          after: { liveTradingEnabled: enabled },
          metadata: { reason },
          ...meta,
        },
        tx,
      );
    });
    return { liveTradingEnabled: enabled };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async runRisk(
    tx: Tx,
    p: {
      portfolioId: string;
      stockId: string;
      mode: 'PAPER' | 'LIVE';
      side: 'BUY' | 'SELL';
      type: 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'STOP_LIMIT';
      qty: Decimal;
      limitPrice: Decimal | null;
      stopPrice: Decimal | null;
      refPrice: Decimal;
      estTotal: Decimal;
      quote: { source: DataSource; asOf: Date };
      now: Date;
      excludeOrderId?: string;
    },
  ): Promise<RiskEvaluation> {
    const limits = await tx.riskLimit.findUnique({ where: { portfolioId: p.portfolioId } });
    if (!limits)
      throw new ConflictException({
        message: 'Configure risk limits for this portfolio before trading',
        code: 'NO_RISK_LIMITS',
      });
    const today = new Date(`${pktTradeDate(p.now)}T00:00:00+05:00`);
    const exclude = p.excludeOrderId ? { id: { not: p.excludeOrderId } } : {};

    const [cash, holdings, working, todays, holidays, killSwitch] = await Promise.all([
      this.ledger.cashBalance(tx, p.portfolioId),
      tx.holding.findMany({
        where: { portfolioId: p.portfolioId },
        select: { stockId: true, quantity: true },
      }),
      tx.order.findMany({
        where: { portfolioId: p.portfolioId, status: { in: WORKING }, ...exclude },
        select: { side: true, stockId: true, estTotal: true, quantity: true, filledQuantity: true },
      }),
      tx.order.findMany({
        where: {
          portfolioId: p.portfolioId,
          createdAt: { gte: today },
          status: { notIn: ['REJECTED_BY_RISK', 'EXPIRED', 'CANCELLED', 'PREVIEWED'] },
          ...exclude,
        },
        select: { estNotional: true },
      }),
      tx.marketHoliday.findMany({ select: { date: true } }),
      tx.systemSetting.findUnique({ where: { key: KILL_SWITCH_KEY } }),
    ]);
    const heldMap = new Map(holdings.map((h) => [h.stockId, dec(h.quantity)]));
    const prices = await tx.stockQuote.findMany({
      where: { stockId: { in: [...heldMap.keys(), p.stockId] } },
      select: { stockId: true, last: true },
    });
    const priceMap = new Map(prices.map((q) => [q.stockId, dec(q.last)]));
    let holdingsValue = ZERO;
    for (const [sid, q] of heldMap) holdingsValue = holdingsValue.plus(q.times(priceMap.get(sid) ?? ZERO));
    const pendingBuyValue = working
      .filter((o) => o.side === 'BUY')
      .reduce((a, o) => a.plus(dec(o.estTotal)), ZERO);
    const pendingSellQty = working
      .filter((o) => o.side === 'SELL' && o.stockId === p.stockId)
      .reduce((a, o) => a.plus(dec(o.quantity).minus(dec(o.filledQuantity))), ZERO);
    const heldQty = heldMap.get(p.stockId) ?? ZERO;
    const todayPnlPct = await this.todayPnlPct(p.portfolioId);

    return evaluateRisk({
      order: {
        side: p.side,
        type: p.type,
        qty: p.qty,
        limitPrice: p.limitPrice,
        stopPrice: p.stopPrice,
        refPrice: p.refPrice,
        estimatedTotal: p.estTotal,
      },
      portfolio: {
        cash,
        pendingBuyValue,
        heldQty,
        pendingSellQty,
        positionValue: heldQty.times(p.refPrice),
        portfolioValue: cash.plus(holdingsValue),
        todayTradedValue: todays.reduce((a, o) => a.plus(dec(o.estNotional)), ZERO),
        todayOrderCount: todays.length,
        todayPnlPct,
      },
      limits: {
        maxOrderValue: dec(limits.maxOrderValue),
        maxOrderQty: dec(limits.maxOrderQty),
        maxDailyTradedValue: dec(limits.maxDailyTradedValue),
        maxDailyOrders: limits.maxDailyOrders,
        maxPositionPct: dec(limits.maxPositionPct),
        priceBandPct: dec(limits.priceBandPct),
        maxDailyLossPct: dec(limits.maxDailyLossPct),
        allowMarketOrders: limits.allowMarketOrders,
      },
      flags: {
        mode: p.mode,
        killSwitchOn: killSwitch?.value === true,
        // LIVE today = manual-ticket path: the user places the order personally, which is always permitted.
        // An automated adapter path would require the broker capability chain (broker-sdk guardedCall).
        capabilityUsable: true,
        // Paper trading is a simulation and may run outside PSX hours (ADR-021).
        marketOpen:
          p.mode === 'PAPER' ||
          isPsxSessionOpen(p.now, new Set(holidays.map((h) => h.date.toISOString().slice(0, 10)))),
        priceIsSimulated: p.quote.source === 'SIMULATED',
        priceIsStale: p.now.getTime() - p.quote.asOf.getTime() > QUOTE_FRESHNESS_MS,
      },
    });
  }

  private async paperExecute(
    tx: Tx,
    order: Order,
    quote: { last: { toString(): string }; volume: bigint | null },
    now: Date,
    userId: string,
    actor: OrderActor = 'USER',
  ) {
    const fill = paperFill(
      {
        side: order.side,
        type: order.type === 'LIMIT' ? 'LIMIT' : 'MARKET',
        qty: dec(order.quantity),
        limitPrice: order.limitPrice ? dec(order.limitPrice) : null,
      },
      { last: dec(quote.last) },
      { slippageBps: PAPER_SLIPPAGE_BPS },
    );
    if (!fill.filled || !fill.price) {
      await this.transition(tx, order, 'ACCEPTED', userId, `working (paper): ${fill.reason}`, {}, actor);
      return;
    }
    await this.transition(tx, order, 'ACCEPTED', userId, 'paper broker accepted', {}, actor);
    await this.fillOrder(
      tx,
      { ...order, status: 'ACCEPTED' },
      fill.qty,
      fill.price,
      now,
      'SIMULATED',
      userId,
      actor,
    );
  }

  private async fillOrder(
    tx: Tx,
    order: Order,
    qty: Decimal,
    price: Decimal,
    executedAt: Date,
    source: DataSource,
    userId: string,
    actor: OrderActor = 'USER',
  ) {
    const exec = await tx.orderExecution.create({
      data: {
        orderId: order.id,
        portfolioId: order.portfolioId,
        stockId: order.stockId,
        side: order.side,
        quantity: qty.toFixed(),
        price: price.toFixed(),
        executedAt,
        source,
      },
    });
    const tradeDate = pktTradeDate(executedAt);
    const fees = await this.fees.estimate(order.side, qty, price, tradeDate);
    await this.ledger.postTrade(tx, {
      portfolioId: order.portfolioId,
      stockId: order.stockId,
      side: order.side,
      quantity: qty,
      price,
      tradeDate,
      fees: feeLinesFromBreakdown(fees.lines).map((f) => ({
        ...f,
        source: source === 'SIMULATED' ? 'SIMULATED' : 'ESTIMATED',
      })),
      source,
      executionId: exec.id,
      feeScheduleId: fees.scheduleId,
    });
    const filled = dec(order.filledQuantity).plus(qty);
    const prevAvg = order.avgFillPrice ? dec(order.avgFillPrice) : null;
    const avg = prevAvg ? prevAvg.times(dec(order.filledQuantity)).plus(price.times(qty)).div(filled) : price;
    const done = filled.gte(dec(order.quantity));
    await this.transition(
      tx,
      order,
      done ? 'FILLED' : 'PARTIALLY_FILLED',
      userId,
      `${source} fill ${qty.toFixed()} @ ${price.toFixed()}`,
      {
        filledQuantity: filled.toFixed(),
        avgFillPrice: avg.toDecimalPlaces(6).toFixed(),
        statusSource: source,
      },
      actor,
    );
  }

  /** Optimistic state transition: succeeds only if the order is still in the state we read (no lost updates). */
  private async transition(
    tx: Tx,
    order: Pick<Order, 'id' | 'status'>,
    to: OrderStatus,
    userId: string,
    reason: string,
    extra: Prisma.OrderUncheckedUpdateManyInput = {},
    actorType: OrderActor = 'USER',
  ) {
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: order.status },
      data: { status: to, ...extra },
    });
    if (count !== 1)
      throw new ConflictException({
        message: 'Order changed concurrently — reload',
        code: 'CONCURRENT_MODIFICATION',
      });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: to,
        actorType,
        actorId: userId,
        reason,
      },
    });
    order.status = to;
    if (to === 'FILLED' || to === 'REJECTED_BY_RISK') await this.notifyOrder(tx, order, to);
  }

  /** In-app ORDER_EXECUTED / ORDER_REJECTED notification, in the same transaction; deduped per (order, status). */
  private async notifyOrder(
    tx: Tx,
    order: Pick<Order, 'id'>,
    to: 'FILLED' | 'REJECTED_BY_RISK',
    symbol?: string,
  ) {
    const o = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      select: {
        userId: true,
        side: true,
        quantity: true,
        mode: true,
        avgFillPrice: true,
        statusSource: true,
        rejectionReason: true,
        stock: { select: { symbol: true } },
      },
    });
    const sym = symbol ?? o.stock.symbol;
    const filled = to === 'FILLED';
    await this.notifications.notify(
      {
        userId: o.userId,
        type: filled ? 'ORDER_EXECUTED' : 'ORDER_REJECTED',
        title: filled
          ? `${o.mode} order filled: ${o.side} ${sym}`
          : `${o.mode} order rejected by risk checks: ${sym}`,
        body: filled
          ? `${o.side} ${o.quantity.toString()} ${sym} @ ${o.avgFillPrice?.toString() ?? '—'} (${o.statusSource})`
          : `${o.side} ${o.quantity.toString()} ${sym}: ${o.rejectionReason ?? 'risk checks failed'}`,
        dedupeKey: `order:${order.id}:${to}`,
        data: { orderId: order.id, symbol: sym, status: to, source: o.statusSource },
      },
      tx,
    );
  }

  private async lockOrder(tx: Tx, orderId: string, userId: string): Promise<Order> {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM orders WHERE id = ${orderId}::uuid AND "userId" = ${userId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException({ message: 'Order not found', code: 'NOT_FOUND' });
    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  }

  /** Serialises risk evaluation per portfolio so daily limits cannot be raced past. */
  private async lockPortfolio(tx: Tx, portfolioId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portfolio-risk:${portfolioId}`}, 0))`;
  }

  private async ownedPortfolio(userId: string, portfolioId: string) {
    const p = await this.prisma.portfolio.findFirst({ where: { id: portfolioId, userId, archivedAt: null } });
    if (!p) throw new NotFoundException({ message: 'Portfolio not found', code: 'NOT_FOUND' });
    if (p.kind === 'LIVE' && !p.brokerAccountId)
      throw new ForbiddenException({
        message: 'Live portfolio has no broker account',
        code: 'NO_BROKER_ACCOUNT',
      });
    return p;
  }

  private serialize(o: Order, stock: { symbol: string; name: string }) {
    return {
      id: o.id,
      portfolioId: o.portfolioId,
      symbol: stock.symbol,
      companyName: stock.name,
      mode: o.mode,
      origin: o.origin,
      side: o.side,
      type: o.type,
      quantity: o.quantity.toString(),
      limitPrice: o.limitPrice?.toString() ?? null,
      stopPrice: o.stopPrice?.toString() ?? null,
      referencePrice: o.referencePrice
        ? { value: o.referencePrice.toString(), source: o.referencePriceSrc }
        : null,
      status: o.status,
      statusSource: o.statusSource,
      filledQuantity: o.filledQuantity.toString(),
      avgFillPrice: o.avgFillPrice?.toString() ?? null,
      estimate: {
        notional: o.estNotional?.toString() ?? null,
        fees: o.estFees?.toString() ?? null,
        total: o.estTotal?.toString() ?? null,
        source: 'ESTIMATED' as const,
      },
      previewHash: o.status === 'PREVIEWED' ? o.previewHash : null,
      previewExpiresAt: o.previewExpiresAt?.toISOString() ?? null,
      rejectionReason: o.rejectionReason,
      brokerOrderRef: o.brokerOrderRef,
      createdAt: o.createdAt.toISOString(),
    };
  }
}
