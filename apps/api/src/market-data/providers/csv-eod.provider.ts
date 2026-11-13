import type {
  BarDto,
  MarketDataCapabilities,
  MarketDataProvider,
  ProviderHealth,
  QuoteDto,
} from '@ktrade/broker-sdk';
import type { DataSource, PriceInterval } from '@ktrade/shared';
import type { Clock } from '../../common/clock.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { pktDateOf, type PsxCalendar } from '../calendar.js';
import { csvIssuesToZodError, type CsvIssue, parseEodCsv } from '../csv-eod.parser.js';
import { formatChangePct, formatPrice, fromDb } from '../decimal-format.js';
import { MarketDataCapabilityError } from '../errors.js';
import { type BarRow, upsertBars } from '../prices.repository.js';

export interface EodImportResult {
  rows: number;
  symbols: string[];
  from: string;
  to: string;
  inserted: number;
  updated: number;
  unchanged: number;
  providerKey: string;
  source: DataSource;
}

/**
 * Serves end-of-day data the owner imported from CSV files they hold a right to use (docs/09 §B1).
 * Every row is labelled USER_REPORTED with providerKey `csv-eod`. Imports are all-or-nothing: one bad
 * row rejects the file with per-line errors. Bars are stored at their session-open instant (bar open).
 */
export class CsvEodProvider implements MarketDataProvider {
  readonly key = 'csv-eod';
  readonly displayName = 'EOD CSV import (user-supplied)';
  readonly source: DataSource = 'USER_REPORTED';

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
    private readonly calendar: () => PsxCalendar,
  ) {}

  capabilities(): MarketDataCapabilities {
    return {
      quotes: true,
      intradayBars: false,
      eodBars: true,
      corporateActions: false,
      streaming: false,
      delayMinutes: 0,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = this.clock.now().toISOString();
    try {
      const agg = await this.prisma.stockPrice.aggregate({
        where: { providerKey: this.key, interval: 'D1' },
        _count: { _all: true },
        _max: { ts: true },
      });
      const latest = agg._max.ts ? pktDateOf(agg._max.ts) : 'none';
      return {
        ok: true,
        checkedAt,
        message: `${agg._count._all} EOD bars imported; latest session ${latest}`,
      };
    } catch {
      return { ok: false, checkedAt, message: 'database unavailable' };
    }
  }

  async getBars(symbol: string, interval: PriceInterval, from: Date, to: Date): Promise<BarDto[]> {
    if (interval !== 'D1')
      throw new MarketDataCapabilityError(this.key, `${interval} bars (end-of-day only)`);
    const rows = await this.prisma.stockPrice.findMany({
      where: {
        stock: { symbol },
        interval: 'D1',
        isAdjusted: false,
        providerKey: this.key,
        ts: { gte: from, lte: to },
      },
      orderBy: { ts: 'asc' },
    });
    return rows.map((r) => ({
      symbol,
      interval: 'D1',
      ts: r.ts.toISOString(),
      open: formatPrice(fromDb(r.open)),
      high: formatPrice(fromDb(r.high)),
      low: formatPrice(fromDb(r.low)),
      close: formatPrice(fromDb(r.close)),
      volume: r.volume.toString(),
      isAdjusted: r.isAdjusted,
    }));
  }

  /** Latest imported session per symbol; symbols without imported data are omitted. */
  async getQuotes(symbols: readonly string[]): Promise<QuoteDto[]> {
    const cal = this.calendar();
    const out: QuoteDto[] = [];
    for (const symbol of symbols) {
      const [latest, previous] = await this.prisma.stockPrice.findMany({
        where: { stock: { symbol }, interval: 'D1', isAdjusted: false, providerKey: this.key },
        orderBy: { ts: 'desc' },
        take: 2,
      });
      if (!latest) continue;
      const last = fromDb(latest.close);
      const prevClose = previous ? fromDb(previous.close) : undefined;
      const change = prevClose ? last.minus(prevClose) : undefined;
      out.push({
        symbol,
        last: formatPrice(last),
        open: formatPrice(fromDb(latest.open)),
        prevClose: prevClose && formatPrice(prevClose),
        high: formatPrice(fromDb(latest.high)),
        low: formatPrice(fromDb(latest.low)),
        volume: latest.volume.toString(),
        change: change && formatPrice(change),
        changePct: change && prevClose ? formatChangePct(change, prevClose) : undefined,
        asOf: cal.sessionClose(pktDateOf(latest.ts)).toISOString(),
        delayMinutes: 0,
        source: this.source,
        providerKey: this.key,
      });
    }
    return out;
  }

  /** Validate and import a CSV. Throws a ZodError (→ 422 problem+json, `rows.<line>.<field>`) on any bad row. */
  async importCsv(text: string): Promise<EodImportResult> {
    const cal = this.calendar();
    const { rows, issues } = parseEodCsv(text, { today: pktDateOf(this.clock.now()) });
    if (issues.length) throw csvIssuesToZodError(issues);

    const symbols = [...new Set(rows.map((r) => r.symbol))].sort();
    const stocks = await this.prisma.stock.findMany({
      where: { symbol: { in: symbols } },
      select: { id: true, symbol: true },
    });
    const idBySymbol = new Map(stocks.map((s) => [s.symbol, s.id]));
    const unknown: CsvIssue[] = rows
      .filter((r) => !idBySymbol.has(r.symbol))
      .map((r) => ({ line: r.line, field: 'symbol', message: `unknown symbol ${r.symbol}` }));
    if (unknown.length) throw csvIssuesToZodError(unknown.slice(0, 200));

    const bySymbol = new Map<string, BarRow[]>();
    for (const r of rows) {
      const list = bySymbol.get(r.symbol) ?? [];
      list.push({
        interval: 'D1',
        ts: cal.sessionOpen(r.date),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        isAdjusted: false,
      });
      bySymbol.set(r.symbol, list);
    }

    const totals = { inserted: 0, updated: 0, unchanged: 0 };
    await this.prisma.$transaction(
      async (tx) => {
        for (const [symbol, bars] of bySymbol) {
          const res = await upsertBars(tx, idBySymbol.get(symbol)!, bars, {
            providerKey: this.key,
            source: this.source,
            // A user's own data may replace SIMULATED placeholders and earlier CSV imports, never other providers.
            overwritableProviderKeys: [this.key, 'simulated'],
          });
          totals.inserted += res.inserted;
          totals.updated += res.updated;
          totals.unchanged += res.unchanged;
        }
      },
      { timeout: 120_000 },
    );

    const dates = rows.map((r) => r.date).sort();
    return {
      rows: rows.length,
      symbols,
      from: dates[0]!,
      to: dates[dates.length - 1]!,
      ...totals,
      providerKey: this.key,
      source: this.source,
    };
  }
}
