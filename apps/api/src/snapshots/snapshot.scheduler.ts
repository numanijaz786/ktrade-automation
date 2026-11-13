import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { AppConfig } from '../config/config.module.js';
import { pktDateOf, pktInstant } from '../market-data/calendar.js';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SnapshotService } from './snapshot.service.js';

export const SNAPSHOT_CHECK_MS = 5 * 60_000;
/** Snapshots run after 16:00 PKT (EOD bars land after the 15:30 close; docs/08 §8). */
export const SNAPSHOT_AFTER_MINUTE = 16 * 60;

/**
 * Daily EOD snapshot job (SNAPSHOT_SCHEDULER=true). Every 5 minutes: on a trading day after 16:00 PKT, snapshot
 * every non-archived portfolio that has no snapshot for today yet. Idempotent (upsert) and single-flight;
 * the timer is unref'd so it never keeps the process alive.
 */
@Injectable()
export class SnapshotScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SnapshotScheduler');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly snapshots: SnapshotService,
    private readonly calendar: MarketCalendarService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('SNAPSHOT_SCHEDULER')) return;
    this.timer = setInterval(() => void this.runOnce(), SNAPSHOT_CHECK_MS);
    this.timer.unref();
    this.logger.log('Daily snapshot scheduler enabled (after 16:00 PKT on trading days)');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One scheduler tick. Returns the number of portfolios snapshotted (0 when not due). */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = this.clock.now();
      const today = pktDateOf(now);
      const cal = await this.calendar.refresh();
      if (!cal.isTradingDay(today) || now < pktInstant(today, SNAPSHOT_AFTER_MINUTE)) return 0;
      const due = await this.prisma.portfolio.findMany({
        where: { archivedAt: null, snapshots: { none: { date: new Date(`${today}T00:00:00Z`) } } },
        select: { id: true },
      });
      let done = 0;
      for (const p of due) {
        try {
          await this.snapshots.build(p.id, today);
          done++;
        } catch (err) {
          this.logger.warn(`Snapshot ${p.id} ${today} failed: ${(err as Error).message}`);
        }
      }
      return done;
    } catch (err) {
      this.logger.warn(`Snapshot run failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
