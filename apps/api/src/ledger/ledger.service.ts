import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  type Decimal,
  type FeeLine,
  type LedgerEvent,
  LedgerError,
  d,
  orderLedgerEvents,
  replay,
  roundMoney,
  sum,
  ZERO,
} from '@ktrade/finance-core';
import type { DataSource, FeeComponent, OrderSide } from '@ktrade/shared';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;
const dec = (v: { toString(): string } | null | undefined): Decimal => (v === null || v === undefined ? ZERO : d(v.toString()));
const iso = (date: Date): string => date.toISOString().slice(0, 10);

export interface FeeLineInput {
  component: FeeComponent;
  amount: Decimal;
  capitalised: boolean;
  source: DataSource;
}

export interface PostTradeInput {
  portfolioId: string;
  stockId: string;
  side: OrderSide;
  quantity: Decimal;
  price: Decimal;
  tradeDate: string; // YYYY-MM-DD
  fees: readonly FeeLineInput[];
  source: DataSource;
  externalRef?: string | null;
  executionId?: string | null;
  importedStmtId?: string | null;
  notes?: string | null;
  feeScheduleId?: string | null;
}

export const feeLinesFromBreakdown = (lines: readonly FeeLine[]): FeeLineInput[] =>
  lines.map((l) => ({ component: l.component, amount: l.amount, capitalised: l.capitalised, source: 'ESTIMATED' }));

/**
 * The only writer of trades to the ledger (docs/05 §5, docs/06).
 *
 * Every posting runs inside the caller's DB transaction and:
 *  1. takes a transaction-scoped advisory lock per (portfolio, symbol) — serialises concurrent postings;
 *  2. inserts the transaction, its fee lines and the settling cash movement;
 *  3. REPLAYS the symbol's full ledger through finance-core and rewrites the holding + lot projections and
 *     each transaction's cost-basis audit columns.
 * Replaying (instead of incrementally patching) makes back-dated postings and corrections exact and makes
 * projection drift impossible. Per-symbol ledgers are small, so the cost is negligible.
 */
@Injectable()
export class LedgerService {
  async postTrade(tx: Tx, input: PostTradeInput): Promise<{ transactionId: string }> {
    if (!input.quantity.isInteger() || input.quantity.lte(0)) {
      throw new UnprocessableEntityException({ message: 'Quantity must be a positive whole number of shares', code: 'INVALID_QUANTITY' });
    }
    if (input.price.lte(0)) throw new UnprocessableEntityException({ message: 'Price must be positive', code: 'INVALID_PRICE' });
    await this.lock(tx, input.portfolioId, input.stockId);

    const gross = roundMoney(input.quantity.times(input.price));
    const capitalised = sum(input.fees.filter((f) => f.capitalised).map((f) => f.amount));
    const taxes = sum(input.fees.filter((f) => !f.capitalised).map((f) => f.amount));
    // Signed cash impact: buys pay gross + all fees/taxes; sells receive gross − fees − taxes.
    const net = input.side === 'BUY' ? gross.plus(capitalised).plus(taxes).neg() : gross.minus(capitalised).minus(taxes);

    const created = await tx.transaction.create({
      data: {
        portfolioId: input.portfolioId,
        stockId: input.stockId,
        type: input.side,
        tradeDate: new Date(`${input.tradeDate}T00:00:00Z`),
        quantity: input.quantity.toFixed(),
        price: input.price.toFixed(),
        grossAmount: gross.toFixed(4),
        feesTotal: roundMoney(capitalised).toFixed(4),
        taxesTotal: roundMoney(taxes).toFixed(4),
        netAmount: roundMoney(net).toFixed(4),
        source: input.source,
        externalRef: input.externalRef ?? null,
        executionId: input.executionId ?? null,
        importedStmtId: input.importedStmtId ?? null,
        notes: input.notes ?? null,
        fees: {
          create: input.fees
            .filter((f) => !f.amount.isZero() || f.source === 'ESTIMATED')
            .map((f) => ({ component: f.component, amount: f.amount.toFixed(4), source: f.source, scheduleId: input.feeScheduleId ?? null })),
        },
      },
    });

    await tx.cashMovement.create({
      data: {
        portfolioId: input.portfolioId,
        type: input.side === 'BUY' ? 'TRADE_DEBIT' : 'TRADE_CREDIT',
        amount: roundMoney(net).toFixed(4),
        valueDate: new Date(`${input.tradeDate}T00:00:00Z`),
        description: `${input.side} ${input.quantity.toFixed()} @ ${input.price.toFixed()}`,
        source: input.source,
        transactionId: created.id,
      },
    });

    await this.rebuildSymbol(tx, input.portfolioId, input.stockId);
    return { transactionId: created.id };
  }

  /** Recompute holding, lots and per-transaction cost-basis columns for one symbol from the ledger. */
  async rebuildSymbol(tx: Tx, portfolioId: string, stockId: string): Promise<void> {
    const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: portfolioId }, select: { costBasisMethod: true } });
    const rows = await tx.transaction.findMany({
      // Reversed originals and their reversal entries cancel out and are both excluded.
      where: { portfolioId, stockId, reversedById: null, reverses: { is: null } },
      orderBy: [{ tradeDate: 'asc' }, { createdAt: 'asc' }],
      include: { corporateAction: true },
    });

    const events: LedgerEvent[] = rows.map((r, i) => this.toEvent(r, i));
    let result;
    try {
      result = replay(orderLedgerEvents(events), portfolio.costBasisMethod);
    } catch (err) {
      if (err instanceof LedgerError) {
        throw new ConflictException({ message: err.message, code: err.code === 'OVERSELL' ? 'INSUFFICIENT_HOLDINGS' : `LEDGER_${err.code}` });
      }
      throw err;
    }

    for (const r of result.results) {
      await tx.transaction.update({
        where: { id: r.eventId },
        data: {
          avgCostBefore: r.avgCostBefore.toFixed(6),
          avgCostAfter: r.avgCostAfter.toFixed(6),
          realizedPnl: r.realizedPnl === null ? null : roundMoney(r.realizedPnl).toFixed(4),
        },
      });
    }

    const s = result.state;
    await tx.holding.upsert({
      where: { portfolioId_stockId: { portfolioId, stockId } },
      create: {
        portfolioId,
        stockId,
        quantity: s.quantity.toFixed(),
        avgCost: s.avgCost.toFixed(6),
        totalCost: s.totalCost.toFixed(4),
        realizedPnl: roundMoney(s.realizedPnl).toFixed(4),
        firstBuyAt: s.firstAcquiredDate ? new Date(`${s.firstAcquiredDate}T00:00:00Z`) : null,
        lastTxnAt: s.lastEventDate ? new Date(`${s.lastEventDate}T00:00:00Z`) : null,
      },
      update: {
        quantity: s.quantity.toFixed(),
        avgCost: s.avgCost.toFixed(6),
        totalCost: s.totalCost.toFixed(4),
        realizedPnl: roundMoney(s.realizedPnl).toFixed(4),
        firstBuyAt: s.firstAcquiredDate ? new Date(`${s.firstAcquiredDate}T00:00:00Z`) : null,
        lastTxnAt: s.lastEventDate ? new Date(`${s.lastEventDate}T00:00:00Z`) : null,
      },
    });

    await tx.holdingLot.deleteMany({ where: { portfolioId, stockId } });
    if (s.lots.length > 0) {
      await tx.holdingLot.createMany({
        data: s.lots.map((l) => ({
          portfolioId,
          stockId,
          openTransactionId: l.openEventId,
          openDate: new Date(`${l.holdingPeriodStart}T00:00:00Z`),
          originalQty: l.originalQty.toFixed(),
          remainingQty: l.remainingQty.toFixed(),
          unitCost: l.unitCost.toFixed(6),
          closedAt: l.remainingQty.isZero() ? new Date() : null,
        })),
      });
    }
  }

  /** Ledger cash balance = Σ cash movements (docs/06 §5). */
  async cashBalance(db: Tx, portfolioId: string): Promise<Decimal> {
    const agg = await db.cashMovement.aggregate({ where: { portfolioId }, _sum: { amount: true } });
    return dec(agg._sum.amount);
  }

  private async lock(tx: Tx, portfolioId: string, stockId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${portfolioId}:${stockId}`}, 0))`;
  }

  private toEvent(
    r: Prisma.TransactionGetPayload<{ include: { corporateAction: true } }>,
    sequence: number,
  ): LedgerEvent {
    const base = { id: r.id, date: iso(r.tradeDate), sequence };
    switch (r.type) {
      case 'BUY':
      case 'RIGHTS_SUBSCRIPTION':
        return { ...base, type: r.type, quantity: dec(r.quantity), price: dec(r.price), fees: dec(r.feesTotal) };
      case 'SELL':
        return { ...base, type: 'SELL', quantity: dec(r.quantity), price: dec(r.price), fees: dec(r.feesTotal) };
      case 'TRANSFER_IN':
        return { ...base, type: 'TRANSFER_IN', quantity: dec(r.quantity), totalCost: dec(r.grossAmount) };
      case 'TRANSFER_OUT':
        return { ...base, type: 'TRANSFER_OUT', quantity: dec(r.quantity) };
      case 'BONUS_IN':
      case 'SPLIT_ADJUSTMENT': {
        const ca = r.corporateAction;
        if (!ca?.ratioNumerator || !ca.ratioDenominator) {
          throw new ConflictException({ message: `Corporate-action transaction ${r.id} lacks its ratio`, code: 'LEDGER_INVALID_RATIO' });
        }
        const ratio = { ratioNew: dec(ca.ratioNumerator), ratioOld: dec(ca.ratioDenominator) };
        if (r.type === 'BONUS_IN') return { ...base, type: 'BONUS', ...ratio };
        return { ...base, type: ca.type === 'REVERSE_SPLIT' ? 'REVERSE_SPLIT' : 'SPLIT', ...ratio };
      }
    }
  }
}
