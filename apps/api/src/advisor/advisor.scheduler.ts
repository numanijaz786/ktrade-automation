import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { AppConfig } from '../config/config.module.js';
import { pktDateOf, pktInstant } from '../market-data/calendar.js';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OutcomeEvaluator } from '../recommendations/outcome-evaluator.service.js';
import { AdvisorAlertsService } from './advisor-alerts.service.js';
import { AdvisorService } from './advisor.service.js';

export const ADVISOR_CHECK_MS = 10 * 60_000;
/** After the 15:30 PKT close with a margin for the closing prints and the other post-close jobs. */
export const ADVISOR_AFTER_MINUTE = 15 * 60 + 45;

export interface AdvisorTickSummary {
  ran: boolean;
  reason?: string;
  portfolios: number;
  stored: number;
  failed: number;
  outcomesAppended: number;
  notificationsCreated: number;
}

const empty = (reason: string): AdvisorTickSummary => ({
  ran: false,
  reason,
  portfolios: 0,
  stored: 0,
  failed: 0,
  outcomesAppended: 0,
  notificationsCreated: 0,
});

/**
 * ADVISOR_SCHEDULER=true: after the close on a PSX trading day, run the advisor for every owner portfolio, append
 * outcomes, then raise IN_APP notifications. Everything is idempotent (recommendations per bar/engine version,
 * outcomes per bar, notifications per dedupe key), so a restart or a second instance repeats nothing. The in-process
 * guard only avoids redoing the work every interval once a day has completed.
 */
@Injectable()
export class AdvisorScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AdvisorScheduler');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private doneFor: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly advisor: AdvisorService,
    private readonly outcomes: OutcomeEvaluator,
    private readonly alerts: AdvisorAlertsService,
    private readonly calendar: MarketCalendarService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('ADVISOR_SCHEDULER')) return;
    this.timer = setInterval(() => void this.tick(), ADVISOR_CHECK_MS);
    this.timer.unref();
    this.logger.log('Advisor scheduler enabled (after 15:45 PKT on trading days)');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One tick. Never throws. `force` ignores the once-a-day guard (tests, manual use). */
  async tick(force = false): Promise<AdvisorTickSummary> {
    if (this.running) return empty('a tick is already running');
    this.running = true;
    try {
      const now = this.clock.now();
      const today = pktDateOf(now);
      const cal = await this.calendar.refresh();
      if (!cal.isTradingDay(today)) return empty('not a PSX trading day');
      if (now < pktInstant(today, ADVISOR_AFTER_MINUTE)) return empty('before 15:45 PKT');
      if (!force && this.doneFor === today) return empty('already completed today');

      const s: AdvisorTickSummary = { ...empty(''), ran: true, reason: undefined };
      const portfolios = await this.prisma.portfolio.findMany({
        where: { archivedAt: null, user: { role: 'OWNER' } },
        select: { id: true, userId: true },
        orderBy: { createdAt: 'asc' },
      });
      s.portfolios = portfolios.length;
      const ok: typeof portfolios = [];
      for (const p of portfolios) {
        try {
          const r = await this.advisor.run(p.userId, { portfolioId: p.id }, 'SYSTEM');
          s.stored += r.stored;
          s.failed += r.failed.length;
          ok.push(p);
        } catch (err) {
          s.failed++;
          this.logger.warn(`Advisor run for portfolio ${p.id} failed: ${(err as Error).message}`);
        }
      }
      const ev = await this.outcomes.evaluateOpen(null);
      s.outcomesAppended = ev.appended;
      for (const p of ok) {
        try {
          s.notificationsCreated += (await this.alerts.generate(p.userId, p.id)).created;
        } catch (err) {
          s.failed++;
          this.logger.warn(`Advisor notifications for portfolio ${p.id} failed: ${(err as Error).message}`);
        }
      }
      if (s.failed === 0) this.doneFor = today;
      this.logger.log(
        `Advisor tick ${today}: ${s.portfolios} portfolios, ${s.stored} stored, ${s.outcomesAppended} outcomes, ${s.notificationsCreated} notifications, ${s.failed} failed`,
      );
      return s;
    } catch (err) {
      this.logger.warn(`Advisor tick failed: ${(err as Error).message}`);
      return empty(`failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
