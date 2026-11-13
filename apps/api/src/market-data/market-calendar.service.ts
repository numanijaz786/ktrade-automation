import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PsxCalendar } from './calendar.js';

const REFRESH_MS = 10 * 60_000;

/**
 * Holds the PSX calendar with holidays from `market_holidays`, reloaded at most every 10 minutes.
 * `current()` is synchronous for the providers; callers `refresh()` before a batch of work.
 * If the DB is unreachable the previous calendar is kept (weekends still apply).
 */
@Injectable()
export class MarketCalendarService {
  private readonly logger = new Logger('MarketCalendar');
  private calendar = new PsxCalendar();
  private loadedAt: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  current(): PsxCalendar {
    return this.calendar;
  }

  async refresh(force = false): Promise<PsxCalendar> {
    const now = this.clock.now().getTime();
    if (!force && this.loadedAt !== null && now - this.loadedAt < REFRESH_MS) return this.calendar;
    try {
      const rows = await this.prisma.marketHoliday.findMany({ select: { date: true } });
      this.calendar = new PsxCalendar(rows.map((r) => r.date.toISOString().slice(0, 10)));
      this.loadedAt = now;
    } catch (err) {
      this.logger.warn(`Could not load market holidays: ${(err as Error).message}`);
    }
    return this.calendar;
  }
}
