import { Inject, Injectable } from '@nestjs/common';
import { type Decimal, HUNDRED, round } from '@ktrade/finance-core';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { addDays, pktDateOf, pktInstant } from '../market-data/calendar.js';
import { fromDb } from '../market-data/decimal-format.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type EvalBar, evaluateOutcome } from './outcome-evaluation.js';

/** Calendar days an open recommendation lives when it carries no explicit window (by horizon). */
export const DEFAULT_HOLDING_DAYS = { SHORT_TERM: 30, MEDIUM_TERM: 90, LONG_TERM: 365 } as const;

const toDate = (s: string): Date => new Date(`${s}T00:00:00Z`);
const day = (d0: Date): string => d0.toISOString().slice(0, 10);

export interface EvaluationSummary {
  considered: number;
  appended: number;
  closed: number;
  /** Recommendations with no stored bar after their as-of bar yet (nothing to evaluate). */
  noNewData: number;
  evaluatedAt: string;
}

/**
 * Appends outcome rows for OPEN ACTIONABLE recommendations from stored D1 bars. Nothing is rewritten: each
 * run adds a row only when a newer bar exists than the latest stored evaluation, so re-running is a no-op.
 * Only bars strictly after the recommendation's `asOfBar` are read (no look-ahead).
 */
@Injectable()
export class OutcomeEvaluator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async evaluateOpen(actorUserId: string | null, meta: RequestMeta = {}): Promise<EvaluationSummary> {
    const now = this.clock.now();
    const today = pktDateOf(now);
    const recs = await this.prisma.recommendation.findMany({
      where: { status: 'ACTIONABLE', action: { in: ['BUY', 'SELL'] } },
      include: { outcomes: { orderBy: [{ evaluatedAt: 'desc' }, { lastBarDate: 'desc' }], take: 1 } },
      orderBy: { generatedAt: 'asc' },
    });
    const benchmark = await this.loadBenchmark();
    const summary: EvaluationSummary = {
      considered: 0,
      appended: 0,
      closed: 0,
      noNewData: 0,
      evaluatedAt: now.toISOString(),
    };

    for (const rec of recs) {
      const latest = rec.outcomes[0];
      if (latest && latest.status !== 'OPEN') continue; // finished: never re-evaluated
      if (!rec.stop || !rec.target1) continue; // DB CHECK makes this impossible for ACTIONABLE rows
      summary.considered++;
      const asOfBar = day(rec.asOfBar);
      const bars = await this.prisma.stockPrice.findMany({
        where: {
          stockId: rec.stockId,
          interval: 'D1',
          isAdjusted: false,
          ts: { gte: pktInstant(addDays(asOfBar, 1), 0) }, // strictly after the recommendation bar
        },
        orderBy: { ts: 'asc' },
      });
      const evalBars: EvalBar[] = bars.map((b) => ({
        date: pktDateOf(b.ts),
        open: fromDb(b.open),
        high: fromDb(b.high),
        low: fromDb(b.low),
        close: fromDb(b.close),
      }));
      const result = evaluateOutcome({
        action: rec.action as 'BUY' | 'SELL',
        entry: fromDb(rec.price),
        stop: fromDb(rec.stop),
        targets: [
          fromDb(rec.target1),
          rec.target2 ? fromDb(rec.target2) : null,
          rec.target3 ? fromDb(rec.target3) : null,
        ],
        asOfBar,
        maxDays: rec.holdingDaysMax ?? DEFAULT_HOLDING_DAYS[rec.horizon],
        bars: evalBars,
        today,
      });
      if (!result) {
        summary.noNewData++;
        continue;
      }
      if (latest && day(latest.lastBarDate) === result.lastBarDate && latest.status === result.status) {
        summary.noNewData++; // nothing newer than the stored evaluation
        continue;
      }
      const endDate = result.closedAt ?? result.lastBarDate;
      await this.prisma.recommendationOutcome.create({
        data: {
          recommendationId: rec.id,
          evaluatedAt: now,
          lastBarDate: toDate(result.lastBarDate),
          status: result.status,
          maxFavourable: result.maxFavourable.toFixed(4),
          maxAdverse: result.maxAdverse.toFixed(4),
          target1HitAt: result.targetHitAt[0] ? toDate(result.targetHitAt[0]) : null,
          target2HitAt: result.targetHitAt[1] ? toDate(result.targetHitAt[1]) : null,
          target3HitAt: result.targetHitAt[2] ? toDate(result.targetHitAt[2]) : null,
          stopHitAt: result.stopHitAt ? toDate(result.stopHitAt) : null,
          closedAt: result.closedAt ? toDate(result.closedAt) : null,
          exitPrice: result.exitPrice ? result.exitPrice.toFixed() : null,
          returnPct: result.returnPct.toFixed(4),
          holdingDays: result.holdingDays,
          benchmarkReturnPct: benchmark(asOfBar, endDate)?.toFixed(4) ?? null,
        },
      });
      summary.appended++;
      if (result.status !== 'OPEN') summary.closed++;
    }

    await this.audit.record({
      action: 'recommendation.outcomes_evaluated',
      actorType: actorUserId ? 'USER' : 'SYSTEM',
      actorUserId,
      entityType: 'recommendation_outcomes',
      after: { ...summary },
      ...meta,
    });
    return summary;
  }

  /**
   * KSE-100 return between two PKT dates from `macro_observations` (series KSE100_INDEX): the last observation
   * on or before each date. null when either end has no observation — never estimated.
   */
  private async loadBenchmark(): Promise<(from: string, to: string) => Decimal | null> {
    const obs = await this.prisma.macroObservation.findMany({
      where: { series: 'KSE100_INDEX' },
      orderBy: { date: 'asc' },
      select: { date: true, value: true },
    });
    const series = obs.map((o) => ({ date: day(o.date), value: fromDb(o.value) }));
    const at = (date: string): Decimal | null => {
      let found: Decimal | null = null;
      for (const o of series) {
        if (o.date <= date) found = o.value;
        else break;
      }
      return found;
    };
    return (from, to) => {
      const a = at(from);
      const b = at(to);
      if (!a || !b || a.isZero()) return null;
      return round(b.minus(a).div(a).times(HUNDRED), 4, 'HALF_EVEN');
    };
  }
}
