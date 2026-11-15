import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  computeDividendEntitlement,
  type Decimal,
  d,
  LedgerError,
  orderLedgerEvents,
  replay,
  roundMoney,
  type TaxRateRow,
  ZERO,
} from '@ktrade/finance-core';
import type { TaxFilerStatus } from '@ktrade/shared';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { CLOCK, type Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { pktDateOf } from '../market-data/calendar.js';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { iso, isoOrNull, lockDividend, SETTLED_STATUSES, toDate } from './dividends.service.js';
import type { MarkPaidInput, ReconcileInput } from './dividends.schemas.js';
import {
  DEFAULT_SETTLEMENT_DAYS,
  eligibleShares,
  MAX_SETTLEMENT_DAYS,
  type ShareDelta,
} from './eligibility.js';
import { lookupDividendWht, type WhtLookup } from './wht.js';

type Tx = Prisma.TransactionClient;
type Db = PrismaService | Tx;

export const SETTLEMENT_DAYS_KEY = 'market.settlementDays';
const dec = (v: { toString(): string } | null | undefined): Decimal =>
  v === null || v === undefined ? ZERO : d(v.toString());
const m4 = (x: Decimal) => roundMoney(x).toFixed(4);
const RATE_DP = 8; // dividend_entitlements.wht_rate is NUMERIC(12,8)

/** Statuses the compute job may (re)write. PAID / RECONCILED / CANCELLED rows are never touched. */
const ESTIMATE_STATUSES = ['ANNOUNCED', 'ENTITLED'] as const;

type EntitlementRow = Prisma.DividendEntitlementGetPayload<{
  include: { dividend: { include: { stock: true } } };
}>;

export interface SettlementConfig {
  days: number;
  basis: 'SYSTEM_SETTING' | 'DEFAULT';
  note: string;
}

export interface TaxContext {
  filerStatus: TaxFilerStatus;
  rows: TaxRateRow[];
}

/**
 * Dividend entitlements (docs/06 §6): ENTITLED (computed, ESTIMATED) → PAID (cash movement, USER_REPORTED)
 * → RECONCILED (matched to a statement, BROKER_CONFIRMED).
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly calendar: MarketCalendarService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────────────────── read ─────────────────────────

  async list(userId: string, portfolioId: string) {
    await this.ownedPortfolio(this.prisma, userId, portfolioId);
    const [rows, tax] = await Promise.all([
      this.prisma.dividendEntitlement.findMany({
        where: { portfolioId },
        include: { dividend: { include: { stock: true } } },
        orderBy: [{ dividend: { bookClosureFrom: 'desc' } }, { createdAt: 'desc' }],
      }),
      this.taxContext(this.prisma, userId),
    ]);
    const today = this.today();
    return { data: rows.map((r) => this.view(r, tax, today)), filerStatus: tax.filerStatus };
  }

  // ───────────────────────── compute ─────────────────────────

  /**
   * (Re)compute the estimated entitlement of every declaration whose book closure falls inside the portfolio's
   * holding history. Idempotent: one row per (dividend, portfolio); unchanged rows are not rewritten; PAID,
   * RECONCILED and CANCELLED rows are never modified.
   */
  async compute(userId: string, portfolioId: string, meta: RequestMeta) {
    const calendar = await this.calendar.refresh(true);
    const today = this.today();
    return this.prisma.$transaction(
      async (tx) => {
        const portfolio = await this.ownedPortfolio(tx, userId, portfolioId);
        // Sequential: one transaction = one connection (no concurrent queries on it).
        const settlement = await this.settlementConfig(tx);
        const tax = await this.taxContext(tx, userId);

        // First ledger date per stock the portfolio ever held.
        const firstDates = await tx.transaction.groupBy({
          by: ['stockId'],
          where: { portfolioId, reversedById: null, reverses: { is: null } },
          _min: { tradeDate: true },
        });
        const firstByStock = new Map(firstDates.map((f) => [f.stockId, f._min.tradeDate!]));
        const dividends = await tx.dividend.findMany({
          where: { stockId: { in: [...firstByStock.keys()] } },
          include: { stock: true },
          orderBy: { id: 'asc' }, // lock order: deterministic, so concurrent computes cannot deadlock
        });
        const inHistory = dividends.filter((dv) => dv.bookClosureFrom > firstByStock.get(dv.stockId)!);

        const deltasByStock = new Map<string, ShareDelta[]>();
        const counts = {
          created: 0,
          updated: 0,
          unchanged: 0,
          removed: 0,
          skippedSettled: 0,
          notEligible: 0,
        };
        const changes: Array<{ dividendId: string; symbol: string; action: string; sharesEligible: string }> =
          [];
        const result: ReturnType<EntitlementsService['view']>[] = [];

        for (const dv of inHistory) {
          await lockDividend(tx, dv.id);
          const existing = await tx.dividendEntitlement.findUnique({
            where: { dividendId_portfolioId: { dividendId: dv.id, portfolioId } },
            include: { dividend: { include: { stock: true } } },
          });
          if (existing && !(ESTIMATE_STATUSES as readonly string[]).includes(existing.status)) {
            counts.skippedSettled++;
            result.push(this.view(existing, tax, today));
            continue;
          }

          let deltas = deltasByStock.get(dv.stockId);
          if (!deltas) {
            deltas = await this.shareDeltas(tx, portfolioId, dv.stockId, portfolio.costBasisMethod);
            deltasByStock.set(dv.stockId, deltas);
          }
          const bookClosureFrom = iso(dv.bookClosureFrom);
          let shares: Decimal;
          try {
            shares = eligibleShares(deltas, bookClosureFrom, settlement.days, calendar);
          } catch (err) {
            if (err instanceof RangeError) {
              throw new ConflictException({
                message: `Cannot determine settled holdings of ${dv.stock.symbol} before ${bookClosureFrom}: ${err.message}`,
                code: 'ELIGIBILITY_UNDETERMINED',
              });
            }
            throw err;
          }

          if (shares.isZero()) {
            counts.notEligible++;
            if (existing) {
              await tx.dividendEntitlement.delete({ where: { id: existing.id } });
              counts.removed++;
              changes.push({
                dividendId: dv.id,
                symbol: dv.stock.symbol,
                action: 'removed',
                sharesEligible: '0',
              });
            }
            continue;
          }

          const wht = lookupDividendWht(tax.rows, tax.filerStatus, whtDate(dv));
          const rate = wht.status === 'CONFIGURED' ? wht.rate : ZERO;
          const amounts = computeDividendEntitlement({
            sharesEligible: shares,
            dividendPerShare: dec(dv.dividendPerShare),
            whtRate: rate,
            zakatAmount: ZERO,
          });
          const data = {
            sharesEligible: amounts.sharesEligible.toFixed(),
            grossAmount: m4(amounts.gross),
            // NOT NULL columns: when WHT is not configured 0 is stored and every response flags it (never a guess).
            whtRate: amounts.whtRate.toFixed(RATE_DP),
            whtAmount: m4(amounts.wht),
            zakatAmount: m4(amounts.zakat),
            netAmount: m4(amounts.net),
            status: 'ENTITLED' as const,
            source: 'ESTIMATED' as const,
          };

          let row: EntitlementRow;
          if (!existing) {
            row = await tx.dividendEntitlement.create({
              data: { dividendId: dv.id, portfolioId, ...data },
              include: { dividend: { include: { stock: true } } },
            });
            counts.created++;
            changes.push({
              dividendId: dv.id,
              symbol: dv.stock.symbol,
              action: 'created',
              sharesEligible: data.sharesEligible,
            });
          } else if (sameEstimate(existing, data)) {
            row = existing;
            counts.unchanged++;
          } else {
            const updated = await tx.dividendEntitlement.updateMany({
              where: { id: existing.id, status: { in: [...ESTIMATE_STATUSES] } },
              data,
            });
            if (updated.count !== 1) throw changedConcurrently();
            row = await tx.dividendEntitlement.findUniqueOrThrow({
              where: { id: existing.id },
              include: { dividend: { include: { stock: true } } },
            });
            counts.updated++;
            changes.push({
              dividendId: dv.id,
              symbol: dv.stock.symbol,
              action: 'updated',
              sharesEligible: data.sharesEligible,
            });
          }
          result.push(this.view(row, tax, today));
        }

        await this.audit.record(
          {
            action: 'dividend_entitlements.computed',
            actorType: 'USER',
            actorUserId: userId,
            entityType: 'portfolio',
            entityId: portfolioId,
            after: { counts, changes },
            metadata: {
              settlementDays: settlement.days,
              settlementBasis: settlement.basis,
              filerStatus: tax.filerStatus,
              declarationsConsidered: inHistory.length,
            },
            ...meta,
          },
          tx,
        );

        return {
          portfolioId,
          settlement,
          filerStatus: tax.filerStatus,
          counts,
          data: result,
        };
      },
      { timeout: 60_000 },
    );
  }

  // ───────────────────────── payment ─────────────────────────

  async markPaid(userId: string, id: string, input: MarkPaidInput, meta: RequestMeta) {
    const today = this.today();
    if (input.paidAt > today) {
      throw new UnprocessableEntityException({
        message: 'paidAt cannot be in the future',
        code: 'INVALID_DATE',
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const pre = await this.ownedEntitlement(tx, userId, id);
      await lockDividend(tx, pre.dividendId);
      const e = await this.ownedEntitlement(tx, userId, id); // re-read under the lock
      if (!(ESTIMATE_STATUSES as readonly string[]).includes(e.status)) {
        throw new ConflictException({
          message: `Entitlement is ${e.status}; only an ENTITLED dividend can be marked paid`,
          code: 'ENTITLEMENT_NOT_PAYABLE',
        });
      }
      const tax = await this.taxContext(tx, userId);
      const estimate = this.view(e, tax, today);

      const gross = dec(e.grossAmount);
      const net = d(input.netAmount);
      const zakat = input.zakatAmount !== undefined ? d(input.zakatAmount) : dec(e.zakatAmount);
      // Withholding is REQUIRED and taken from the payment advice (ADR-031). It is never inferred from cash
      // received: a shortfall could be a wrong share count or a missing payment, not tax. Anything that does
      // not add up is surfaced as `unexplainedDifference` instead of being booked as withholding.
      const wht = d(input.whtAmount);
      const whtBasis = 'REPORTED' as const;
      const unexplained = gross.minus(zakat).minus(wht).minus(net);
      const effectiveRate = gross.isZero() ? ZERO : wht.div(gross).toDecimalPlaces(RATE_DP);
      if (effectiveRate.gt(1)) {
        throw new UnprocessableEntityException({
          message: 'Withholding exceeds the gross dividend',
          code: 'INVALID_WHT',
        });
      }

      const symbol = e.dividend.stock.symbol;
      const cash = await tx.cashMovement.create({
        data: {
          portfolioId: e.portfolioId,
          type: 'DIVIDEND',
          amount: m4(net),
          valueDate: toDate(input.paidAt),
          description: `Dividend ${symbol} (book closure ${iso(e.dividend.bookClosureFrom)})`,
          source: 'USER_REPORTED',
          // Unique (portfolio, externalRef, type): a second cash movement for the same entitlement is impossible.
          externalRef: `dividend-entitlement:${e.id}`,
        },
      });
      const claimed = await tx.dividendEntitlement.updateMany({
        where: { id: e.id, status: { in: [...ESTIMATE_STATUSES] }, cashMovementId: null },
        data: {
          status: 'PAID',
          paidAt: toDate(input.paidAt),
          cashMovementId: cash.id,
          netAmount: m4(net),
          whtAmount: m4(wht),
          whtRate: effectiveRate.toFixed(RATE_DP),
          zakatAmount: m4(zakat),
          source: 'USER_REPORTED',
        },
      });
      if (claimed.count !== 1) throw changedConcurrently();
      const paid = await tx.dividendEntitlement.findUniqueOrThrow({
        where: { id: e.id },
        include: { dividend: { include: { stock: true } } },
      });

      const differences = {
        /** received net − estimated net (null when the estimate had no configured WHT). */
        netAmount: estimate.netAmount === null ? null : m4(net.minus(estimate.netAmount)),
        /** recorded WHT − estimated WHT (null when the estimate had no configured WHT). */
        whtAmount: estimate.whtAmount === null ? null : m4(wht.minus(estimate.whtAmount)),
        /** (net + WHT + zakat) − estimated gross: non-zero means the share count or DPS differs from the estimate. */
        grossAmount: m4(net.plus(wht).plus(zakat).minus(gross)),
      };

      await this.notifications.notify(
        {
          userId,
          type: 'DIVIDEND_RECEIVED',
          title: `Dividend received: ${symbol}`,
          body: `PKR ${m4(net)} net received on ${input.paidAt} for ${e.sharesEligible.toString()} shares.`,
          dedupeKey: `dividend-entitlement:${e.id}:PAID`,
          data: {
            entitlementId: e.id,
            dividendId: e.dividendId,
            portfolioId: e.portfolioId,
            symbol,
            netAmount: m4(net),
          },
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'dividend_entitlement.paid',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'dividend_entitlement',
          entityId: e.id,
          before: estimate,
          after: {
            status: 'PAID',
            paidAt: input.paidAt,
            netAmount: m4(net),
            whtAmount: m4(wht),
            zakatAmount: m4(zakat),
          },
          metadata: { cashMovementId: cash.id, whtBasis, differences },
          ...meta,
        },
        tx,
      );

      return {
        entitlement: this.view(paid, tax, today),
        cashMovementId: cash.id,
        whtBasis,
        unexplainedDifference: m4(unexplained),
        warnings: unexplained.isZero()
          ? []
          : [
              `gross − zakat − withholding − received = ${m4(unexplained)}: check the share count and the payment advice`,
            ],
        estimate: {
          netAmount: estimate.netAmount,
          whtAmount: estimate.whtAmount,
          grossAmount: estimate.grossAmount,
          taxStatus: estimate.taxStatus,
        },
        differences,
      };
    });
  }

  /** Manual confirmation that the payment matches a broker / CDC statement: PAID → RECONCILED (BROKER_CONFIRMED). */
  async reconcile(userId: string, id: string, input: ReconcileInput, meta: RequestMeta) {
    const today = this.today();
    return this.prisma.$transaction(async (tx) => {
      const pre = await this.ownedEntitlement(tx, userId, id);
      await lockDividend(tx, pre.dividendId);
      const e = await this.ownedEntitlement(tx, userId, id);
      if (e.status !== 'PAID' || !e.cashMovementId) {
        throw new ConflictException({
          message: `Entitlement is ${e.status}; only a PAID dividend can be reconciled`,
          code: 'ENTITLEMENT_NOT_RECONCILABLE',
        });
      }
      const now = this.clock.now();
      const claimed = await tx.dividendEntitlement.updateMany({
        where: { id: e.id, status: 'PAID' },
        data: { status: 'RECONCILED', source: 'BROKER_CONFIRMED', reconciledAt: now },
      });
      if (claimed.count !== 1) throw changedConcurrently();
      await tx.cashMovement.update({ where: { id: e.cashMovementId }, data: { source: 'BROKER_CONFIRMED' } });
      const row = await tx.dividendEntitlement.findUniqueOrThrow({
        where: { id: e.id },
        include: { dividend: { include: { stock: true } } },
      });
      await this.audit.record(
        {
          action: 'dividend_entitlement.reconciled',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'dividend_entitlement',
          entityId: e.id,
          before: { status: 'PAID', source: e.source },
          after: { status: 'RECONCILED', source: 'BROKER_CONFIRMED', reconciledAt: now.toISOString() },
          metadata: { statementRef: input.statementRef ?? null, cashMovementId: e.cashMovementId },
          ...meta,
        },
        tx,
      );
      const tax = await this.taxContext(tx, userId);
      return this.view(row, tax, today);
    });
  }

  // ───────────────────────── helpers ─────────────────────────

  /**
   * Signed share delta of every live ledger event of one symbol, from the SAME row → event mapping and replay the
   * holdings projection uses (so bonus/split quantities match the holdings exactly).
   */
  private async shareDeltas(
    tx: Tx,
    portfolioId: string,
    stockId: string,
    method: 'WEIGHTED_AVERAGE' | 'FIFO',
  ): Promise<ShareDelta[]> {
    const rows = await tx.transaction.findMany({
      where: { portfolioId, stockId, reversedById: null, reverses: { is: null } },
      orderBy: [{ tradeDate: 'asc' }, { createdAt: 'asc' }],
      include: { corporateAction: true },
    });
    const typeById = new Map(rows.map((r) => [r.id, r.type]));
    let results;
    try {
      results = replay(orderLedgerEvents(rows.map((r, i) => this.ledger.toEvent(r, i))), method).results;
    } catch (err) {
      if (err instanceof LedgerError) {
        throw new ConflictException({
          message: err.message,
          code: `LEDGER_${err.code}`,
          eventId: err.eventId,
        });
      }
      throw err;
    }
    return results.map((r) => {
      const type = typeById.get(r.eventId);
      return {
        date: r.date,
        quantity: r.quantityAfter.minus(r.quantityBefore),
        settles: type === 'BUY' || type === 'SELL' ? 'T_PLUS_N' : 'EVENT_DATE',
      };
    });
  }

  /** `system_settings['market.settlementDays']` (an integer, or `{ "days": n }`); default T+1. */
  async settlementConfig(db: Db): Promise<SettlementConfig> {
    const row = await db.systemSetting.findUnique({ where: { key: SETTLEMENT_DAYS_KEY } });
    if (!row) {
      return {
        days: DEFAULT_SETTLEMENT_DAYS,
        basis: 'DEFAULT',
        note:
          `Default T+${DEFAULT_SETTLEMENT_DAYS} settlement (PSX ready market). The owner must confirm the cycle ` +
          `against the current NCCPL rules and set system_settings '${SETTLEMENT_DAYS_KEY}'.`,
      };
    }
    const raw = row.value as unknown;
    const days =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'object' && raw !== null
          ? (raw as { days?: unknown }).days
          : undefined;
    if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 0 || days > MAX_SETTLEMENT_DAYS) {
      throw new ConflictException({
        message: `system_settings '${SETTLEMENT_DAYS_KEY}' must be an integer 0–${MAX_SETTLEMENT_DAYS}`,
        code: 'SETTLEMENT_SETTING_INVALID',
      });
    }
    return { days, basis: 'SYSTEM_SETTING', note: `T+${days} settlement from system_settings.` };
  }

  private async taxContext(db: Db, userId: string): Promise<TaxContext> {
    // Sequential: `db` may be a transaction client (a single connection).
    const settings = await db.userSettings.findUnique({
      where: { userId },
      select: { taxFilerStatus: true },
    });
    const rates = await db.taxRate.findMany({ where: { taxType: 'DIVIDEND_WITHHOLDING', verified: true } });
    return {
      filerStatus: settings?.taxFilerStatus ?? 'UNKNOWN',
      rows: rates.map((r) => ({
        taxType: r.taxType,
        filerStatus: r.filerStatus,
        minHoldingDays: r.minHoldingDays,
        maxHoldingDays: r.maxHoldingDays,
        rate: dec(r.rate),
        effectiveFrom: iso(r.effectiveFrom),
        effectiveTo: isoOrNull(r.effectiveTo),
        verified: r.verified,
      })),
    };
  }

  private async ownedPortfolio(db: Db, userId: string, portfolioId: string) {
    const p = await db.portfolio.findFirst({ where: { id: portfolioId, userId, archivedAt: null } });
    if (!p) throw new NotFoundException({ message: 'Portfolio not found', code: 'NOT_FOUND' });
    return p;
  }

  private async ownedEntitlement(db: Db, userId: string, id: string): Promise<EntitlementRow> {
    const e = await db.dividendEntitlement.findFirst({
      where: { id, portfolio: { userId } },
      include: { dividend: { include: { stock: true } } },
    });
    if (!e) throw new NotFoundException({ message: 'Dividend entitlement not found', code: 'NOT_FOUND' });
    return e;
  }

  private today(): string {
    return pktDateOf(this.clock.now());
  }

  /**
   * Response shape. For estimates the tax status is re-derived from the CURRENT verified rates and filer status:
   * - NOT_CONFIGURED: WHT and net are null (the stored 0 is a placeholder for NOT NULL columns, never a rate);
   * - RECOMPUTE_REQUIRED: a verified rate now applies that differs from the one used — WHT and net are null;
   * - CONFIGURED: stored figures are the estimate.
   * PAID / RECONCILED rows report what was recorded (taxStatus AS_PAID).
   */
  view(r: EntitlementRow, tax: TaxContext, today: string) {
    const dv = r.dividend;
    const settled = (SETTLED_STATUSES as readonly string[]).includes(r.status);
    let taxStatus: 'CONFIGURED' | 'NOT_CONFIGURED' | 'RECOMPUTE_REQUIRED' | 'AS_PAID';
    let taxNote: string | null = null;
    if (settled) {
      taxStatus = 'AS_PAID';
    } else {
      const lookup: WhtLookup = lookupDividendWht(tax.rows, tax.filerStatus, whtDate(dv));
      if (lookup.status === 'NOT_CONFIGURED') {
        taxStatus = 'NOT_CONFIGURED';
        taxNote = lookup.note;
      } else if (lookup.rate.toFixed(RATE_DP) === dec(r.whtRate).toFixed(RATE_DP)) {
        taxStatus = 'CONFIGURED';
      } else {
        taxStatus = 'RECOMPUTE_REQUIRED';
        taxNote = 'A different verified WHT rate now applies; recompute entitlements.';
      }
    }
    const showTax = taxStatus === 'CONFIGURED' || taxStatus === 'AS_PAID';
    return {
      id: r.id,
      dividendId: r.dividendId,
      portfolioId: r.portfolioId,
      symbol: dv.stock.symbol,
      bookClosureFrom: iso(dv.bookClosureFrom),
      bookClosureTo: isoOrNull(dv.bookClosureTo),
      paymentDate: isoOrNull(dv.paymentDate),
      dividendPerShare: dv.dividendPerShare.toString(),
      sharesEligible: r.sharesEligible.toString(),
      grossAmount: m4(dec(r.grossAmount)),
      whtRate: showTax ? dec(r.whtRate).toFixed(RATE_DP) : null,
      whtAmount: showTax ? m4(dec(r.whtAmount)) : null,
      zakatAmount: m4(dec(r.zakatAmount)),
      netAmount: showTax ? m4(dec(r.netAmount)) : null,
      /** gross − zakat, before any withholding — what is known for sure when WHT is not configured. */
      netBeforeWht: m4(dec(r.grossAmount).minus(dec(r.zakatAmount))),
      taxStatus,
      taxNote,
      status: r.status,
      source: r.source,
      /** Book closure has not started yet: holdings may still change; recompute after it. */
      provisional: !settled && iso(dv.bookClosureFrom) > today,
      paidAt: isoOrNull(r.paidAt),
      cashMovementId: r.cashMovementId,
      reconciledAt: r.reconciledAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}

/** WHT is assessed on the payment date (docs/06 §6); before one is declared, the book-closure start is used. */
function whtDate(dv: { paymentDate: Date | null; bookClosureFrom: Date }): string {
  return iso(dv.paymentDate ?? dv.bookClosureFrom);
}

function sameEstimate(
  e: EntitlementRow,
  data: {
    sharesEligible: string;
    grossAmount: string;
    whtRate: string;
    whtAmount: string;
    zakatAmount: string;
    netAmount: string;
  },
): boolean {
  return (
    e.status === 'ENTITLED' &&
    e.source === 'ESTIMATED' &&
    dec(e.sharesEligible).eq(data.sharesEligible) &&
    dec(e.grossAmount).eq(data.grossAmount) &&
    dec(e.whtRate).eq(data.whtRate) &&
    dec(e.whtAmount).eq(data.whtAmount) &&
    dec(e.zakatAmount).eq(data.zakatAmount) &&
    dec(e.netAmount).eq(data.netAmount)
  );
}

function changedConcurrently() {
  return new ConflictException({
    message: 'The entitlement changed concurrently; reload and retry',
    code: 'CONCURRENT_MODIFICATION',
  });
}
