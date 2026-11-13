import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type Decimal,
  LedgerError,
  marketValue,
  orderLedgerEvents,
  replay,
  roundMoney,
  sum,
  ZERO,
} from '@ktrade/finance-core';
import { type DataSource, weakestSource } from '@ktrade/shared';
import { CLOCK, type Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { addDays, isIsoDate, pktInstant } from '../market-data/calendar.js';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type DayValuation, dailyFields, toDec } from './snapshot-math.js';

type TxRow = Prisma.TransactionGetPayload<{ include: { corporateAction: true } }>;

/** Upper bound on one backfill request (≈ 6 years of sessions). */
export const MAX_BACKFILL_DAYS = 1500;

export interface PortfolioValuation extends DayValuation {
  marketValue: Decimal;
  cashBalance: Decimal;
  investedCost: Decimal;
  unrealizedPnl: Decimal;
  realizedPnlCum: Decimal;
  dividendsCum: Decimal;
  feesCum: Decimal;
  taxesCum: Decimal;
  priceSource: DataSource;
  /** Symbols held that day with no D1 close on/before it (valued at cost, ESTIMATED). */
  unpricedSymbols: string[];
}

const utcDate = (date: string) => new Date(`${date}T00:00:00Z`);
const m4 = (x: Decimal) => roundMoney(x).toFixed(4);

/**
 * Portfolio snapshots at the CLOSE of PSX trading dates (docs/06 §5, §7).
 *
 * Holdings as of a date are replayed from the ledger with exactly the same row → event mapping and the same
 * finance-core `replay(orderLedgerEvents(...))` as `LedgerService.rebuildSymbol` (only `tradeDate ≤ date`),
 * priced with the D1 close from `stock_prices` on/before that date. Snapshots are a pure function of the ledger
 * and stored prices, so (re)building is idempotent (upsert on portfolioId+date).
 */
@Injectable()
export class SnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly calendar: MarketCalendarService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Value a portfolio at the close of `date` (no writes). */
  async valuation(portfolioId: string, date: string): Promise<PortfolioValuation> {
    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: portfolioId },
      select: { kind: true, costBasisMethod: true },
    });
    if (!portfolio) throw new NotFoundException({ message: 'Portfolio not found', code: 'NOT_FOUND' });
    const asOf = utcDate(date);
    const ledgerSource: DataSource = portfolio.kind === 'PAPER' ? 'SIMULATED' : 'USER_REPORTED';

    const [rows, cashAgg, contribAgg, feeAgg, divAgg] = await Promise.all([
      // Same filter and order as LedgerService.rebuildSymbol, cut at the snapshot date.
      this.prisma.transaction.findMany({
        where: { portfolioId, tradeDate: { lte: asOf }, reversedById: null, reverses: { is: null } },
        orderBy: [{ tradeDate: 'asc' }, { createdAt: 'asc' }],
        include: { corporateAction: true },
      }),
      this.prisma.cashMovement.aggregate({
        where: { portfolioId, valueDate: { lte: asOf } },
        _sum: { amount: true },
      }),
      this.prisma.cashMovement.aggregate({
        where: { portfolioId, valueDate: { lte: asOf }, type: { in: ['DEPOSIT', 'WITHDRAWAL'] } },
        _sum: { amount: true },
      }),
      // Same basis as the dashboard summary's fees & taxes.
      this.prisma.transaction.aggregate({
        where: { portfolioId, tradeDate: { lte: asOf }, reversedById: null },
        _sum: { feesTotal: true, taxesTotal: true },
      }),
      this.prisma.dividendEntitlement.aggregate({
        where: { portfolioId, status: { in: ['PAID', 'RECONCILED'] }, paidAt: { lte: asOf } },
        _sum: { netAmount: true },
      }),
    ]);

    const byStock = new Map<string, TxRow[]>();
    for (const r of rows) byStock.set(r.stockId, [...(byStock.get(r.stockId) ?? []), r]);

    const nextDayStart = pktInstant(addDays(date, 1), 0); // D1 bars are stamped at session open of their date
    let mv = ZERO;
    let invested = ZERO;
    let unrealized = ZERO;
    const realized: Decimal[] = [];
    const sources: DataSource[] = [];
    const unpriced: string[] = [];
    for (const [stockId, stockRows] of byStock) {
      const state = this.replaySymbol(stockRows, portfolio.costBasisMethod);
      realized.push(roundMoney(state.realizedPnl));
      if (!state.quantity.gt(0)) continue;
      invested = invested.plus(state.totalCost);
      const bar = await this.prisma.stockPrice.findFirst({
        where: { stockId, interval: 'D1', isAdjusted: false, ts: { lt: nextDayStart } },
        orderBy: { ts: 'desc' },
        select: { close: true, source: true },
      });
      if (bar) {
        const value = marketValue(state.quantity, toDec(bar.close));
        mv = mv.plus(value);
        unrealized = unrealized.plus(value.minus(state.totalCost));
        sources.push(bar.source);
      } else {
        // No close yet: carry at cost (no unrealized P&L) and say so.
        mv = mv.plus(state.totalCost);
        sources.push('ESTIMATED');
        const stock = await this.prisma.stock.findUnique({
          where: { id: stockId },
          select: { symbol: true },
        });
        unpriced.push(stock?.symbol ?? stockId);
      }
    }

    const cash = toDec(cashAgg._sum.amount);
    return {
      date,
      marketValue: roundMoney(mv),
      cashBalance: roundMoney(cash),
      totalValue: roundMoney(cash.plus(mv)),
      netContributions: roundMoney(toDec(contribAgg._sum.amount)),
      investedCost: roundMoney(invested),
      unrealizedPnl: roundMoney(unrealized),
      realizedPnlCum: sum(realized),
      dividendsCum: roundMoney(toDec(divAgg._sum.netAmount)),
      feesCum: roundMoney(toDec(feeAgg._sum.feesTotal)),
      taxesCum: roundMoney(toDec(feeAgg._sum.taxesTotal)),
      priceSource: sources.length ? weakestSource(sources) : ledgerSource,
      unpricedSymbols: unpriced.sort(),
    };
  }

  /** Build and upsert the snapshot for one trading date. V_{t−1} is the previous trading day's close. */
  async build(portfolioId: string, date: string) {
    if (!isIsoDate(date)) throw new BadRequestException({ message: 'Invalid date', code: 'INVALID_DATE' });
    const cal = await this.calendar.refresh();
    if (!cal.isTradingDay(date)) {
      throw new BadRequestException({
        message: `${date} is not a PSX trading day`,
        code: 'NOT_A_TRADING_DAY',
      });
    }
    const cur = await this.valuation(portfolioId, date);
    const prevDate = cal.previousTradingDay(date);
    const prevRow = await this.prisma.portfolioSnapshot.findUnique({
      where: { portfolioId_date: { portfolioId, date: utcDate(prevDate) } },
      select: { totalValue: true, netContributions: true },
    });
    const prev: DayValuation = prevRow
      ? {
          date: prevDate,
          totalValue: toDec(prevRow.totalValue),
          netContributions: toDec(prevRow.netContributions),
        }
      : await this.valuation(portfolioId, prevDate);
    const f = dailyFields(prev, cur);

    const data = {
      marketValue: m4(cur.marketValue),
      cashBalance: m4(cur.cashBalance),
      totalValue: m4(cur.totalValue),
      netContributions: m4(cur.netContributions),
      investedCost: m4(cur.investedCost),
      unrealizedPnl: m4(cur.unrealizedPnl),
      realizedPnlCum: m4(cur.realizedPnlCum),
      dividendsCum: m4(cur.dividendsCum),
      feesCum: m4(cur.feesCum),
      taxesCum: m4(cur.taxesCum),
      dailyPnl: m4(f.dailyPnl),
      // NOT NULL column: an undefined return (V_{t−1} = 0) is stored as 0; TWR is recomputed, never read from here.
      dailyReturn: (f.dailyReturn ?? ZERO).toDecimalPlaces(10).toFixed(10),
      priceSource: cur.priceSource,
    };
    const row = await this.prisma.portfolioSnapshot.upsert({
      where: { portfolioId_date: { portfolioId, date: utcDate(date) } },
      create: { portfolioId, date: utcDate(date), ...data },
      update: data,
    });
    return {
      ...snapshotView(row),
      dailyReturnDefined: f.dailyReturn !== null,
      unpricedSymbols: cur.unpricedSymbols,
    };
  }

  /**
   * (Re)build snapshots for every PSX trading day in [from, to], oldest first. Idempotent.
   * Defaults: from = first ledger/cash date, to = last completed session. `to` is clamped to the last completed
   * session — a session that has not closed has no close to value at.
   */
  async backfill(portfolioId: string, from?: string, to?: string) {
    const cal = await this.calendar.refresh();
    const lastDone = cal.lastCompletedSession(this.clock.now());
    const end = to && to < lastDone ? to : lastDone;
    const start = from ?? (await this.firstActivityDate(portfolioId)) ?? end;
    if (start > end) {
      throw new BadRequestException({
        message: `Nothing to backfill: from ${start} is after ${end} (last completed session)`,
        code: 'INVALID_RANGE',
      });
    }
    const days = cal.tradingDays(start, end);
    if (days.length > MAX_BACKFILL_DAYS) {
      throw new BadRequestException({
        message: `Range too large: at most ${MAX_BACKFILL_DAYS} trading days per backfill`,
        code: 'RANGE_TOO_LARGE',
      });
    }
    let unpriced = new Set<string>();
    for (const day of days) {
      const s = await this.build(portfolioId, day);
      unpriced = new Set([...unpriced, ...s.unpricedSymbols]);
    }
    return {
      portfolioId,
      from: start,
      to: end,
      tradingDays: days.length,
      unpricedSymbols: [...unpriced].sort(),
    };
  }

  private async firstActivityDate(portfolioId: string): Promise<string | null> {
    const [tx, cash] = await Promise.all([
      this.prisma.transaction.findFirst({ where: { portfolioId }, orderBy: { tradeDate: 'asc' } }),
      this.prisma.cashMovement.findFirst({ where: { portfolioId }, orderBy: { valueDate: 'asc' } }),
    ]);
    const dates = [tx?.tradeDate, cash?.valueDate]
      .filter((x): x is Date => !!x)
      .map((x) => x.toISOString().slice(0, 10));
    return dates.length ? dates.sort()[0]! : null;
  }

  private replaySymbol(rows: readonly TxRow[], method: Parameters<typeof replay>[1]) {
    // Reuse LedgerService's own row → LedgerEvent mapping so snapshots and projections can never disagree.
    try {
      return replay(orderLedgerEvents(rows.map((r, i) => this.ledger.toEvent(r, i))), method).state;
    } catch (err) {
      if (err instanceof LedgerError) {
        throw new ConflictException({
          message: err.message,
          code: err.code === 'OVERSELL' ? 'INSUFFICIENT_HOLDINGS' : `LEDGER_${err.code}`,
          eventId: err.eventId,
        });
      }
      throw err;
    }
  }
}

export function snapshotView(r: {
  date: Date;
  marketValue: { toString(): string };
  cashBalance: { toString(): string };
  totalValue: { toString(): string };
  netContributions: { toString(): string };
  investedCost: { toString(): string };
  unrealizedPnl: { toString(): string };
  realizedPnlCum: { toString(): string };
  dividendsCum: { toString(): string };
  feesCum: { toString(): string };
  taxesCum: { toString(): string };
  dailyPnl: { toString(): string };
  dailyReturn: { toString(): string };
  priceSource: DataSource;
}) {
  return {
    date: r.date.toISOString().slice(0, 10),
    marketValue: m4(toDec(r.marketValue)),
    cashBalance: m4(toDec(r.cashBalance)),
    totalValue: m4(toDec(r.totalValue)),
    netContributions: m4(toDec(r.netContributions)),
    investedCost: m4(toDec(r.investedCost)),
    unrealizedPnl: m4(toDec(r.unrealizedPnl)),
    realizedPnlCum: m4(toDec(r.realizedPnlCum)),
    dividendsCum: m4(toDec(r.dividendsCum)),
    feesCum: m4(toDec(r.feesCum)),
    taxesCum: m4(toDec(r.taxesCum)),
    dailyPnl: m4(toDec(r.dailyPnl)),
    dailyReturn: toDec(r.dailyReturn).toFixed(10),
    priceSource: r.priceSource,
  };
}
