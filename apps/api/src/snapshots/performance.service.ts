import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type Decimal,
  marketValue,
  roundMoney,
  simpleReturn,
  sum,
  xirr,
  XirrError,
  ZERO,
} from '@ktrade/finance-core';
import { type DataSource, weakestSource } from '@ktrade/shared';
import { CLOCK, type Clock } from '../common/clock.js';
import { pktDateOf } from '../market-data/calendar.js';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  fractionToPct,
  type PerformanceRange,
  performanceFromSnapshots,
  rangeBaseDate,
  type SnapshotPoint,
  toDec,
} from './snapshot-math.js';

const iso = (x: Date) => x.toISOString().slice(0, 10);
const m4 = (x: Decimal) => roundMoney(x).toFixed(4);

interface StoredPoint extends SnapshotPoint {
  priceSource: DataSource;
}

export interface LiveValuation {
  accountValue: Decimal;
  netContributions: Decimal;
  source: DataSource;
}

/** How a "today" figure was obtained — always shown to the user. */
export type TodayBasis = 'SNAPSHOT' | 'LIVE_VS_PREVIOUS_SNAPSHOT';

export interface TodayPnl {
  pnl: Decimal;
  /** pnl / V_prevClose (fraction); null when V_prevClose ≤ 0. */
  ret: Decimal | null;
  basis: TodayBasis;
  /** Trading date the figure is for. */
  tradingDate: string;
  /** The close it is measured against. */
  previousCloseDate: string | null;
  source: DataSource;
}

/**
 * Performance analytics over `portfolio_snapshots` (docs/06 §5) and the snapshot-backed dashboard figures.
 * TWR / drawdown / monthly table come from finance-core via `performanceFromSnapshots`.
 */
@Injectable()
export class PerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: MarketCalendarService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async owned(userId: string, portfolioId: string) {
    const p = await this.prisma.portfolio.findFirst({ where: { id: portfolioId, userId, archivedAt: null } });
    if (!p) throw new NotFoundException({ message: 'Portfolio not found', code: 'NOT_FOUND' });
    return p;
  }

  private async points(portfolioId: string, upTo?: string): Promise<StoredPoint[]> {
    const rows = await this.prisma.portfolioSnapshot.findMany({
      where: { portfolioId, ...(upTo ? { date: { lte: new Date(`${upTo}T00:00:00Z`) } } : {}) },
      orderBy: { date: 'asc' },
      select: { date: true, totalValue: true, netContributions: true, dailyPnl: true, priceSource: true },
    });
    return rows.map((r) => ({
      date: iso(r.date),
      totalValue: toDec(r.totalValue),
      netContributions: toDec(r.netContributions),
      dailyPnl: toDec(r.dailyPnl),
      priceSource: r.priceSource,
    }));
  }

  /** GET /portfolios/:id/performance */
  async performance(userId: string, portfolioId: string, range: PerformanceRange) {
    const p = await this.owned(userId, portfolioId);
    const ledgerSource: DataSource = p.kind === 'PAPER' ? 'SIMULATED' : 'USER_REPORTED';
    const all = await this.points(portfolioId);
    if (all.length === 0) {
      return {
        portfolioId,
        range,
        from: null,
        to: null,
        source: ledgerSource,
        note: 'No snapshots yet — run POST /portfolios/:id/snapshots/backfill',
        series: [],
        twr: { valuePct: null, method: 'TWR', source: ledgerSource },
        maxDrawdown: null,
        monthly: [],
        simpleReturn: { valuePct: null, method: 'SIMPLE', since: null, source: ledgerSource },
        xirr: { valuePct: null, method: 'XIRR', since: null, source: ledgerSource },
      };
    }
    const end = all[all.length - 1]!;
    const baseDate = rangeBaseDate(range, end.date);
    const inRange = baseDate === null ? all : all.filter((x) => x.date > baseDate);
    const base = baseDate === null ? null : ([...all].reverse().find((x) => x.date <= baseDate) ?? null);
    const perf = performanceFromSnapshots(base, inRange);
    const source = weakestSource(
      [...(base ? [base] : []), ...inRange].map((x) => x.priceSource).concat(ledgerSource),
    );
    const lifetimeSource = weakestSource(all.map((x) => x.priceSource).concat(ledgerSource));

    return {
      portfolioId,
      range,
      from: inRange[0]?.date ?? null,
      to: end.date,
      source,
      methodology:
        'Snapshots value the portfolio at each PSX close; external flows (deposits − withdrawals) are assumed at end of day. ' +
        'TWR links daily returns from the first snapshot with capital; drawdown is measured on the TWR index.',
      series: perf.series.map((x) => ({
        date: x.date,
        totalValue: m4(x.totalValue),
        dailyPnl: m4(x.dailyPnl),
        twrIndex: x.twrIndex ? x.twrIndex.toDecimalPlaces(10).toFixed(10) : null,
      })),
      twr: { valuePct: fractionToPct(perf.twr), method: 'TWR', baseDate: perf.twrBaseDate, source },
      maxDrawdown: perf.maxDrawdown
        ? {
            valuePct: fractionToPct(perf.maxDrawdown.value),
            peakDate: perf.maxDrawdown.peakDate,
            troughDate: perf.maxDrawdown.troughDate,
            recoveryDate: perf.maxDrawdown.recoveryDate,
            source,
          }
        : null,
      monthly: perf.monthly.map((m) => ({ month: m.month, pnl: m4(m.pnl), days: m.days, source })),
      simpleReturn: {
        valuePct: fractionToPct(simpleReturn(end.totalValue, end.netContributions)),
        method: 'SIMPLE',
        since: 'INCEPTION',
        asOf: end.date,
        source: lifetimeSource,
      },
      xirr: {
        valuePct: fractionToPct(await this.xirrFor(portfolioId, end)),
        method: 'XIRR',
        since: 'INCEPTION',
        asOf: end.date,
        source: lifetimeSource,
      },
    };
  }

  /** Money-weighted return over dated deposits/withdrawals + terminal value; null when not computable. */
  private async xirrFor(portfolioId: string, end: StoredPoint): Promise<Decimal | null> {
    const flows = await this.prisma.cashMovement.findMany({
      where: {
        portfolioId,
        type: { in: ['DEPOSIT', 'WITHDRAWAL'] },
        valueDate: { lte: new Date(`${end.date}T00:00:00Z`) },
      },
      select: { valueDate: true, amount: true },
    });
    // Investor's view: deposits (stored +) are outflows (−), withdrawals (stored −) inflows (+).
    const cashflows = flows.map((f) => ({ date: iso(f.valueDate), amount: toDec(f.amount).neg() }));
    cashflows.push({ date: end.date, amount: end.totalValue });
    try {
      return xirr(cashflows);
    } catch (err) {
      if (err instanceof XirrError) return null;
      throw err;
    }
  }

  /** Current account value from the holdings projection × latest quotes + ledger cash (as the dashboard does). */
  async liveValuation(portfolioId: string): Promise<LiveValuation> {
    const p = await this.prisma.portfolio.findUniqueOrThrow({
      where: { id: portfolioId },
      select: { kind: true },
    });
    const [holdings, cash, contrib] = await Promise.all([
      this.prisma.holding.findMany({
        where: { portfolioId, quantity: { gt: 0 } },
        include: { stock: { include: { quote: true } } },
      }),
      this.prisma.cashMovement.aggregate({ where: { portfolioId }, _sum: { amount: true } }),
      this.prisma.cashMovement.aggregate({
        where: { portfolioId, type: { in: ['DEPOSIT', 'WITHDRAWAL'] } },
        _sum: { amount: true },
      }),
    ]);
    const sources: DataSource[] = [p.kind === 'PAPER' ? 'SIMULATED' : 'USER_REPORTED'];
    const mvs = holdings.map((h) => {
      if (!h.stock.quote) {
        sources.push('ESTIMATED');
        return toDec(h.totalCost);
      }
      sources.push(h.stock.quote.source);
      return marketValue(toDec(h.quantity), toDec(h.stock.quote.last));
    });
    return {
      accountValue: toDec(cash._sum.amount).plus(sum(mvs)),
      netContributions: toDec(contrib._sum.amount),
      source: weakestSource(sources),
    };
  }

  /**
   * Today's P&L (docs/06 §5: V_today − V_prevClose − netExternalFlows_today).
   *  - SNAPSHOT: the last completed session has a snapshot and no newer session is under way → its stored dailyPnl.
   *  - LIVE_VS_PREVIOUS_SNAPSHOT: today's session is pending/open (or the last session has no snapshot yet) → live
   *    account value (current quotes) against the latest earlier snapshot, minus flows since it.
   * null when there is no snapshot at all.
   */
  async today(portfolioId: string, live: LiveValuation): Promise<TodayPnl | null> {
    const now = this.clock.now();
    const cal = await this.calendar.refresh();
    const todayDate = pktDateOf(now);
    const lastDone = cal.lastCompletedSession(now);
    const sessionPending = cal.isTradingDay(todayDate) && todayDate !== lastDone;
    const latest = await this.prisma.portfolioSnapshot.findFirst({
      where: { portfolioId, date: { lte: new Date(`${lastDone}T00:00:00Z`) } },
      orderBy: { date: 'desc' },
    });
    if (!latest) return null;
    const latestDate = iso(latest.date);
    if (!sessionPending && latestDate === lastDone) {
      const prev = await this.prisma.portfolioSnapshot.findFirst({
        where: { portfolioId, date: { lt: latest.date } },
        orderBy: { date: 'desc' },
        select: { date: true, totalValue: true },
      });
      const prevValue = prev ? toDec(prev.totalValue) : ZERO;
      const pnl = toDec(latest.dailyPnl);
      return {
        pnl,
        ret: prevValue.gt(0) ? pnl.div(prevValue) : null,
        basis: 'SNAPSHOT',
        tradingDate: latestDate,
        previousCloseDate: prev ? iso(prev.date) : null,
        source: weakestSource([latest.priceSource, live.source]),
      };
    }
    const prevValue = toDec(latest.totalValue);
    const flows = live.netContributions.minus(toDec(latest.netContributions));
    const pnl = live.accountValue.minus(prevValue).minus(flows);
    return {
      pnl,
      ret: prevValue.gt(0) ? pnl.div(prevValue) : null,
      basis: 'LIVE_VS_PREVIOUS_SNAPSHOT',
      tradingDate: sessionPending ? todayDate : lastDone,
      previousCloseDate: latestDate,
      source: weakestSource([latest.priceSource, live.source]),
    };
  }

  /** todayPnl / monthPnl / twrPct for the dashboard summary. */
  async dashboard(portfolio: { id: string; kind: string }, live: LiveValuation) {
    const t = await this.today(portfolio.id, live);
    if (!t) {
      const note = 'No portfolio snapshots yet — run POST /portfolios/:id/snapshots/backfill';
      return {
        todayPnl: { value: null, note },
        monthPnl: { value: null, note },
        twrPct: { value: null, method: 'TWR', note },
      };
    }
    const month = t.tradingDate.slice(0, 7);
    const points = await this.points(portfolio.id);
    const closedInMonth = points.filter(
      (x) =>
        x.date.startsWith(month) &&
        (t.basis === 'SNAPSHOT' ? x.date <= t.tradingDate : x.date <= t.previousCloseDate!),
    );
    const monthValue = sum(closedInMonth.map((x) => x.dailyPnl)).plus(t.basis === 'SNAPSHOT' ? ZERO : t.pnl);
    const twr = performanceFromSnapshots(null, points).twr;
    const lifetimeSource = weakestSource(points.map((x) => x.priceSource).concat(live.source));
    return {
      todayPnl: {
        value: m4(t.pnl),
        pct: fractionToPct(t.ret),
        basis: t.basis,
        tradingDate: t.tradingDate,
        previousCloseDate: t.previousCloseDate,
        source: t.source,
        note:
          t.basis === 'SNAPSHOT'
            ? `From the ${t.tradingDate} close snapshot`
            : `Live: current quotes vs the ${t.previousCloseDate} close snapshot, net of deposits/withdrawals since`,
      },
      monthPnl: {
        value: m4(monthValue),
        month,
        basis: t.basis === 'SNAPSHOT' ? 'SNAPSHOTS' : 'SNAPSHOTS_PLUS_LIVE_TODAY',
        sessions: closedInMonth.length + (t.basis === 'SNAPSHOT' ? 0 : 1),
        source: weakestSource(closedInMonth.map((x) => x.priceSource).concat(t.source)),
      },
      twrPct: {
        value: fractionToPct(twr),
        method: 'TWR',
        since: points[0]?.date ?? null,
        asOf: points[points.length - 1]?.date ?? null,
        basis: 'SNAPSHOTS',
        source: lifetimeSource,
      },
    };
  }
}
