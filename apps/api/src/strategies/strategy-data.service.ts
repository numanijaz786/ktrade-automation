import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { type BacktestFeeFn, computeTradeFees, d, type OhlcvBar } from '@ktrade/finance-core';
import { type DataSource, weakestSource } from '@ktrade/shared';
import { CLOCK, type Clock } from '../common/clock.js';
import { SESSION_CLOSE_MIN, pktParts, pktTradeDate } from '../common/market-hours.js';
import { FeeService } from '../ledger/fee.service.js';
import { addDays, pktInstant } from '../market-data/calendar.js';
import { UnknownSymbolError } from '../market-data/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Hard caps for synchronous backtests (D1). */
export const MAX_BACKTEST_BARS = 5_000;
export const MAX_BACKTEST_YEARS = 10;
/** History fed to a live/paper evaluation (indicators such as EMA depend on it; fixed so results are reproducible). */
export const EVALUATION_LOOKBACK_BARS = 1_000;

export interface LoadedBars {
  bars: OhlcvBar[];
  /** Per-bar provenance, index-aligned with `bars`. */
  sources: DataSource[];
  /** Weakest provenance of the bars used (SIMULATED if any bar is simulated); null when empty. */
  dataSource: DataSource | null;
}

export interface FeeModel {
  fee: BacktestFeeFn;
  scheduleId: string | null;
  scheduleName: string;
  effectiveFrom: string;
}

const toBar = (r: {
  ts: Date;
  open: { toFixed(): string };
  high: { toFixed(): string };
  low: { toFixed(): string };
  close: { toFixed(): string };
  volume: bigint;
}): OhlcvBar => ({
  ts: r.ts.toISOString(),
  open: d(r.open.toFixed()),
  high: d(r.high.toFixed()),
  low: d(r.low.toFixed()),
  close: d(r.close.toFixed()),
  volume: d(r.volume),
});

/**
 * Market data and cost model for the strategy engine. D1 bars come from `stock_prices` (unadjusted), each with
 * its own provenance; the fee model is the real ledger fee engine (FeeService → finance-core computeTradeFees).
 */
@Injectable()
export class StrategyDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fees: FeeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async stock(symbol: string) {
    const s = await this.prisma.stock.findUnique({ where: { symbol } });
    if (!s) throw new UnknownSymbolError(symbol);
    return s;
  }

  private shape(rows: (Parameters<typeof toBar>[0] & { source: DataSource })[]): LoadedBars {
    const sources = rows.map((r) => r.source);
    return {
      bars: rows.map(toBar),
      sources,
      dataSource: sources.length ? weakestSource([...new Set(sources)]) : null,
    };
  }

  /** D1 bars whose PKT trading date lies in [from, to] (inclusive). Rejects ranges over the caps. */
  async range(stockId: string, from: string, to: string): Promise<LoadedBars> {
    if (addDays(from, 366 * MAX_BACKTEST_YEARS) < to) {
      throw new UnprocessableEntityException({
        message: `Range too large: at most ${MAX_BACKTEST_YEARS} years of daily bars`,
        code: 'RANGE_TOO_LARGE',
      });
    }
    const rows = await this.prisma.stockPrice.findMany({
      where: {
        stockId,
        interval: 'D1',
        isAdjusted: false,
        ts: { gte: pktInstant(from, 0), lt: pktInstant(addDays(to, 1), 0) },
      },
      orderBy: { ts: 'asc' },
      take: MAX_BACKTEST_BARS + 1,
    });
    if (rows.length > MAX_BACKTEST_BARS) {
      throw new UnprocessableEntityException({
        message: `Range too large: more than ${MAX_BACKTEST_BARS} bars`,
        code: 'RANGE_TOO_LARGE',
      });
    }
    return this.shape(rows);
  }

  /**
   * The latest `limit` COMPLETED daily bars as of the clock: today's bar only counts once the PSX session
   * has closed (15:30 PKT), so an evaluation never acts on a still-forming bar.
   */
  async latestCompleted(stockId: string, limit: number): Promise<LoadedBars> {
    const now = this.clock.now();
    const p = pktParts(now);
    const cutoffDate = p.minutes >= SESSION_CLOSE_MIN ? addDays(p.date, 1) : p.date;
    const rows = await this.prisma.stockPrice.findMany({
      where: { stockId, interval: 'D1', isAdjusted: false, ts: { lt: pktInstant(cutoffDate, 0) } },
      orderBy: { ts: 'desc' },
      take: limit,
    });
    return this.shape(rows.reverse());
  }

  /**
   * Fee model with the schedule effective on `date` (falls back to today's schedule when none was effective
   * then, e.g. history older than the configured schedule). Same engine and schedule as the ledger.
   */
  async feeModel(date: string): Promise<FeeModel> {
    let chosen;
    try {
      chosen = await this.fees.scheduleFor(date);
    } catch {
      chosen = await this.fees.scheduleFor(pktTradeDate(this.clock.now()));
    }
    const { spec, scheduleId } = chosen;
    return {
      fee: (side, qty, price) => computeTradeFees(spec, { side, quantity: qty, price }).total,
      scheduleId,
      scheduleName: spec.name ?? 'KTrade published schedule',
      effectiveFrom: spec.effectiveFrom,
    };
  }
}
