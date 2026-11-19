import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { type ChangeEvent, diffRecommendation, recInfo } from './advisor-changes.js';
import { AdvisorDataService } from './advisor-data.service.js';

const RECENT_MS = 3 * 86_400_000;
const LOOKBACK_MS = 120 * 86_400_000;
const NEWS_WINDOW_MS = 72 * 3_600_000;
const BUY_CLASS = new Set(['STRONG_BUY', 'BUY']);

export interface AlertSummary {
  considered: number;
  created: number;
}

/**
 * Turns advisor state into IN_APP notifications. Every notification carries a dedupe key derived from the stored
 * recommendation (or announcement) it is about, so a re-run, a second tick or a restart never repeats one.
 * Reads stored recommendations and completed bars only; it never places or approves anything.
 */
@Injectable()
export class AdvisorAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly data: AdvisorDataService,
    private readonly notifications: NotificationsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async generate(userId: string, portfolioId: string): Promise<AlertSummary> {
    const ctx = await this.data.load(userId, portfolioId);
    const now = ctx.now;
    const recent = new Date(now.getTime() - RECENT_MS);
    const held = new Set(ctx.holdings.map((h) => h.symbol));
    const bundleBy = new Map(ctx.bundles.map((b) => [b.stock.id, b]));
    const rows = await this.prisma.recommendation.findMany({
      where: { userId, asOfBar: { gte: new Date(now.getTime() - LOOKBACK_MS) } },
      orderBy: [{ asOfBar: 'desc' }, { generatedAt: 'desc' }],
      include: { stock: { select: { symbol: true } } },
    });
    const groups = new Map<string, typeof rows>();
    for (const r of rows)
      groups.set(`${r.stockId}|${r.horizon}`, [...(groups.get(`${r.stockId}|${r.horizon}`) ?? []), r]);

    let considered = 0;
    let created = 0;
    const send = async (
      type: 'STRATEGY_SIGNAL' | 'POSITION_STOP_LOSS',
      dedupeKey: string,
      title: string,
      body: string,
      data: Record<string, unknown>,
    ) => {
      considered++;
      const res = await this.notifications.notify({
        userId,
        type,
        title,
        body,
        dedupeKey,
        data: { source: 'advisor', ...data },
      });
      created += res.created;
    };

    for (const list of groups.values()) {
      const latest = list[0]!;
      const info = recInfo(latest);
      const symbol = info.symbol;
      const bundle = bundleBy.get(latest.stockId);
      // 1) action changes between the latest two stored bars (data-quality flips are not action changes).
      const prev = list.find((r) => r.asOfBar < latest.asOfBar);
      if (prev && latest.generatedAt >= recent) {
        const p = recInfo(prev);
        const relevant =
          held.has(symbol) || BUY_CLASS.has(p.engineAction ?? '') || BUY_CLASS.has(info.engineAction ?? '');
        if (
          relevant &&
          p.engineStatus === 'ACTIONABLE' &&
          info.engineStatus === 'ACTIONABLE' &&
          p.engineAction !== info.engineAction
        ) {
          await send(
            'STRATEGY_SIGNAL',
            `advisor:action:${symbol}:${info.horizon}:${info.asOfBar}:${p.engineAction}->${info.engineAction}`,
            `${symbol}: recommendation changed to ${info.engineAction}`,
            `The ${info.horizon} recommendation for ${symbol} changed from ${p.engineAction} to ${info.engineAction} on the bar of ${info.asOfBar}.`,
            {
              event: 'ACTION_CHANGED',
              symbol,
              horizon: info.horizon,
              from: p.engineAction,
              to: info.engineAction,
              recommendationId: latest.id,
            },
          );
        }
      }
      // 2) price events against every stored trade idea (stop-wins ordering like the outcome evaluator).
      if (!bundle) continue;
      for (const r of list) {
        if (r.status !== 'ACTIONABLE' || r.stop === null) continue;
        const ri = recInfo(r);
        const events: ChangeEvent[] = diffRecommendation(
          ri,
          { engineStatus: info.engineStatus, engineAction: info.engineAction },
          bundle.bars,
        ).filter(
          (e) =>
            (e.kind === 'ENTERED_ENTRY_RANGE' || e.kind === 'TARGET_HIT' || e.kind === 'STOP_HIT') &&
            (e.date ?? '') >= recent.toISOString().slice(0, 10),
        );
        const stop = events.find((e) => e.kind === 'STOP_HIT');
        for (const e of events) {
          if (e.kind === 'TARGET_HIT' && stop && (stop.date ?? '') <= (e.date ?? '')) continue;
          if (e.kind === 'ENTERED_ENTRY_RANGE' && stop) continue;
          const base = { symbol, horizon: info.horizon, recommendationId: r.id, date: e.date };
          if (e.kind === 'STOP_HIT')
            await send(
              'POSITION_STOP_LOSS',
              `advisor:stop:${r.id}`,
              `${symbol}: stop-loss level reached`,
              `${symbol} ${e.detail} (recommendation of ${ri.asOfBar}). The idea is invalidated.`,
              { event: e.kind, ...base },
            );
          else if (e.kind === 'TARGET_HIT')
            await send(
              'STRATEGY_SIGNAL',
              `advisor:target:${r.id}:${e.targetN}`,
              `${symbol}: Target ${e.targetN} reached`,
              `${symbol} ${e.detail} (recommendation of ${ri.asOfBar}).`,
              { event: e.kind, targetN: e.targetN, ...base },
            );
          else
            await send(
              'STRATEGY_SIGNAL',
              `advisor:entry:${r.id}`,
              `${symbol}: price entered the entry range`,
              `${symbol} ${e.detail} (recommendation of ${ri.asOfBar}).`,
              { event: e.kind, ...base },
            );
        }
      }
    }

    // 3) fresh announcements affecting holdings
    if (held.size > 0) {
      const news = await this.prisma.announcement.findMany({
        where: { publishedAt: { gte: new Date(now.getTime() - NEWS_WINDOW_MS), lte: now } },
        include: { stock: { select: { symbol: true } } },
      });
      for (const n of news) {
        const symbols = [...new Set([...(n.stock ? [n.stock.symbol] : []), ...n.symbols])].filter((s) =>
          held.has(s),
        );
        if (symbols.length === 0) continue;
        await send(
          'STRATEGY_SIGNAL',
          `advisor:news:${n.id}`,
          `${symbols.join(', ')}: new announcement`,
          `${n.title} (${n.sourceName}, ${n.publishedAt.toISOString().slice(0, 10)}).`,
          {
            event: 'ANNOUNCEMENT',
            symbols,
            announcementId: n.id,
            url: n.url,
          },
        );
      }
    }
    return { considered, created };
  }
}
