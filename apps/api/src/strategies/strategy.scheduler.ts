import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { AppConfig } from '../config/config.module.js';
import { pktDateOf, pktInstant } from '../market-data/calendar.js';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StrategiesService } from './strategies.service.js';
import { StrategyDataService } from './strategy-data.service.js';

export const STRATEGY_CHECK_MS = 5 * 60_000;
/** Evaluate after the 15:30 PKT close, with a small margin for the closing prints (docs/08 §8). */
export const STRATEGY_AFTER_MINUTE = 15 * 60 + 35;
/** A bar whose evaluation failed this many times is not retried again (the run log keeps every failure). */
export const MAX_ATTEMPTS_PER_BAR = 3;
/** Upper bound for one strategy's evaluation while its advisory lock is held. */
const EVALUATION_TIMEOUT_MS = 120_000;

export type StrategyTickOutcome = 'evaluated' | 'already_done' | 'busy' | 'no_bars' | 'unsupported_interval';

export interface StrategyTickSummary {
  ran: boolean;
  /** Why the tick did nothing (when `ran` is false). */
  reason?: string;
  strategies: number;
  evaluated: number;
  signalsCreated: number;
  skipped: number;
  failed: number;
  expiredSignals: number;
}

const empty = (reason: string): StrategyTickSummary => ({
  ran: false,
  reason,
  strategies: 0,
  evaluated: 0,
  signalsCreated: 0,
  skipped: 0,
  failed: 0,
  expiredSignals: 0,
});

/**
 * Scheduled strategy evaluation (STRATEGY_SCHEDULER=true). Every 5 minutes, on a PSX trading day at or after
 * 15:35 PKT, every ACTIVE strategy is evaluated once per completed bar through the same
 * `StrategiesService.evaluate` path as the manual trigger, so the execution policy is unchanged: PAPER +
 * autoExecute goes through the system PAPER approval; LIVE only records a signal (+ notification), never an order.
 *
 * Exactly-once per (strategy, bar), across restarts and concurrent ticks or instances:
 *  1. "done" = a SUCCEEDED run-log row for that bar (or MAX_ATTEMPTS_PER_BAR failures), checked before and again
 *     after taking the lock;
 *  2. a transaction-scoped Postgres advisory lock per (strategy, bar), taken with pg_try_… so a concurrent tick
 *     skips instead of queueing; the lock is held until the evaluation has written its run-log row;
 *  3. the signal unique key (strategyId, barTs, type, reason) and the order idempotency key are the backstop.
 * In-process ticks are also single-flight. The timer is unref'd so it never keeps the process alive.
 */
@Injectable()
export class StrategyScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('StrategyScheduler');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly strategies: StrategiesService,
    private readonly data: StrategyDataService,
    private readonly calendar: MarketCalendarService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('STRATEGY_SCHEDULER')) return;
    this.timer = setInterval(() => void this.tick(), STRATEGY_CHECK_MS);
    this.timer.unref();
    this.logger.log('Strategy scheduler enabled (every 5 min; after 15:35 PKT on trading days)');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One scheduler tick. Never throws. */
  async tick(): Promise<StrategyTickSummary> {
    if (this.running) return empty('a tick is already running');
    this.running = true;
    try {
      const now = this.clock.now();
      const today = pktDateOf(now);
      const cal = await this.calendar.refresh();
      if (!cal.isTradingDay(today)) return empty('not a PSX trading day');
      if (now < pktInstant(today, STRATEGY_AFTER_MINUTE)) return empty('before 15:35 PKT');

      const summary: StrategyTickSummary = { ...empty(''), ran: true, reason: undefined };
      summary.expiredSignals = await this.strategies.expireStaleSignals();
      const active = await this.prisma.tradingStrategy.findMany({
        where: { isActive: true },
        select: { id: true, userId: true, stockId: true, interval: true },
        orderBy: { createdAt: 'asc' },
      });
      summary.strategies = active.length;
      for (const s of active) {
        try {
          const r = await this.evaluateOnce(s);
          if (r.outcome === 'evaluated') {
            summary.evaluated++;
            if (r.signalCreated) summary.signalsCreated++;
          } else summary.skipped++;
        } catch (err) {
          summary.failed++;
          this.logger.warn(`Strategy ${s.id} evaluation failed: ${(err as Error).message}`);
        }
      }
      this.logger.log(
        `Strategy tick ${today}: ${summary.strategies} active, ${summary.evaluated} evaluated, ` +
          `${summary.signalsCreated} new signals, ${summary.skipped} skipped, ${summary.failed} failed, ` +
          `${summary.expiredSignals} signals expired`,
      );
      return summary;
    } catch (err) {
      this.logger.warn(`Strategy tick failed: ${(err as Error).message}`);
      return empty(`failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Evaluate one strategy at its latest completed bar unless that bar is already done (or being done). */
  async evaluateOnce(s: {
    id: string;
    userId: string;
    stockId: string;
    interval: string;
  }): Promise<{ outcome: StrategyTickOutcome; signalCreated: boolean }> {
    const skip = (outcome: StrategyTickOutcome) => ({ outcome, signalCreated: false });
    if (s.interval !== 'D1') return skip('unsupported_interval');
    const latest = await this.data.latestCompleted(s.stockId, 1);
    const bar = latest.bars[0];
    if (!bar) return skip('no_bars');
    const barTs = new Date(bar.ts);
    if (await this.barDone(s.id, barTs)) return skip('already_done');

    return this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${`strategy-eval:${s.id}:${bar.ts}`}, 0)) AS locked`;
        if (!row?.locked) return skip('busy');
        // Re-check under the lock: another tick may have finished this bar after our first check.
        if (await this.barDone(s.id, barTs)) return skip('already_done');
        const res = await this.strategies.evaluate(s.userId, s.id, {}, 'SYSTEM');
        return { outcome: 'evaluated' as const, signalCreated: res.signal !== null && !res.duplicate };
      },
      { timeout: EVALUATION_TIMEOUT_MS, maxWait: 10_000 },
    );
  }

  private async barDone(strategyId: string, barTs: Date): Promise<boolean> {
    const [succeeded, failed] = await Promise.all([
      this.prisma.strategyExecution.count({ where: { strategyId, barTs, status: 'SUCCEEDED' } }),
      this.prisma.strategyExecution.count({
        where: { strategyId, status: 'FAILED', startedAt: { gte: barTs } },
      }),
    ]);
    return succeeded > 0 || failed >= MAX_ATTEMPTS_PER_BAR;
  }
}
