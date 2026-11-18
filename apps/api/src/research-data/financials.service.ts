import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { d } from '@ktrade/finance-core';
import type { FinancialPeriodType } from '@ktrade/shared';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { CLOCK, type Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { csvIssuesToZodError, type CsvIssue } from '../market-data/csv-eod.parser.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fieldError, readCsv, zodIssuesFor } from './csv.js';
import {
  FINANCIAL_CSV_OPTIONAL,
  FINANCIAL_CSV_REQUIRED,
  FINANCIAL_ITEM_KEYS,
  type FinancialInput,
  financialInputSchema,
  MAX_FINANCIAL_CSV_ROWS,
  parseWhen,
} from './research-data.schemas.js';
import { financialView } from './research-data.views.js';

const toDate = (s: string): Date => new Date(`${s}T00:00:00Z`);
const withStock = { stock: { select: { symbol: true } } } as const;

export interface FinancialsImportResult {
  rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  symbols: string[];
  source: 'USER_REPORTED';
}

type Existing = Prisma.CompanyFinancialGetPayload<object>;

/** True when the stored row already holds exactly these values (decimal-exact comparison). */
function sameValues(existing: Existing, r: FinancialInput): boolean {
  if (
    existing.publishedAt.getTime() !== parseWhen(r.publishedAt).getTime() ||
    existing.currency !== r.currency ||
    existing.sourceRef !== r.sourceRef ||
    (existing.sourceUrl ?? undefined) !== r.sourceUrl
  )
    return false;
  return FINANCIAL_ITEM_KEYS.every((k) => {
    const have = existing[k];
    const want = r[k];
    if (have === null || want === undefined) return have === null && want === undefined;
    return d(have.toFixed()).eq(d(want));
  });
}

/** Owner-entered fundamentals (USER_REPORTED). Re-entering the same period corrects it in place and is audited. */
@Injectable()
export class FinancialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(userId: string, input: FinancialInput, meta: RequestMeta) {
    const issues = this.rowIssues(input, 0);
    if (issues.length) throw fieldError(issues[0]!.field ?? 'publishedAt', issues[0]!.message);
    const known = await this.prisma.stock.findUnique({
      where: { symbol: input.symbol },
      select: { id: true },
    });
    if (!known)
      throw new NotFoundException({ message: `Unknown symbol: ${input.symbol}`, code: 'UNKNOWN_SYMBOL' });
    const result = await this.apply(userId, [{ line: 1, row: input }], meta, 'research.financials_recorded');
    const row = await this.prisma.companyFinancial.findFirstOrThrow({
      where: {
        stock: { symbol: input.symbol },
        periodType: input.periodType,
        periodEnd: toDate(input.periodEnd),
        source: 'USER_REPORTED',
      },
      include: withStock,
    });
    return { ...financialView(row), created: result.inserted === 1 };
  }

  async importCsv(userId: string, csv: string, meta: RequestMeta): Promise<FinancialsImportResult> {
    const { records, issues } = readCsv(csv, {
      required: FINANCIAL_CSV_REQUIRED,
      optional: FINANCIAL_CSV_OPTIONAL,
      maxRows: MAX_FINANCIAL_CSV_ROWS,
    });
    const rows: { line: number; row: FinancialInput }[] = [];
    const seen = new Map<string, number>();
    for (const rec of records) {
      const parsed = financialInputSchema.safeParse({
        ...rec.values,
        ...(rec.values.periodType ? { periodType: rec.values.periodType.toUpperCase() } : {}),
      });
      if (!parsed.success) {
        issues.push(...zodIssuesFor(rec.line, parsed.error));
        continue;
      }
      const rowIssues = this.rowIssues(parsed.data, rec.line);
      if (rowIssues.length) {
        issues.push(...rowIssues);
        continue;
      }
      const key = `${parsed.data.symbol}|${parsed.data.periodType}|${parsed.data.periodEnd}`;
      const first = seen.get(key);
      if (first !== undefined) {
        issues.push({ line: rec.line, message: `duplicate ${key} (first seen on line ${first})` });
        continue;
      }
      seen.set(key, rec.line);
      rows.push({ line: rec.line, row: parsed.data });
    }
    if (issues.length) throw csvIssuesToZodError(issues);
    return this.apply(userId, rows, meta, 'research.financials_imported');
  }

  async list(symbol: string, periodType: FinancialPeriodType | undefined, limit: number) {
    const stock = await this.prisma.stock.findUnique({ where: { symbol }, select: { id: true } });
    if (!stock) throw new NotFoundException({ message: `Unknown symbol: ${symbol}`, code: 'UNKNOWN_SYMBOL' });
    const rows = await this.prisma.companyFinancial.findMany({
      where: { stockId: stock.id, ...(periodType ? { periodType } : {}) },
      include: withStock,
      orderBy: [{ periodEnd: 'desc' }, { periodType: 'asc' }],
      take: limit,
    });
    return {
      symbol,
      data: rows.map(financialView),
      note:
        rows.length === 0
          ? 'No fundamentals on file for this symbol. Nothing is estimated; enter figures from the company report.'
          : 'Owner-entered figures (USER_REPORTED), in full currency units.',
    };
  }

  /** Row-level checks that need the clock (a filing cannot be published in the future). */
  private rowIssues(r: FinancialInput, line: number): CsvIssue[] {
    const published = parseWhen(r.publishedAt);
    if (published.getTime() > this.clock.now().getTime())
      return [{ line, field: 'publishedAt', message: 'must not be in the future' }];
    return [];
  }

  private async apply(
    userId: string,
    rows: { line: number; row: FinancialInput }[],
    meta: RequestMeta,
    action: string,
  ): Promise<FinancialsImportResult> {
    const symbols = [...new Set(rows.map((r) => r.row.symbol))];
    const stocks = await this.prisma.stock.findMany({ where: { symbol: { in: symbols } } });
    const bySymbol = new Map(stocks.map((s) => [s.symbol, s.id]));
    const unknown: CsvIssue[] = rows
      .filter((r) => !bySymbol.has(r.row.symbol))
      .map((r) => ({ line: r.line, field: 'symbol', message: `unknown symbol ${r.row.symbol}` }));
    if (unknown.length) throw csvIssuesToZodError(unknown);

    const result: FinancialsImportResult = {
      rows: rows.length,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      symbols,
      source: 'USER_REPORTED',
    };
    await this.prisma.$transaction(async (tx) => {
      for (const { row } of rows) {
        const stockId = bySymbol.get(row.symbol)!;
        const where = {
          stockId_periodType_periodEnd_source: {
            stockId,
            periodType: row.periodType,
            periodEnd: toDate(row.periodEnd),
            source: 'USER_REPORTED' as const,
          },
        };
        const items = Object.fromEntries(FINANCIAL_ITEM_KEYS.map((k) => [k, row[k] ?? null]));
        const data = {
          publishedAt: parseWhen(row.publishedAt),
          currency: row.currency,
          sourceRef: row.sourceRef,
          sourceUrl: row.sourceUrl ?? null,
          enteredById: userId,
          ...items,
        };
        const existing = await tx.companyFinancial.findUnique({ where });
        if (!existing) {
          await tx.companyFinancial.create({
            data: {
              stockId,
              periodType: row.periodType,
              periodEnd: toDate(row.periodEnd),
              source: 'USER_REPORTED',
              ...data,
            },
          });
          result.inserted++;
        } else if (sameValues(existing, row)) result.unchanged++;
        else {
          await tx.companyFinancial.update({ where, data });
          result.updated++;
        }
      }
      await this.audit.record(
        {
          action,
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'company_financials',
          after: { ...result },
          ...meta,
        },
        tx,
      );
    });
    return result;
  }
}
