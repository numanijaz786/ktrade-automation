import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AnnouncementCategory } from '@ktrade/shared';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { CLOCK, type Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { csvIssuesToZodError, type CsvIssue } from '../market-data/csv-eod.parser.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fieldError, readCsv, zodIssuesFor } from './csv.js';
import { announcementDedupeHash } from './dedupe.js';
import {
  ANNOUNCEMENT_CSV_OPTIONAL,
  ANNOUNCEMENT_CSV_REQUIRED,
  type AnnouncementInput,
  announcementFromCsv,
  announcementInputSchema,
  MAX_ANNOUNCEMENT_CSV_ROWS,
  parseWhen,
} from './research-data.schemas.js';

export const COVERAGE_NOTE = 'sources: owner-entered only';
type Row = Prisma.AnnouncementGetPayload<{ include: { stock: { select: { symbol: true } } } }>;
const withStock = { stock: { select: { symbol: true } } } as const;

export interface AnnouncementsImportResult {
  rows: number;
  inserted: number;
  /** Rows whose normalised title + url + publishedAt already exist (or repeat within the file). */
  skipped: number;
  source: 'USER_REPORTED';
}

/** Owner-entered news and filings. Every item is dated, sourced and deduplicated; nothing is fetched or invented. */
@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(userId: string, input: AnnouncementInput, meta: RequestMeta) {
    const now = this.clock.now();
    const publishedAt = parseWhen(input.publishedAt);
    if (publishedAt.getTime() > now.getTime()) throw fieldError('publishedAt', 'must not be in the future');
    const resolved = await this.resolveSymbols(input);
    if (resolved.unknown.length)
      throw new NotFoundException({
        message: `Unknown symbol: ${resolved.unknown[0]}`,
        code: 'UNKNOWN_SYMBOL',
      });
    const data = this.toData(userId, input, publishedAt, now, resolved);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.announcement.create({ data, include: withStock });
        await this.audit.record(
          {
            action: 'research.announcement_recorded',
            actorType: 'USER',
            actorUserId: userId,
            entityType: 'announcements',
            entityId: created.id,
            after: { title: created.title, category: created.category, publishedAt: created.publishedAt },
            ...meta,
          },
          tx,
        );
        return created;
      });
      return this.view(row, await this.heldSymbols(userId));
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002')
        throw new ConflictException({
          message: 'This announcement (same title, url and publish time) is already recorded',
          code: 'DUPLICATE_ANNOUNCEMENT',
        });
      throw e;
    }
  }

  async importCsv(userId: string, csv: string, meta: RequestMeta): Promise<AnnouncementsImportResult> {
    const { records, issues } = readCsv(csv, {
      required: ANNOUNCEMENT_CSV_REQUIRED,
      optional: ANNOUNCEMENT_CSV_OPTIONAL,
      maxRows: MAX_ANNOUNCEMENT_CSV_ROWS,
    });
    const now = this.clock.now();
    const parsedRows: { line: number; input: AnnouncementInput; publishedAt: Date }[] = [];
    for (const rec of records) {
      const parsed = announcementInputSchema.safeParse(announcementFromCsv(rec.values));
      if (!parsed.success) {
        issues.push(...zodIssuesFor(rec.line, parsed.error));
        continue;
      }
      const publishedAt = parseWhen(parsed.data.publishedAt);
      if (publishedAt.getTime() > now.getTime()) {
        issues.push({ line: rec.line, field: 'publishedAt', message: 'must not be in the future' });
        continue;
      }
      parsedRows.push({ line: rec.line, input: parsed.data, publishedAt });
    }
    // Resolve every referenced symbol once.
    const wanted = [
      ...new Set(
        parsedRows.flatMap((r) => [r.input.symbol, ...r.input.symbols]).filter((s): s is string => !!s),
      ),
    ];
    const stocks = await this.prisma.stock.findMany({
      where: { symbol: { in: wanted } },
      select: { id: true, symbol: true },
    });
    const idBySymbol = new Map(stocks.map((s) => [s.symbol, s.id]));
    const data: Prisma.AnnouncementCreateManyInput[] = [];
    const seen = new Set<string>();
    for (const r of parsedRows) {
      const unknown = [r.input.symbol, ...r.input.symbols].filter(
        (s): s is string => !!s && !idBySymbol.has(s),
      );
      if (unknown.length) {
        issues.push({ line: r.line, field: 'symbol', message: `unknown symbol ${unknown[0]}` });
        continue;
      }
      const row = this.toData(userId, r.input, r.publishedAt, now, {
        stockId: r.input.symbol ? idBySymbol.get(r.input.symbol) : undefined,
        symbols: this.allSymbols(r.input),
      });
      if (seen.has(row.dedupeHash)) {
        continue;
      }
      seen.add(row.dedupeHash);
      data.push(row);
    }
    if (issues.length) throw csvIssuesToZodError(sortIssues(issues));

    const result = await this.prisma.$transaction(async (tx) => {
      const created = data.length
        ? await tx.announcement.createMany({ data, skipDuplicates: true })
        : { count: 0 };
      const out: AnnouncementsImportResult = {
        rows: records.length,
        inserted: created.count,
        skipped: records.length - created.count,
        source: 'USER_REPORTED',
      };
      await this.audit.record(
        {
          action: 'research.announcements_imported',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'announcements',
          after: { ...out },
          ...meta,
        },
        tx,
      );
      return out;
    });
    return result;
  }

  async list(
    userId: string,
    q: { symbol?: string; since?: string; category?: AnnouncementCategory; limit: number },
  ) {
    const where: Prisma.AnnouncementWhereInput = {
      ...(q.since ? { publishedAt: { gte: parseWhen(q.since) } } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.symbol ? { OR: [{ stock: { symbol: q.symbol } }, { symbols: { has: q.symbol } }] } : {}),
    };
    const [rows, held] = await Promise.all([
      this.prisma.announcement.findMany({
        where,
        include: withStock,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        take: q.limit,
      }),
      this.heldSymbols(userId),
    ]);
    return { data: rows.map((r) => this.view(r, held)), coverage: COVERAGE_NOTE };
  }

  /** Only items inside the freshness window; says when the owner last added anything and what the coverage is. */
  async newsFeed(userId: string, q: { windowHours: number; symbol?: string; limit: number }) {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - q.windowHours * 3_600_000);
    const [rows, held, latest] = await Promise.all([
      this.prisma.announcement.findMany({
        where: {
          publishedAt: { gte: cutoff, lte: now },
          ...(q.symbol ? { OR: [{ stock: { symbol: q.symbol } }, { symbols: { has: q.symbol } }] } : {}),
        },
        include: withStock,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        take: q.limit,
      }),
      this.heldSymbols(userId),
      this.prisma.announcement.aggregate({ _max: { retrievedAt: true } }),
    ]);
    const lastUpdated = latest._max.retrievedAt;
    return {
      generatedAt: now.toISOString(),
      windowHours: q.windowHours,
      lastUpdated: lastUpdated ? lastUpdated.toISOString() : null,
      coverage: COVERAGE_NOTE,
      count: rows.length,
      items: rows.map((r) => this.view(r, held)),
      note:
        rows.length === 0
          ? `No announcements published in the last ${q.windowHours} hours. Nothing is fetched automatically; items appear only when the owner enters them.`
          : undefined,
    };
  }

  // ───────────── internals ─────────────

  private allSymbols(input: AnnouncementInput): string[] {
    return [...new Set([...(input.symbol ? [input.symbol] : []), ...input.symbols])];
  }

  private async resolveSymbols(input: AnnouncementInput) {
    const symbols = this.allSymbols(input);
    const stocks = symbols.length
      ? await this.prisma.stock.findMany({
          where: { symbol: { in: symbols } },
          select: { id: true, symbol: true },
        })
      : [];
    const bySymbol = new Map(stocks.map((s) => [s.symbol, s.id]));
    return {
      stockId: input.symbol ? bySymbol.get(input.symbol) : undefined,
      symbols,
      unknown: symbols.filter((s) => !bySymbol.has(s)),
    };
  }

  private toData(
    userId: string,
    input: AnnouncementInput,
    publishedAt: Date,
    now: Date,
    r: { stockId?: string | undefined; symbols: string[] },
  ) {
    return {
      stockId: r.stockId ?? null,
      symbols: r.symbols,
      title: input.title,
      summary: input.summary ?? null,
      url: input.url ?? null,
      category: input.category,
      source: 'USER_REPORTED' as const,
      sourceName: input.sourceName,
      publishedAt,
      retrievedAt: now,
      dedupeHash: announcementDedupeHash({ title: input.title, url: input.url, publishedAt }),
      sentiment: input.sentiment ?? null,
      sentimentSource: input.sentiment ? ('MANUAL' as const) : ('NONE' as const),
      relevance: input.relevance ?? null,
      enteredById: userId,
    };
  }

  /** Symbols with a positive quantity in any non-archived portfolio of this user. */
  private async heldSymbols(userId: string): Promise<Set<string>> {
    const holdings = await this.prisma.holding.findMany({
      where: { quantity: { gt: 0 }, portfolio: { userId, archivedAt: null } },
      select: { stock: { select: { symbol: true } } },
    });
    return new Set(holdings.map((h) => h.stock.symbol));
  }

  private view(r: Row, held: ReadonlySet<string>) {
    const symbols = [...new Set([...(r.stock ? [r.stock.symbol] : []), ...r.symbols])];
    const affected = symbols.filter((s) => held.has(s));
    return {
      id: r.id,
      symbol: r.stock?.symbol ?? null,
      symbols,
      title: r.title,
      summary: r.summary,
      url: r.url,
      category: r.category,
      source: r.source,
      sourceName: r.sourceName,
      publishedAt: r.publishedAt.toISOString(),
      retrievedAt: r.retrievedAt.toISOString(),
      sentiment: r.sentiment,
      sentimentSource: r.sentimentSource,
      relevance: r.relevance,
      affectsHoldings: affected.length > 0,
      affectedSymbols: affected,
    };
  }
}

const sortIssues = (issues: CsvIssue[]): CsvIssue[] => [...issues].sort((a, b) => a.line - b.line);
