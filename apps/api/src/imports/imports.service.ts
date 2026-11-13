import { createHash } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { d } from '@ktrade/finance-core';
import type { DataSource, ImportRowStatus, OrderSide } from '@ktrade/shared';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { Prisma } from '../generated/prisma/client.js';
import { FeeService } from '../ledger/fee.service.js';
import { feeLinesFromBreakdown, type FeeLineInput, LedgerService } from '../ledger/ledger.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RowAction, UploadImportInput } from './imports.schemas.js';
import { ParserRegistry } from './parsers/parser-registry.js';
import type { ParsedTradeRow, StatementParser } from './parsers/parser.types.js';

type Trade = NonNullable<ParsedTradeRow['trade']>;

/** Stored in imported_rows.parsed */
interface ParsedPayload {
  trade: Trade | null;
  /** FILE = charges stated in the file (provenance of the parser); ESTIMATED_ON_COMMIT = fee engine fills them in. */
  feeSource: 'FILE' | 'ESTIMATED_ON_COMMIT';
  duplicateOf?: { kind: 'IMPORT_ROW' | 'TRANSACTION'; id: string; detail: string };
}
interface RowIssue {
  level: 'error' | 'warning';
  message: string;
}

const COMMIT_TIMEOUT_MS = 120_000;
const norm = (v: string | { toString(): string }) => d(v.toString()).toFixed();
const dateOf = (dt: Date) => dt.toISOString().slice(0, 10);

/** Trade identity used for duplicate detection across files and against the ledger. */
export function tradeFingerprint(
  portfolioId: string,
  t: Pick<Trade, 'tradeDate' | 'symbol' | 'side' | 'quantity' | 'price'>,
): string {
  return createHash('sha256')
    .update(
      [portfolioId, t.tradeDate, t.symbol.toUpperCase(), t.side, norm(t.quantity), norm(t.price)].join('|'),
    )
    .digest('hex');
}

/**
 * Statement import pipeline (docs/09 A2):
 *   upload → sha256 file dedupe → parse → validate (symbols, duplicates) → imported_rows (AWAITING_REVIEW)
 *   → review (skip / include duplicates) → commit: ONE DB transaction posting every row through LedgerService,
 *   then one ledger replay per affected symbol. Any failure (oversell, constraint) rolls back the whole import.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parsers: ParserRegistry,
    private readonly ledger: LedgerService,
    private readonly fees: FeeService,
    private readonly audit: AuditService,
  ) {}

  // ── Upload & stage ─────────────────────────────────────────────────────────

  async upload(userId: string, input: UploadImportInput, meta: RequestMeta) {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: input.portfolioId, userId, archivedAt: null },
    });
    if (!portfolio) throw new NotFoundException({ message: 'Portfolio not found', code: 'NOT_FOUND' });
    if (portfolio.kind !== 'LIVE' || !portfolio.brokerAccountId) {
      throw new UnprocessableEntityException({
        message: 'Statements can only be imported into a LIVE broker portfolio',
        code: 'IMPORT_REQUIRES_LIVE_PORTFOLIO',
      });
    }
    const brokerAccountId = portfolio.brokerAccountId;
    const fileSha256 = createHash('sha256').update(input.content, 'utf8').digest('hex');

    const existing = await this.prisma.importedStatement.findUnique({
      where: { brokerAccountId_fileSha256: { brokerAccountId, fileSha256 } },
    });
    if (existing) throw this.duplicateFile(existing.id, existing.fileName);

    const parser = this.parsers.resolve(input.fileName, input.content, input.kind);
    if (!parser) {
      throw new UnprocessableEntityException({
        message: `Unrecognised file. Supported: ${this.parsers.supportedKinds().join(', ')} (CSV with date, symbol, side, quantity, price columns)`,
        code: 'UNSUPPORTED_FILE',
      });
    }
    let parsed: ParsedTradeRow[];
    try {
      parsed = parser.parse(input.content);
    } catch (err) {
      throw new UnprocessableEntityException({
        message: `Could not parse file: ${(err as Error).message}`,
        code: 'PARSE_FAILED',
      });
    }
    if (parsed.length === 0)
      throw new UnprocessableEntityException({
        message: 'The file contains no data rows',
        code: 'EMPTY_FILE',
      });

    const staged = await this.validateRows(portfolio.id, brokerAccountId, parsed);
    const dates = staged.flatMap((r) => (r.payload.trade ? [r.payload.trade.tradeDate] : [])).sort();
    const counts = this.count(staged.map((r) => r.status));

    try {
      const statement = await this.prisma.$transaction(async (tx) => {
        const s = await tx.importedStatement.create({
          data: {
            brokerAccountId,
            portfolioId: portfolio.id,
            uploadedById: userId,
            kind: parser.kind,
            channel: 'UPLOAD',
            fileName: input.fileName,
            mimeType: 'text/csv',
            sizeBytes: Buffer.byteLength(input.content, 'utf8'),
            fileSha256,
            parserKey: parser.key,
            parserVersion: parser.version,
            periodFrom: dates.length ? new Date(`${dates[0]}T00:00:00Z`) : null,
            periodTo: dates.length ? new Date(`${dates.at(-1)}T00:00:00Z`) : null,
            status: 'AWAITING_REVIEW',
            rowsTotal: staged.length,
            rowsDuplicate: counts.DUPLICATE ?? 0,
            rowsInvalid: counts.INVALID ?? 0,
          },
        });
        await tx.importedRow.createMany({
          data: staged.map((r) => ({
            statementId: s.id,
            rowIndex: r.rowIndex,
            rowType: 'TRADE',
            raw: r.raw,
            parsed: r.payload as unknown as Prisma.InputJsonValue,
            fingerprint: r.fingerprint,
            status: r.status,
            errors: r.issues as unknown as Prisma.InputJsonValue,
          })),
        });
        await this.audit.record(
          {
            action: 'import.uploaded',
            actorType: 'USER',
            actorUserId: userId,
            entityType: 'imported_statement',
            entityId: s.id,
            after: { fileName: input.fileName, parser: parser.key, rows: staged.length, counts },
            ...meta,
          },
          tx,
        );
        return s;
      });
      return this.present(userId, statement.id);
    } catch (err) {
      // Lost the race against a concurrent upload of the same file: the unique constraint is the final arbiter.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const dup = await this.prisma.importedStatement.findUnique({
          where: { brokerAccountId_fileSha256: { brokerAccountId, fileSha256 } },
        });
        throw this.duplicateFile(dup?.id ?? null, dup?.fileName ?? input.fileName);
      }
      throw err;
    }
  }

  private async validateRows(portfolioId: string, brokerAccountId: string, rows: ParsedTradeRow[]) {
    const valid = rows.filter((r) => r.trade);
    const symbols = [...new Set(valid.map((r) => r.trade!.symbol))];
    const stocks = await this.prisma.stock.findMany({
      where: { symbol: { in: symbols } },
      select: { id: true, symbol: true },
    });
    const stockBySymbol = new Map(stocks.map((s) => [s.symbol, s.id]));

    const fingerprints = valid.map((r) => tradeFingerprint(portfolioId, r.trade!));
    const priorRows = await this.prisma.importedRow.findMany({
      where: { fingerprint: { in: fingerprints }, status: 'COMMITTED', statement: { brokerAccountId } },
      select: { id: true, rowIndex: true, fingerprint: true, statement: { select: { fileName: true } } },
    });
    const priorByFp = new Map(priorRows.map((r) => [r.fingerprint, r]));

    // Existing ledger trades in the same window (manual fills, earlier imports, order-pipeline fills).
    const dates = valid.map((r) => r.trade!.tradeDate).sort();
    const ledgerTxs = dates.length
      ? await this.prisma.transaction.findMany({
          where: {
            portfolioId,
            reversedById: null,
            type: { in: ['BUY', 'SELL'] },
            stockId: { in: [...stockBySymbol.values()] },
            tradeDate: { gte: new Date(`${dates[0]}T00:00:00Z`), lte: new Date(`${dates.at(-1)}T00:00:00Z`) },
          },
          select: {
            id: true,
            stockId: true,
            type: true,
            tradeDate: true,
            quantity: true,
            price: true,
            source: true,
            externalRef: true,
          },
        })
      : [];
    const ledgerKey = (stockId: string, side: string, date: string, qty: string, price: string) =>
      `${stockId}|${side}|${date}|${norm(qty)}|${norm(price)}`;
    const ledgerByKey = new Map<string, (typeof ledgerTxs)[number][]>();
    for (const t of ledgerTxs) {
      const k = ledgerKey(t.stockId, t.type, dateOf(t.tradeDate), t.quantity.toString(), t.price.toString());
      ledgerByKey.set(k, [...(ledgerByKey.get(k) ?? []), t]);
    }
    const ledgerRefs = new Set(
      ledgerTxs.filter((t) => t.externalRef).map((t) => `${t.externalRef}|${t.stockId}|${t.type}`),
    );

    const seenRef = new Map<string, number>();
    const seenFp = new Map<string, number>();
    const claimedLedger = new Set<string>();

    return rows.map((r) => {
      const issues: RowIssue[] = r.errors.map((message) => ({ level: 'error' as const, message }));
      const t = r.trade ?? null;
      const payload: ParsedPayload = {
        trade: t,
        feeSource: t && t.fees.length > 0 ? 'FILE' : 'ESTIMATED_ON_COMMIT',
      };
      let status: ImportRowStatus = issues.length ? 'INVALID' : 'VALID';
      const fingerprint = t
        ? tradeFingerprint(portfolioId, t)
        : createHash('sha256').update(JSON.stringify(r.raw)).digest('hex');

      if (t) {
        const stockId = stockBySymbol.get(t.symbol);
        if (!stockId) {
          issues.push({ level: 'error', message: `unknown symbol ${t.symbol} (not in the PSX stock list)` });
          status = 'INVALID';
        }
        if (t.externalRef) {
          const refKey = `${t.externalRef}|${t.symbol}|${t.side}`;
          const firstRow = seenRef.get(refKey);
          if (firstRow !== undefined) {
            issues.push({
              level: 'error',
              message: `reference ${t.externalRef} repeats row ${firstRow} for the same symbol and side`,
            });
            status = 'INVALID';
          } else seenRef.set(refKey, r.rowIndex);
        }
        if (status === 'VALID' && stockId) {
          const prior = priorByFp.get(fingerprint);
          const refHit = t.externalRef ? ledgerRefs.has(`${t.externalRef}|${stockId}|${t.side}`) : false;
          const ledgerHit = (
            ledgerByKey.get(ledgerKey(stockId, t.side, t.tradeDate, t.quantity, t.price)) ?? []
          ).find((x) => !claimedLedger.has(x.id));
          if (prior) {
            status = 'DUPLICATE';
            payload.duplicateOf = {
              kind: 'IMPORT_ROW',
              id: prior.id,
              detail: `already imported from ${prior.statement.fileName} (row ${prior.rowIndex})`,
            };
          } else if (refHit || ledgerHit) {
            status = 'DUPLICATE';
            if (ledgerHit) claimedLedger.add(ledgerHit.id);
            payload.duplicateOf = {
              kind: 'TRANSACTION',
              id: ledgerHit?.id ?? '',
              detail: refHit
                ? `reference ${t.externalRef} is already in the ledger`
                : `matches an existing ${ledgerHit!.source} transaction`,
            };
          }
          if (status === 'DUPLICATE')
            issues.push({
              level: 'warning',
              message: `${payload.duplicateOf!.detail} — skipped unless you include it`,
            });
        }
        const sameRow = seenFp.get(fingerprint);
        if (sameRow !== undefined && status === 'VALID') {
          issues.push({
            level: 'warning',
            message: `identical to row ${sameRow} — confirm these are two separate fills`,
          });
        }
        if (!seenFp.has(fingerprint)) seenFp.set(fingerprint, r.rowIndex);
        if (payload.feeSource === 'ESTIMATED_ON_COMMIT' && status !== 'INVALID') {
          issues.push({
            level: 'warning',
            message: 'no charges in file — fees will be ESTIMATED from the fee schedule',
          });
        }
      }
      return { rowIndex: r.rowIndex, raw: r.raw, payload, fingerprint, status, issues };
    });
  }

  // ── Review ─────────────────────────────────────────────────────────────────

  async list(userId: string, portfolioId?: string) {
    const rows = await this.prisma.importedStatement.findMany({
      where: { brokerAccount: { userId }, ...(portfolioId ? { portfolioId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true },
    });
    return Promise.all(rows.map((r) => this.present(userId, r.id)));
  }

  async present(userId: string, importId: string) {
    const s = await this.prisma.importedStatement.findFirst({
      where: { id: importId, brokerAccount: { userId } },
    });
    if (!s) throw new NotFoundException({ message: 'Import not found', code: 'NOT_FOUND' });
    const grouped = await this.prisma.importedRow.groupBy({
      by: ['status'],
      where: { statementId: s.id },
      _count: { _all: true },
    });
    const parser = this.parsers.byKey(s.parserKey);
    return {
      id: s.id,
      portfolioId: s.portfolioId,
      kind: s.kind,
      channel: s.channel,
      fileName: s.fileName,
      sizeBytes: s.sizeBytes,
      parserKey: s.parserKey,
      source: parser?.source ?? null,
      status: s.status,
      uploadedAt: s.createdAt.toISOString(),
      committedAt: s.committedAt?.toISOString() ?? null,
      periodFrom: s.periodFrom ? dateOf(s.periodFrom) : null,
      periodTo: s.periodTo ? dateOf(s.periodTo) : null,
      rowCounts: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])) as Partial<
        Record<ImportRowStatus, number>
      >,
    };
  }

  async rows(userId: string, importId: string, status?: ImportRowStatus) {
    await this.present(userId, importId);
    const rows = await this.prisma.importedRow.findMany({
      where: { statementId: importId, ...(status ? { status } : {}) },
      orderBy: { rowIndex: 'asc' },
    });
    return rows.map((r) => {
      const p = r.parsed as unknown as ParsedPayload | null;
      const issues = (r.errors as unknown as RowIssue[]) ?? [];
      const t = p?.trade ?? null;
      return {
        id: r.id,
        rowNo: r.rowIndex,
        status: r.status,
        tradeDate: t?.tradeDate ?? null,
        symbol: t?.symbol ?? (r.raw as Record<string, string>).symbol ?? null,
        side: t?.side ?? null,
        quantity: t?.quantity ?? null,
        price: t?.price ?? null,
        contractRef: t?.externalRef ?? null,
        fees: t?.fees ?? [],
        feeSource: p?.feeSource ?? null,
        duplicateOf: p?.duplicateOf ?? null,
        errors: issues.filter((i) => i.level === 'error').map((i) => i.message),
        warnings: issues.filter((i) => i.level === 'warning').map((i) => i.message),
        message: issues.map((i) => i.message).join('; ') || null,
        raw: r.raw,
      };
    });
  }

  async updateRow(userId: string, importId: string, rowId: string, action: RowAction, meta: RequestMeta) {
    const s = await this.reviewable(userId, importId);
    const row = await this.prisma.importedRow.findFirst({ where: { id: rowId, statementId: s.id } });
    if (!row) throw new NotFoundException({ message: 'Row not found', code: 'NOT_FOUND' });
    const p = row.parsed as unknown as ParsedPayload | null;
    let next: ImportRowStatus;
    if (action === 'skip') {
      next = 'SKIPPED';
    } else if (
      row.status === 'DUPLICATE' ||
      (row.status === 'SKIPPED' &&
        p?.trade &&
        !(row.errors as unknown as RowIssue[]).some((i) => i.level === 'error'))
    ) {
      next = 'VALID';
    } else {
      throw new ConflictException({
        message: `A ${row.status} row cannot be included${row.status === 'INVALID' ? ' — fix the file and re-upload' : ''}`,
        code: 'ROW_NOT_INCLUDABLE',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.importedRow.update({ where: { id: row.id }, data: { status: next } });
      await this.audit.record(
        {
          action: `import.row_${action}`,
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'imported_row',
          entityId: row.id,
          before: { status: row.status },
          after: { status: next },
          ...meta,
        },
        tx,
      );
    });
    return (await this.rows(userId, importId)).find((r) => r.id === rowId)!;
  }

  async reject(userId: string, importId: string, meta: RequestMeta) {
    const s = await this.reviewable(userId, importId);
    await this.prisma.$transaction(async (tx) => {
      await tx.importedStatement.update({ where: { id: s.id }, data: { status: 'REJECTED' } });
      await this.audit.record(
        {
          action: 'import.rejected',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'imported_statement',
          entityId: s.id,
          ...meta,
        },
        tx,
      );
    });
    return this.present(userId, importId);
  }

  // ── Commit ─────────────────────────────────────────────────────────────────

  async commit(userId: string, importId: string, meta: RequestMeta) {
    const s = await this.reviewable(userId, importId);
    const parser = this.parsers.byKey(s.parserKey);
    if (!parser)
      throw new ConflictException({
        message: `Parser ${s.parserKey} is no longer available`,
        code: 'PARSER_UNAVAILABLE',
      });
    if (!s.portfolioId)
      throw new ConflictException({ message: 'Import has no target portfolio', code: 'NO_TARGET_PORTFOLIO' });
    const portfolioId = s.portfolioId;

    await this.prisma.$transaction(
      async (tx) => {
        // Row lock: a second concurrent commit waits here, then sees COMMITTED and stops.
        const locked = await tx.$queryRaw<
          { status: string }[]
        >`SELECT status FROM imported_statements WHERE id = ${s.id}::uuid FOR UPDATE`;
        if (locked[0]?.status !== 'AWAITING_REVIEW') {
          throw new ConflictException({
            message: `Import is ${locked[0]?.status ?? 'missing'}`,
            code: 'INVALID_IMPORT_STATE',
          });
        }
        const rows = await tx.importedRow.findMany({
          where: { statementId: s.id },
          orderBy: { rowIndex: 'asc' },
        });
        const invalid = rows.filter((r) => r.status === 'INVALID');
        if (invalid.length > 0) {
          throw new ConflictException({
            message: `Skip or fix ${invalid.length} invalid row(s) first (rows ${invalid.map((r) => r.rowIndex).join(', ')}) — nothing is dropped silently`,
            code: 'IMPORT_HAS_INVALID_ROWS',
          });
        }
        const toPost = rows
          .filter((r) => r.status === 'VALID')
          .map((r) => ({ row: r, trade: (r.parsed as unknown as ParsedPayload).trade! }))
          .sort((a, b) =>
            a.trade.tradeDate === b.trade.tradeDate
              ? a.row.rowIndex - b.row.rowIndex
              : a.trade.tradeDate < b.trade.tradeDate
                ? -1
                : 1,
          );
        if (toPost.length === 0)
          throw new ConflictException({
            message: 'No rows to commit — reject the import instead',
            code: 'NOTHING_TO_COMMIT',
          });

        const stocks = await tx.stock.findMany({
          where: { symbol: { in: [...new Set(toPost.map((x) => x.trade.symbol))] } },
          select: { id: true, symbol: true },
        });
        const stockBySymbol = new Map(stocks.map((x) => [x.symbol, x.id]));
        const rowByTxId = new Map<string, number>();
        const touched = new Set<string>();

        for (const { row, trade } of toPost) {
          const stockId = stockBySymbol.get(trade.symbol);
          if (!stockId)
            throw new ConflictException({
              message: `Row ${row.rowIndex}: unknown symbol ${trade.symbol}`,
              code: 'IMPORT_ROW_REJECTED',
              rowNo: row.rowIndex,
            });
          const fees = await this.feesFor(trade, parser);
          try {
            const { transactionId } = await this.ledger.postTrade(
              tx,
              {
                portfolioId,
                stockId,
                side: trade.side as OrderSide,
                quantity: d(trade.quantity),
                price: d(trade.price),
                tradeDate: trade.tradeDate,
                fees: fees.lines,
                feeScheduleId: fees.scheduleId,
                source: parser.source,
                externalRef: trade.externalRef ?? null,
                importedStmtId: s.id,
                notes: `Imported from ${s.fileName}, row ${row.rowIndex}`,
              },
              { rebuild: false },
            );
            rowByTxId.set(transactionId, row.rowIndex);
            touched.add(stockId);
          } catch (err) {
            throw this.rowError(err, row.rowIndex);
          }
        }

        for (const stockId of touched) {
          try {
            await this.ledger.rebuildSymbol(tx, portfolioId, stockId);
          } catch (err) {
            const body = err instanceof HttpException ? (err.getResponse() as { eventId?: string }) : {};
            const rowNo = body.eventId ? rowByTxId.get(body.eventId) : undefined;
            throw this.rowError(err, rowNo);
          }
        }

        await tx.importedRow.updateMany({
          where: { id: { in: toPost.map((x) => x.row.id) } },
          data: { status: 'COMMITTED' },
        });
        await tx.importedStatement.update({
          where: { id: s.id },
          data: { status: 'COMMITTED', committedAt: new Date(), rowsCommitted: toPost.length },
        });
        await this.audit.record(
          {
            action: 'import.committed',
            actorType: 'USER',
            actorUserId: userId,
            entityType: 'imported_statement',
            entityId: s.id,
            after: { rowsCommitted: toPost.length, symbols: touched.size, source: parser.source },
            ...meta,
          },
          tx,
        );
      },
      { timeout: COMMIT_TIMEOUT_MS, maxWait: 10_000 },
    );
    return this.present(userId, importId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** File-stated charges keep the parser's provenance; missing charges are estimated and labelled ESTIMATED. */
  private async feesFor(
    trade: Trade,
    parser: StatementParser,
  ): Promise<{ lines: FeeLineInput[]; scheduleId: string | null }> {
    if (trade.fees.length > 0) {
      return {
        lines: trade.fees.map((f) => ({
          component: f.component,
          amount: d(f.amount),
          capitalised: true,
          source: parser.source as DataSource,
        })),
        scheduleId: null,
      };
    }
    const est = await this.fees.estimate(
      trade.side as OrderSide,
      d(trade.quantity),
      d(trade.price),
      trade.tradeDate,
    );
    return { lines: feeLinesFromBreakdown(est.lines), scheduleId: est.scheduleId };
  }

  private rowError(err: unknown, rowNo: number | undefined): Error {
    const where = rowNo !== undefined ? `Row ${rowNo}: ` : '';
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException({
        message: `${where}this trade reference already exists in the ledger`,
        code: 'IMPORT_ROW_REJECTED',
        rowNo,
      });
    }
    if (err instanceof HttpException) {
      const body = err.getResponse() as { message?: string; code?: string };
      return new ConflictException({
        message: `${where}${body.message ?? err.message} — the whole import was rolled back`,
        code: body.code === 'INSUFFICIENT_HOLDINGS' ? 'IMPORT_OVERSELL' : 'IMPORT_ROW_REJECTED',
        rowNo,
      });
    }
    return err as Error;
  }

  private async reviewable(userId: string, importId: string) {
    const s = await this.prisma.importedStatement.findFirst({
      where: { id: importId, brokerAccount: { userId } },
    });
    if (!s) throw new NotFoundException({ message: 'Import not found', code: 'NOT_FOUND' });
    if (s.status !== 'AWAITING_REVIEW')
      throw new ConflictException({ message: `Import is already ${s.status}`, code: 'INVALID_IMPORT_STATE' });
    return s;
  }

  private duplicateFile(existingId: string | null, fileName: string) {
    return new ConflictException({
      message: `This exact file was already imported (${fileName})`,
      code: 'DUPLICATE_IMPORT',
      existingImportId: existingId,
    });
  }

  private count(statuses: ImportRowStatus[]): Partial<Record<ImportRowStatus, number>> {
    const out: Partial<Record<ImportRowStatus, number>> = {};
    for (const s of statuses) out[s] = (out[s] ?? 0) + 1;
    return out;
  }
}
