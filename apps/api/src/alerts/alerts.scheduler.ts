import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { AppConfig } from '../config/config.module.js';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { AlertEvaluatorService } from './alert-evaluator.service.js';

export const ALERTS_INTERVAL_MS = 60_000;

/** ALERTS_SCHEDULER=true: evaluate alerts every 60 s while the PSX regular session is open. Single-flight, unref'd. */
@Injectable()
export class AlertsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AlertsScheduler');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly evaluator: AlertEvaluatorService,
    private readonly calendar: MarketCalendarService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('ALERTS_SCHEDULER')) return;
    this.timer = setInterval(() => void this.tick(), ALERTS_INTERVAL_MS);
    this.timer.unref();
    this.logger.log(`Alert evaluation every ${ALERTS_INTERVAL_MS / 1000}s during market hours`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const cal = await this.calendar.refresh();
      if (!cal.isOpen(this.clock.now())) return false;
      await this.evaluator.evaluate();
      return true;
    } catch (err) {
      this.logger.warn(`Alert evaluation failed: ${(err as Error).message}`);
      return false;
    } finally {
      this.running = false;
    }
  }
}
