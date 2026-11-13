import { Inject, Injectable, Logger } from '@nestjs/common';
import { d, type Decimal, sum } from '@ktrade/finance-core';
import { CLOCK, type Clock } from '../common/clock.js';
import { pktDateOf, pktInstant } from '../market-data/calendar.js';
import { MarketDataService, type QuoteView } from '../market-data/market-data.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PerformanceService } from '../snapshots/performance.service.js';
import { toDec } from '../snapshots/snapshot-math.js';
import {
  type AlertDecision,
  type AlertInputs,
  alertDedupeKey,
  decideAlert,
  EVALUABLE_ALERT_TYPES,
  type EvaluableAlertType,
  suppressed,
} from './alert-rules.js';

const PRICE_TYPES = new Set<EvaluableAlertType>([
  'PRICE_ABOVE',
  'PRICE_BELOW',
  'PCT_CHANGE_ABOVE',
  'PCT_CHANGE_BELOW',
  'VOLUME_SPIKE',
  'POSITION_STOP_LOSS',
]);

const TITLES: Record<EvaluableAlertType, string> = {
  PRICE_ABOVE: 'Price above',
  PRICE_BELOW: 'Price below',
  PCT_CHANGE_ABOVE: 'Up move',
  PCT_CHANGE_BELOW: 'Down move',
  VOLUME_SPIKE: 'Volume spike',
  PORTFOLIO_DAILY_LOSS: 'Portfolio daily loss',
  POSITION_STOP_LOSS: 'Stop-loss level reached',
};

export interface EvaluationSummary {
  evaluatedAt: string;
  evaluated: number;
  fired: { alertId: string; type: string; observed: string; notificationsCreated: number }[];
  skipped: Record<string, number>;
}

/**
 * Gathers inputs (quotes via MarketDataService, 20-day volume from stock_prices, portfolio daily P&L from
 * snapshots + live quotes, positions from holdings) and applies the pure `decideAlert`.
 *
 * Firing is race-safe: a conditional UPDATE claims the firing (still active and outside its cooldown) and the
 * notification insert uses a per-window dedupe key — both in one transaction — so concurrent or retried
 * evaluations produce exactly one notification.
 */
@Injectable()
export class AlertEvaluatorService {
  private readonly logger = new Logger('AlertEvaluator');

  constructor(
    private readonly prisma: PrismaService,
    private readonly market: MarketDataService,
    private readonly performance: PerformanceService,
    private readonly notifications: NotificationsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Evaluate active alerts (all users, or one user's). */
  async evaluate(userId?: string): Promise<EvaluationSummary> {
    const now = this.clock.now();
    const alerts = await this.prisma.alert.findMany({
      where: { isActive: true, type: { in: [...EVALUABLE_ALERT_TYPES] }, ...(userId ? { userId } : {}) },
      include: { stock: { select: { id: true, symbol: true } } },
    });
    const summary: EvaluationSummary = {
      evaluatedAt: now.toISOString(),
      evaluated: alerts.length,
      fired: [],
      skipped: {},
    };
    const skip = (reason: string) => (summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1);

    const states = alerts.map((a) => ({
      row: a,
      state: {
        id: a.id,
        type: a.type as EvaluableAlertType,
        threshold: toDec(a.threshold),
        isActive: a.isActive,
        triggerOnce: a.triggerOnce,
        cooldownMinutes: a.cooldownMinutes,
        lastTriggeredAt: a.lastTriggeredAt,
      },
    }));
    // Cheap pre-filter: don't fetch inputs for alerts that cannot fire now.
    const candidates = states.filter(({ state }) => {
      const blocked = suppressed(state, now);
      if (blocked && !blocked.fire) skip(blocked.reason);
      return !blocked;
    });

    const symbols = [
      ...new Set(
        candidates
          .filter((c) => PRICE_TYPES.has(c.state.type) && c.row.stock)
          .map((c) => c.row.stock!.symbol),
      ),
    ];
    const quotes = new Map<string, QuoteView>();
    if (symbols.length) {
      try {
        for (const q of await this.market.quotes(symbols)) quotes.set(q.symbol, q);
      } catch (err) {
        this.logger.warn(`Quotes unavailable for alert evaluation: ${(err as Error).message}`);
      }
    }
    const avgVolume = new Map<string, Decimal | null>();
    const dailyReturn = new Map<string, Decimal | null>();

    for (const { row, state } of candidates) {
      const inputs: AlertInputs = {};
      const q = row.stock ? quotes.get(row.stock.symbol) : undefined;
      if (q) {
        inputs.last = d(q.last);
        inputs.changePct = q.changePct !== undefined ? d(q.changePct) : null;
        inputs.volume = q.volume !== undefined ? d(q.volume) : null;
      }
      if (state.type === 'VOLUME_SPIKE' && row.stock) {
        if (!avgVolume.has(row.stock.id))
          avgVolume.set(row.stock.id, await this.avgVolume20d(row.stock.id, now));
        inputs.avgVolume20d = avgVolume.get(row.stock.id) ?? null;
      }
      if (state.type === 'PORTFOLIO_DAILY_LOSS' && row.portfolioId) {
        if (!dailyReturn.has(row.portfolioId)) {
          const live = await this.performance.liveValuation(row.portfolioId);
          dailyReturn.set(
            row.portfolioId,
            (await this.performance.today(row.portfolioId, live))?.ret ?? null,
          );
        }
        inputs.portfolioDailyReturn = dailyReturn.get(row.portfolioId) ?? null;
      }
      if (state.type === 'POSITION_STOP_LOSS' && row.portfolioId && row.stock) {
        const h = await this.prisma.holding.findUnique({
          where: { portfolioId_stockId: { portfolioId: row.portfolioId, stockId: row.stock.id } },
        });
        inputs.position = h ? { quantity: toDec(h.quantity), avgCost: toDec(h.avgCost) } : null;
      }

      const decision = decideAlert(state, inputs, now);
      if (!decision.fire) {
        skip(decision.reason);
        continue;
      }
      const created = await this.fire(row, state, decision, now);
      if (created === null) skip('LOST_RACE');
      else
        summary.fired.push({
          alertId: row.id,
          type: row.type,
          observed: decision.observed,
          notificationsCreated: created,
        });
    }
    return summary;
  }

  private async fire(
    row: {
      id: string;
      userId: string;
      type: string;
      channels: string[];
      updatedAt: Date;
      stock: { symbol: string } | null;
      portfolioId: string | null;
    },
    state: { id: string; type: EvaluableAlertType; triggerOnce: boolean; cooldownMinutes: number },
    decision: Extract<AlertDecision, { fire: true }>,
    now: Date,
  ): Promise<number | null> {
    const cooldownStart = new Date(now.getTime() - Math.max(state.cooldownMinutes, 1) * 60_000);
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.alert.updateMany({
        where: {
          id: row.id,
          isActive: true,
          ...(state.triggerOnce
            ? { lastTriggeredAt: null }
            : { OR: [{ lastTriggeredAt: null }, { lastTriggeredAt: { lte: cooldownStart } }] }),
        },
        data: { lastTriggeredAt: now, ...(state.triggerOnce ? { isActive: false } : {}) },
      });
      if (claim.count !== 1) return null;
      const subject = row.stock?.symbol ?? 'Portfolio';
      const { created } = await this.notifications.notify(
        {
          userId: row.userId,
          type: state.type,
          title: `${subject}: ${TITLES[state.type]}`,
          body: `${subject} ${decision.observed} (alert: ${decision.condition})`,
          dedupeKey: alertDedupeKey({ ...state, activatedAt: row.updatedAt }, now),
          alertId: row.id,
          channels: row.channels as ('IN_APP' | 'EMAIL' | 'TELEGRAM')[],
          data: {
            alertId: row.id,
            symbol: row.stock?.symbol ?? null,
            portfolioId: row.portfolioId,
            observed: decision.observed,
            condition: decision.condition,
          },
        },
        tx,
      );
      return created;
    });
  }

  /** Average D1 volume over the last 20 sessions completed before today's PKT date; null without history. */
  private async avgVolume20d(stockId: string, now: Date): Promise<Decimal | null> {
    const bars = await this.prisma.stockPrice.findMany({
      where: { stockId, interval: 'D1', isAdjusted: false, ts: { lt: pktInstant(pktDateOf(now), 0) } },
      orderBy: { ts: 'desc' },
      take: 20,
      select: { volume: true },
    });
    return bars.length ? sum(bars.map((b) => d(b.volume.toString()))).div(bars.length) : null;
  }
}
