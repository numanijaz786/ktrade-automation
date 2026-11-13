import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { BarDto, QuoteDto } from '@ktrade/broker-sdk';
import { d, type Decimal, sum, ZERO } from '@ktrade/finance-core';
import { type DataSource, type PriceInterval, weakestSource } from '@ktrade/shared';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, pktDateOf } from './calendar.js';
import { formatPrice, fromDb } from './decimal-format.js';
import { UnknownSymbolError } from './errors.js';
import { MarketCalendarService } from './market-calendar.service.js';
import { type MoverType, rankMovers } from './movers.js';
import { CsvEodProvider } from './providers/csv-eod.provider.js';
import {
  ACTIVE_PROVIDER_SETTING,
  DEFAULT_PROVIDER_KEY,
  MarketDataProviderRegistry,
} from './provider-registry.js';
import { isStale } from './staleness.js';

export const QUOTE_REFRESH_MS = 10_000;
export const MAX_CANDLES = 2_000;
const DAY_MS = 86_400_000;

export interface QuoteView extends QuoteDto {
  name: string;
  sector: string | null;
  stale: boolean;
}

/**
 * Market data facade (docs/09 Part B).
 *  - Quotes come from the active provider and are persisted to `stock_quotes` (the trading engine prices
 *    previews from there). Policy "real beats simulated" (ADR-024): when a symbol has non-simulated data
 *    (e.g. imported EOD CSV) that quote is used — flagged stale if old — instead of a fresh SIMULATED tick.
 *  - Daily candles come from `stock_prices` (each bar labelled with its own source); intraday from the provider.
 *  - Every value carries `source`, `asOf`, `delayMinutes` and `stale`.
 */
@Injectable()
export class MarketDataService {
  private readonly logger = new Logger('MarketData');
  private lastRefresh = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MarketDataProviderRegistry,
    private readonly csvEod: CsvEodProvider,
    private readonly calendar: MarketCalendarService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ── Providers ──────────────────────────────────────────────────────────────

  async activeProviderKey(): Promise<string> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: ACTIVE_PROVIDER_SETTING } });
    return typeof row?.value === 'string' ? row.value : DEFAULT_PROVIDER_KEY;
  }

  async providers() {
    const active = await this.activeProviderKey();
    return Promise.all(
      this.registry.list().map(async (e) => ({
        key: e.provider.key,
        displayName: e.provider.displayName,
        source: e.provider.source,
        enabled: e.enabled,
        active: e.provider.key === this.registry.resolve(active).key,
        disabledReason: e.disabledReason ?? null,
        capabilities: e.provider.capabilities(),
        health: e.enabled ? await e.provider.healthCheck() : null,
      })),
    );
  }

  async setActiveProvider(userId: string, key: string, meta: RequestMeta) {
    const entry = this.registry.get(key);
    if (!entry)
      throw new BadRequestException({ message: `Unknown provider ${key}`, code: 'UNKNOWN_PROVIDER' });
    if (!entry.enabled) {
      throw new ConflictException({
        message: entry.disabledReason ?? `${key} is not available`,
        code: 'PROVIDER_UNAVAILABLE',
      });
    }
    const before = await this.activeProviderKey();
    await this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({
        where: { key: ACTIVE_PROVIDER_SETTING },
        create: { key: ACTIVE_PROVIDER_SETTING, value: key, updatedById: userId },
        update: { value: key, updatedById: userId },
      });
      await this.audit.record(
        {
          action: 'settings.market_provider_changed',
          actorType: 'USER',
          actorUserId: userId,
          before: { key: before },
          after: { key },
          ...meta,
        },
        tx,
      );
    });
    await this.refreshQuotes(true);
    return this.providers();
  }

  // ── Quotes ─────────────────────────────────────────────────────────────────

  /** Pull quotes for every active stock and persist them to `stock_quotes`. Throttled; concurrent callers share one run. */
  async refreshQuotes(force = false): Promise<void> {
    if (!force && Date.now() - this.lastRefresh < QUOTE_REFRESH_MS) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        await this.calendar.refresh();
        const stocks = await this.prisma.stock.findMany({
          where: { isActive: true },
          select: { id: true, symbol: true },
        });
        if (stocks.length === 0) return;
        const quotes = await this.resolveQuotes(stocks.map((s) => s.symbol));
        const idBySymbol = new Map(stocks.map((s) => [s.symbol, s.id]));
        await this.prisma.$transaction(
          quotes.map((q) => {
            const data = {
              last: q.last,
              open: q.open ?? null,
              prevClose: q.prevClose ?? null,
              high: q.high ?? null,
              low: q.low ?? null,
              volume: q.volume !== undefined ? BigInt(q.volume) : null,
              change: q.change ?? null,
              changePct: q.changePct ?? null,
              asOf: new Date(q.asOf),
              delayMinutes: q.delayMinutes,
              providerKey: q.providerKey,
              source: q.source,
            };
            const stockId = idBySymbol.get(q.symbol)!;
            return this.prisma.stockQuote.upsert({
              where: { stockId },
              create: { stockId, ...data },
              update: data,
            });
          }),
        );
        this.lastRefresh = Date.now();
      } catch (err) {
        this.logger.warn(`Quote refresh failed: ${(err as Error).message}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Active-provider quotes, replaced by non-simulated (imported/licensed) quotes where those exist. */
  private async resolveQuotes(symbols: string[]): Promise<QuoteDto[]> {
    const active = this.registry.resolve(await this.activeProviderKey());
    const primary = await active.getQuotes(symbols);
    if (active.source !== 'SIMULATED') return primary;
    const real = new Map((await this.csvEod.getQuotes(symbols)).map((q) => [q.symbol, q]));
    return primary.map((q) => real.get(q.symbol) ?? q);
  }

  async quotes(symbols?: string[]): Promise<QuoteView[]> {
    await this.refreshQuotes();
    const rows = await this.prisma.stockQuote.findMany({
      where: symbols?.length ? { stock: { symbol: { in: symbols } } } : { stock: { isActive: true } },
      include: { stock: { select: { symbol: true, name: true, sector: true } } },
      orderBy: { stock: { symbol: 'asc' } },
    });
    if (symbols?.length) {
      const known = new Set(rows.map((r) => r.stock.symbol));
      const missing = symbols.find((s) => !known.has(s));
      if (missing && !(await this.prisma.stock.findUnique({ where: { symbol: missing } })))
        throw new UnknownSymbolError(missing);
    }
    const now = this.clock.now();
    const cal = this.calendar.current();
    return rows.map((r) => {
      const q: QuoteDto = {
        symbol: r.stock.symbol,
        last: formatPrice(fromDb(r.last)),
        open: r.open ? formatPrice(fromDb(r.open)) : undefined,
        prevClose: r.prevClose ? formatPrice(fromDb(r.prevClose)) : undefined,
        high: r.high ? formatPrice(fromDb(r.high)) : undefined,
        low: r.low ? formatPrice(fromDb(r.low)) : undefined,
        volume: r.volume?.toString(),
        change: r.change ? formatPrice(fromDb(r.change)) : undefined,
        changePct: r.changePct ? fromDb(r.changePct).toFixed(2) : undefined,
        asOf: r.asOf.toISOString(),
        delayMinutes: r.delayMinutes,
        source: r.source,
        providerKey: r.providerKey,
      };
      return { ...q, name: r.stock.name, sector: r.stock.sector, stale: isStale(q, now, cal) };
    });
  }

  async movers(type: MoverType, limit: number) {
    return rankMovers(await this.quotes(), type, limit);
  }

  // ── Stocks ─────────────────────────────────────────────────────────────────

  async stocks(q: { search?: string; sector?: string; limit: number; offset: number }) {
    const where = {
      isActive: true,
      ...(q.sector ? { sector: q.sector } : {}),
      ...(q.search
        ? {
            OR: [
              { symbol: { contains: q.search.toUpperCase() } },
              { name: { contains: q.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.stock.count({ where }),
      this.prisma.stock.findMany({ where, orderBy: { symbol: 'asc' }, take: q.limit, skip: q.offset }),
    ]);
    const quotes = new Map((await this.quotes()).map((x) => [x.symbol, x]));
    return {
      total,
      data: rows.map((s) => ({
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
        isShariah: s.isShariah,
        quote: quotes.get(s.symbol) ?? null,
      })),
    };
  }

  async stock(symbol: string) {
    const s = await this.prisma.stock.findUnique({ where: { symbol } });
    if (!s) throw new UnknownSymbolError(symbol);
    const [quote] = await this.quotes([symbol]);
    const since = new Date(this.clock.now().getTime() - 365 * DAY_MS);
    const bars = await this.prisma.stockPrice.findMany({
      where: { stockId: s.id, interval: 'D1', isAdjusted: false, ts: { gte: since } },
      orderBy: { ts: 'asc' },
      select: { high: true, low: true, close: true, volume: true, source: true },
    });
    const highs = bars.map((b) => fromDb(b.high));
    const lows = bars.map((b) => fromDb(b.low));
    const last20 = bars.slice(-20);
    const avgVol = last20.length
      ? sum(last20.map((b) => d(b.volume.toString())))
          .div(last20.length)
          .toFixed(0)
      : null;
    const sources = [...new Set(bars.map((b) => b.source))] as DataSource[];
    return {
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      isShariah: s.isShariah,
      faceValue: s.faceValue?.toString() ?? null,
      quote: quote ?? null,
      stats: {
        week52High: highs.length ? formatPrice(highs.reduce((a, b) => (b.gt(a) ? b : a))) : null,
        week52Low: lows.length ? formatPrice(lows.reduce((a, b) => (b.lt(a) ? b : a))) : null,
        avgVolume20d: avgVol,
        sessions: bars.length,
        historySources: sources,
        historySource: sources.length ? weakestSource(sources) : null,
      },
    };
  }

  async candles(symbol: string, interval: PriceInterval, from?: string, to?: string) {
    const s = await this.prisma.stock.findUnique({ where: { symbol } });
    if (!s) throw new UnknownSymbolError(symbol);
    const now = this.clock.now();
    const toDate = to ? new Date(`${to}T23:59:59Z`) : now;
    const defaultSpanDays = interval === 'D1' ? 183 : 5;
    const fromDate = from
      ? new Date(`${from}T00:00:00Z`)
      : new Date(`${addDays(pktDateOf(toDate), -defaultSpanDays)}T00:00:00Z`);
    if (fromDate >= toDate)
      throw new BadRequestException({ message: '`from` must be before `to`', code: 'INVALID_RANGE' });

    let bars: (BarDto & { source: DataSource })[];
    if (interval === 'D1') {
      const rows = await this.prisma.stockPrice.findMany({
        where: { stockId: s.id, interval: 'D1', isAdjusted: false, ts: { gte: fromDate, lte: toDate } },
        orderBy: { ts: 'asc' },
        take: MAX_CANDLES + 1,
      });
      bars = rows.map((r) => ({
        symbol,
        interval: 'D1',
        ts: r.ts.toISOString(),
        open: formatPrice(fromDb(r.open)),
        high: formatPrice(fromDb(r.high)),
        low: formatPrice(fromDb(r.low)),
        close: formatPrice(fromDb(r.close)),
        volume: r.volume.toString(),
        isAdjusted: r.isAdjusted,
        source: r.source,
      }));
    } else {
      const provider = this.registry.resolve(await this.activeProviderKey());
      if (!provider.capabilities().intradayBars) {
        throw new ConflictException({
          message: `${provider.displayName} has no intraday data`,
          code: 'CAPABILITY_UNAVAILABLE',
        });
      }
      await this.calendar.refresh();
      bars = (await provider.getBars(symbol, interval, fromDate, toDate)).map((b) => ({
        ...b,
        source: provider.source,
      }));
    }
    if (bars.length > MAX_CANDLES) {
      throw new BadRequestException({
        message: `Range too large: narrow it to at most ${MAX_CANDLES} bars`,
        code: 'RANGE_TOO_LARGE',
      });
    }
    const sources = [...new Set(bars.map((b) => b.source))];
    return {
      symbol,
      interval,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      source: sources.length ? weakestSource(sources) : null,
      bars,
    };
  }

  // ── Overview ───────────────────────────────────────────────────────────────

  async sectors() {
    const quotes = await this.quotes();
    const bySector = new Map<string, QuoteView[]>();
    for (const q of quotes) {
      const key = q.sector ?? 'Unclassified';
      bySector.set(key, [...(bySector.get(key) ?? []), q]);
    }
    return [...bySector.entries()]
      .map(([sector, qs]) => {
        const pcts = qs.filter((q) => q.changePct !== undefined).map((q) => d(q.changePct!));
        const avg: Decimal | null = pcts.length ? sum(pcts).div(pcts.length) : null;
        return {
          sector,
          stocks: qs.length,
          advancers: qs.filter((q) => q.changePct !== undefined && d(q.changePct).gt(0)).length,
          decliners: qs.filter((q) => q.changePct !== undefined && d(q.changePct).lt(0)).length,
          avgChangePct: avg ? avg.toFixed(2) : null,
          volume: sum(qs.map((q) => (q.volume ? d(q.volume) : ZERO))).toFixed(0),
          source: weakestSource(qs.map((q) => q.source)),
        };
      })
      .sort((a, b) => (a.sector < b.sector ? -1 : 1));
  }

  async overview() {
    const quotes = await this.quotes();
    const now = this.clock.now();
    const cal = this.calendar.current();
    const pct = (q: QuoteView) => (q.changePct !== undefined ? d(q.changePct) : null);
    const asOf = quotes.reduce<string | null>((m, q) => (m === null || q.asOf > m ? q.asOf : m), null);
    return {
      session: {
        open: cal.isOpen(now),
        tradingDay: cal.isTradingDay(pktDateOf(now)),
        lastCompletedSession: cal.lastCompletedSession(now),
        hours: 'Mon–Fri 09:30–15:30 PKT',
      },
      breadth: {
        advancers: quotes.filter((q) => pct(q)?.gt(0)).length,
        decliners: quotes.filter((q) => pct(q)?.lt(0)).length,
        unchanged: quotes.filter((q) => pct(q)?.isZero()).length,
        total: quotes.length,
      },
      totalVolume: sum(quotes.map((q) => (q.volume ? d(q.volume) : ZERO))).toFixed(0),
      gainers: rankMovers(quotes, 'gainers', 5),
      losers: rankMovers(quotes, 'losers', 5),
      mostActive: rankMovers(quotes, 'active', 5),
      sectors: await this.sectors(),
      dataSource: quotes.length ? weakestSource(quotes.map((q) => q.source)) : null,
      staleQuotes: quotes.filter((q) => q.stale).length,
      asOf,
      providerKey: await this.activeProviderKey(),
    };
  }

  // ── Imports ────────────────────────────────────────────────────────────────

  async importPrices(userId: string, csv: string, meta: RequestMeta) {
    const result = await this.csvEod.importCsv(csv);
    await this.audit.record({
      action: 'market.prices_imported',
      actorType: 'USER',
      actorUserId: userId,
      after: { ...result },
      ...meta,
    });
    await this.refreshQuotes(true);
    return result;
  }
}
