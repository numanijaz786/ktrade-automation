import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type CreateDividendInput,
  dateOrderIssue,
  type ListDividendsQuery,
  type UpdateDividendInput,
} from './dividends.schemas.js';

type Tx = Prisma.TransactionClient;

export const iso = (date: Date): string => date.toISOString().slice(0, 10);
export const isoOrNull = (date: Date | null | undefined): string | null => (date ? iso(date) : null);
export const toDate = (s: string): Date => new Date(`${s}T00:00:00Z`);
const toDateOrNull = (s: string | null | undefined): Date | null => (s ? toDate(s) : null);

/** Statuses after which a declaration (and its entitlement) is a settled fact and may no longer change. */
export const SETTLED_STATUSES = ['PAID', 'RECONCILED'] as const;

/**
 * Serialises every write that touches one declaration or its entitlements (edit/delete vs compute vs mark-paid),
 * so a declaration can never change after one of its entitlements was paid.
 */
export async function lockDividend(tx: Tx, dividendId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dividend:${dividendId}`}, 0))`;
}

type DividendRow = Prisma.DividendGetPayload<{ include: { stock: true } }>;

function view(r: DividendRow, settledEntitlements: number) {
  return {
    id: r.id,
    symbol: r.stock.symbol,
    companyName: r.stock.name,
    announcementDate: isoOrNull(r.announcementDate),
    bookClosureFrom: iso(r.bookClosureFrom),
    bookClosureTo: isoOrNull(r.bookClosureTo),
    paymentDate: isoOrNull(r.paymentDate),
    dividendPerShare: r.dividendPerShare.toString(),
    source: r.source,
    /** True once any entitlement is PAID/RECONCILED — the declaration is then immutable. */
    locked: settledEntitlements > 0,
    createdAt: r.createdAt.toISOString(),
  };
}

const settledCount = {
  _count: { select: { entitlements: { where: { status: { in: [...SETTLED_STATUSES] } } } } },
} satisfies Prisma.DividendInclude;

/** Cash-dividend declarations (docs/07 "dividends"). Declarations are reference data shared by all portfolios. */
@Injectable()
export class DividendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: ListDividendsQuery) {
    const rows = await this.prisma.dividend.findMany({
      where: q.symbol ? { stock: { symbol: q.symbol } } : {},
      include: { stock: true, ...settledCount },
      orderBy: [{ bookClosureFrom: 'desc' }, { createdAt: 'desc' }],
      take: q.limit,
    });
    return rows.map((r) => view(r, r._count.entitlements));
  }

  async get(id: string) {
    const r = await this.prisma.dividend.findUnique({
      where: { id },
      include: { stock: true, ...settledCount },
    });
    if (!r) throw notFound();
    return view(r, r._count.entitlements);
  }

  async create(userId: string, input: CreateDividendInput, meta: RequestMeta) {
    const stock = await this.prisma.stock.findUnique({ where: { symbol: input.symbol } });
    if (!stock) throw new NotFoundException({ message: `Unknown symbol ${input.symbol}`, code: 'NOT_FOUND' });
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const r = await tx.dividend.create({
          data: {
            stockId: stock.id,
            announcementDate: toDateOrNull(input.announcementDate),
            bookClosureFrom: toDate(input.bookClosureFrom),
            bookClosureTo: toDateOrNull(input.bookClosureTo),
            paymentDate: toDateOrNull(input.paymentDate),
            dividendPerShare: input.dividendPerShare,
            source: input.source,
          },
          include: { stock: true },
        });
        const v = view(r, 0);
        await this.audit.record(
          {
            action: 'dividend.declared',
            actorType: 'USER',
            actorUserId: userId,
            entityType: 'dividend',
            entityId: r.id,
            after: v,
            ...meta,
          },
          tx,
        );
        return v;
      });
      return created;
    } catch (err) {
      throw duplicateOr(err);
    }
  }

  async update(userId: string, id: string, input: UpdateDividendInput, meta: RequestMeta) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockDividend(tx, id);
        const before = await this.loadUnlocked(tx, id);
        const merged = {
          announcementDate:
            input.announcementDate === undefined ? before.announcementDate : input.announcementDate,
          bookClosureFrom: input.bookClosureFrom ?? before.bookClosureFrom,
          bookClosureTo: input.bookClosureTo === undefined ? before.bookClosureTo : input.bookClosureTo,
          paymentDate: input.paymentDate === undefined ? before.paymentDate : input.paymentDate,
        };
        const issue = dateOrderIssue(merged);
        if (issue) {
          throw new UnprocessableEntityException({
            message: issue.message,
            code: 'INVALID_DATE_ORDER',
            field: issue.path,
          });
        }
        // Estimated (unpaid) entitlements were computed from the old terms: drop them so a stale estimate can never
        // be shown or paid. The owner recomputes.
        const cleared = await tx.dividendEntitlement.deleteMany({ where: { dividendId: id } });
        const r = await tx.dividend.update({
          where: { id },
          data: {
            ...(input.announcementDate !== undefined && {
              announcementDate: toDateOrNull(input.announcementDate),
            }),
            ...(input.bookClosureFrom !== undefined && { bookClosureFrom: toDate(input.bookClosureFrom) }),
            ...(input.bookClosureTo !== undefined && { bookClosureTo: toDateOrNull(input.bookClosureTo) }),
            ...(input.paymentDate !== undefined && { paymentDate: toDateOrNull(input.paymentDate) }),
            ...(input.dividendPerShare !== undefined && { dividendPerShare: input.dividendPerShare }),
          },
          include: { stock: true },
        });
        const after = view(r, 0);
        await this.audit.record(
          {
            action: 'dividend.updated',
            actorType: 'USER',
            actorUserId: userId,
            entityType: 'dividend',
            entityId: id,
            before: before.view,
            after,
            metadata: { estimatedEntitlementsCleared: cleared.count },
            ...meta,
          },
          tx,
        );
        return { ...after, estimatedEntitlementsCleared: cleared.count };
      });
    } catch (err) {
      throw duplicateOr(err);
    }
  }

  async remove(userId: string, id: string, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      await lockDividend(tx, id);
      const before = await this.loadUnlocked(tx, id);
      const cleared = await tx.dividendEntitlement.deleteMany({ where: { dividendId: id } });
      await tx.dividend.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'dividend.deleted',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'dividend',
          entityId: id,
          before: before.view,
          metadata: { estimatedEntitlementsCleared: cleared.count },
          ...meta,
        },
        tx,
      );
      return { id, deleted: true, estimatedEntitlementsCleared: cleared.count };
    });
  }

  /** Load a declaration for modification: 404 if missing, 409 once any entitlement has been paid. */
  private async loadUnlocked(tx: Tx, id: string) {
    const r = await tx.dividend.findUnique({ where: { id }, include: { stock: true, ...settledCount } });
    if (!r) throw notFound();
    if (r._count.entitlements > 0) {
      throw new ConflictException({
        message: 'This dividend has paid entitlements and can no longer be changed',
        code: 'DIVIDEND_LOCKED',
      });
    }
    const v = view(r, 0);
    return {
      view: v,
      announcementDate: v.announcementDate,
      bookClosureFrom: v.bookClosureFrom,
      bookClosureTo: v.bookClosureTo,
      paymentDate: v.paymentDate,
    };
  }
}

function notFound() {
  return new NotFoundException({ message: 'Dividend not found', code: 'NOT_FOUND' });
}

function duplicateOr(err: unknown): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return new ConflictException({
      message: 'A dividend with this book-closure start already exists for the stock',
      code: 'ALREADY_EXISTS',
    });
  }
  return err;
}
