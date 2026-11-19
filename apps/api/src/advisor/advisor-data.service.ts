import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  d,
  type Decimal,
  type DividendRecord,
  type EvaluateStockInput,
  type FinancialStatement,
  type FundamentalsBundle,
  type FundamentalsContext,
  type FeeScheduleSpec,
  type PeerInput,
  type PortfolioContext,
  type ResearchBar,
  type ResearchDataSource,
  type RiskConfig,
  pbRatio,
  peRatio,
  ZERO,
  HUNDRED,
} from '@ktrade/finance-core';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { FeeService } from '../ledger/fee.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { type PsxCalendar, pktDateOf } from '../market-data/calendar.js';
import { fromDb } from '../market-data/decimal-format.js';
import { MarketCalendarService } from '../market-data/market-calendar.service.js';
import { isStale, DEFAULT_FRESHNESS_MINUTES } from '../market-data/staleness.js';
import { PortfolioService, DEFAULT_PAPER_LIMITS } from '../portfolio/portfolio.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DEFAULT_RISK_PER_TRADE_PCT } from './advisor.schemas.js';

/** Calendar days of daily bars loaded per stock (covers the longest horizon's 200-bar need with margin). */
const BAR_LOOKBACK_DAYS = 900;
/** Sector cap used when the risk limits carry none (RiskLimit has no per-sector field). A configured policy default, not market data. */
export const DEFAULT_MAX_SECTOR_PCT = '40';
const DAY_MS = 86_400_000;
const CURRENCY_FALLBACK = 'PKR';

const SOURCE_RANK: Readonly<Record<ResearchDataSource, number>> = {
  BROKER_CONFIRMED: 0,
  PROVIDER: 1,
  BROKER_DISPLAYED: 2,
  USER_REPORTED: 3,
  ESTIMATED: 4,
  SIMULATED: 5,
};

export interface HoldingFact {
  readonly stockId: string;
  readonly symbol: string;
  readonly name: string;
  readonly sector: string | null;
  readonly qty: Decimal;
  /** Per share, fees included (the ledger's weighted average cost). */
  readonly avgCost: Decimal;
  readonly totalCost: Decimal;
  readonly realizedPnl: Decimal;
  /** Net dividends settled (PAID / RECONCILED entitlements) for this symbol in this portfolio. */
  readonly dividendsReceived: Decimal;
}

export interface QuoteFact {
  readonly last: Decimal;
  readonly source: ResearchDataSource;
  readonly asOf: string;
  readonly delayMinutes: number;
  readonly stale: boolean;
}

export interface StockBundle {
  readonly stock: {
    readonly id: string;
    readonly symbol: string;
    readonly name: string;
    readonly sector: string | null;
  };
  /** Completed D1 bars at or before the decision time, ascending, each with its own provenance. */
  readonly bars: readonly ResearchBar[];
  readonly lastBar: ResearchBar | null;
  /** PKT date of the last completed bar = the decision bar. */
  readonly asOfBar: string | null;
  /** null when the stock has no stored bars at all. */
  readonly input: Omit<EvaluateStockInput, 'horizon'> | null;
  readonly quote: QuoteFact | null;
  /** Price older than its freshness limit (same rule the engine applies). */
  readonly stale: boolean;
  readonly hasFundamentals: boolean;
  readonly fundamentals: FundamentalsBundle | null;
  readonly dividends: readonly DividendRecord[];
  readonly holding: HoldingFact | null;
}

export interface AdvisorContext {
  readonly now: Date;
  readonly today: string;
  readonly calendar: PsxCalendar;
  readonly portfolio: { id: string; name: string; kind: string; baseCurrency: string };
  readonly cash: Decimal;
  /** Cash + priced holdings (latest completed bar close). */
  readonly equity: Decimal;
  readonly marketValue: Decimal;
  readonly risk: RiskConfig;
  readonly riskPerTradePct: Decimal;
  readonly maxPositionPct: Decimal;
  readonly maxSectorPct: Decimal;
  readonly feeSchedule: FeeScheduleSpec;
  /** Sector -> % of equity. */
  readonly sectorExposure: ReadonlyMap<string, Decimal>;
  /** Holdings with no stored price at all (excluded from equity). */
  readonly unpricedHoldings: readonly string[];
  readonly bundles: readonly StockBundle[];
  readonly holdings: readonly HoldingFact[];
}

export interface AdvisorSettings {
  readonly riskPerTradePct: string;
  readonly isDefault: boolean;
}

type Row = Awaited<ReturnType<PrismaService['companyFinancial']['findMany']>>[number];

const iso = (x: Date): string => x.toISOString();
const dayOf = (x: Date): string => x.toISOString().slice(0, 10);

function toStatement(r: Row): FinancialStatement {
  const dec = (v: { toFixed(): string } | null): Decimal | null => (v === null ? null : fromDb(v));
  const end = dayOf(r.periodEnd);
  return {
    period: `${r.periodType} ${end}`,
    periodType: r.periodType,
    periodEnd: end,
    publishedAt: iso(r.publishedAt),
    currency: r.currency,
    source: r.source,
    document: r.sourceRef,
    revenue: dec(r.revenue),
    grossProfit: dec(r.grossProfit),
    operatingIncome: dec(r.operatingProfit),
    netIncome: dec(r.netProfit),
    eps: dec(r.eps),
    totalAssets: dec(r.totalAssets),
    totalEquity: dec(r.totalEquity),
    totalDebt: dec(r.totalDebt),
    operatingCashFlow: dec(r.operatingCashFlow),
    capitalExpenditure: dec(r.capex),
    dividendsPerShare: dec(r.dividendPerShare),
    sharesOutstanding: dec(r.sharesOutstanding),
  };
}

/** Same period + type may exist per source: keep the most trustworthy source. */
function bestPerPeriod(rows: readonly Row[]): Row[] {
  const best = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.periodType}|${dayOf(r.periodEnd)}`;
    const cur = best.get(k);
    if (!cur || SOURCE_RANK[r.source] < SOURCE_RANK[cur.source]) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime());
}

function shiftedEnd(end: string, years: number, months: number): number {
  const t = new Date(`${end}T00:00:00Z`);
  t.setUTCFullYear(t.getUTCFullYear() + years);
  t.setUTCMonth(t.getUTCMonth() + months);
  return t.getTime();
}

/**
 * current = the latest ANNUAL statement (an annual EPS makes P/E computable without annualising), else the latest
 * QUARTERLY one. priorYear = the same period type about one year earlier; priorQuarter = the quarter before a
 * quarterly current. Only statements actually stored (and already published) are used; nothing is filled in.
 */
export function selectStatements(rows: readonly Row[]): {
  current: FinancialStatement;
  priorYear: FinancialStatement | null;
  priorQuarter: FinancialStatement | null;
} | null {
  const best = bestPerPeriod(rows);
  const current = best.find((r) => r.periodType === 'ANNUAL') ?? best[0];
  if (!current) return null;
  const near = (target: number, tolDays: number) => (r: Row) =>
    r.periodType === current.periodType && Math.abs(r.periodEnd.getTime() - target) <= tolDays * DAY_MS;
  const py = best.find(near(shiftedEnd(dayOf(current.periodEnd), -1, 0), 20));
  const pq =
    current.periodType === 'QUARTERLY'
      ? best.find(near(shiftedEnd(dayOf(current.periodEnd), 0, -3), 20))
      : undefined;
  return {
    current: toStatement(current),
    priorYear: py ? toStatement(py) : null,
    priorQuarter: pq ? toStatement(pq) : null,
  };
}

/** Builds engine inputs from stored data only. No network calls, no estimates. */
@Injectable()
export class AdvisorDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: MarketCalendarService,
    private readonly fees: FeeService,
    private readonly ledger: LedgerService,
    private readonly portfolios: PortfolioService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── settings (user_settings.preferences.advisor) ─────────────

  async getSettings(userId: string): Promise<AdvisorSettings> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { preferences: true },
    });
    const adv = (row?.preferences as { advisor?: { riskPerTradePct?: unknown } } | null)?.advisor;
    const v = adv?.riskPerTradePct;
    return typeof v === 'string'
      ? { riskPerTradePct: v, isDefault: false }
      : { riskPerTradePct: DEFAULT_RISK_PER_TRADE_PCT, isDefault: true };
  }

  async setSettings(userId: string, riskPerTradePct: string, meta: RequestMeta): Promise<AdvisorSettings> {
    const before = await this.getSettings(userId);
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { preferences: true },
    });
    const prefs = (row?.preferences ?? {}) as Record<string, unknown>;
    const advisor = { ...((prefs.advisor ?? {}) as Record<string, unknown>), riskPerTradePct };
    const preferences = { ...prefs, advisor };
    await this.prisma.userSettings.upsert({
      where: { userId },
      create: { userId, preferences },
      update: { preferences },
    });
    await this.audit.record({
      action: 'advisor.settings_changed',
      actorType: 'USER',
      actorUserId: userId,
      entityType: 'user_settings',
      entityId: userId,
      before: { riskPerTradePct: before.riskPerTradePct },
      after: { riskPerTradePct },
      ...meta,
    });
    return { riskPerTradePct, isDefault: false };
  }

  // ───────────── context ─────────────

  /** The owner's default portfolio, else the first non-archived one. */
  async defaultPortfolioId(userId: string): Promise<string> {
    const s = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { defaultPortfolioId: true },
    });
    if (s?.defaultPortfolioId) {
      const p = await this.prisma.portfolio.findFirst({
        where: { id: s.defaultPortfolioId, userId, archivedAt: null },
      });
      if (p) return p.id;
    }
    const first = await this.prisma.portfolio.findFirst({
      where: { userId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (!first)
      throw new UnprocessableEntityException({
        message:
          'No portfolio found: create one first (the advisor sizes positions from your cash and holdings)',
        code: 'NO_PORTFOLIO',
      });
    return first.id;
  }

  async load(userId: string, portfolioId: string): Promise<AdvisorContext> {
    const now = this.clock.now();
    const cal = await this.calendar.refresh();
    const today = pktDateOf(now);
    const portfolio = await this.portfolios.owned(userId, portfolioId);
    const [limit, settings, sched, cash] = await Promise.all([
      this.prisma.riskLimit.findUnique({ where: { portfolioId } }),
      this.getSettings(userId),
      this.fees.scheduleFor(today),
      this.ledger.cashBalance(this.prisma, portfolioId),
    ]);
    const holdRows = await this.prisma.holding.findMany({
      where: { portfolioId, quantity: { gt: 0 } },
      include: { stock: true },
    });
    const ents = await this.prisma.dividendEntitlement.findMany({
      where: { portfolioId, status: { in: ['PAID', 'RECONCILED'] } },
      select: { netAmount: true, dividend: { select: { stockId: true } } },
    });
    const divByStock = new Map<string, Decimal>();
    for (const e of ents)
      divByStock.set(
        e.dividend.stockId,
        (divByStock.get(e.dividend.stockId) ?? ZERO).plus(fromDb(e.netAmount)),
      );

    const active = await this.prisma.stock.findMany({
      where: { isActive: true },
      orderBy: { symbol: 'asc' },
    });
    const stocks = [...active];
    for (const h of holdRows) if (!stocks.some((s) => s.id === h.stockId)) stocks.push(h.stock);
    const ids = stocks.map((s) => s.id);

    const since = new Date(now.getTime() - BAR_LOOKBACK_DAYS * DAY_MS);
    const [barRows, quoteRows, finRows, divRows] = await Promise.all([
      this.prisma.stockPrice.findMany({
        where: { stockId: { in: ids }, interval: 'D1', isAdjusted: false, ts: { gte: since, lte: now } },
        orderBy: [{ stockId: 'asc' }, { ts: 'asc' }],
      }),
      this.prisma.stockQuote.findMany({ where: { stockId: { in: ids } } }),
      this.prisma.companyFinancial.findMany({
        where: { stockId: { in: ids }, publishedAt: { lte: now }, source: { not: 'SIMULATED' } },
        orderBy: { periodEnd: 'desc' },
      }),
      this.prisma.dividend.findMany({
        where: { stockId: { in: ids }, bookClosureFrom: { lte: new Date(`${today}T00:00:00Z`) } },
        orderBy: { bookClosureFrom: 'asc' },
      }),
    ]);

    // Completed bars only: a bar counts once its session has closed (decision time = latest completed bar).
    const barsBy = new Map<string, ResearchBar[]>();
    for (const r of barRows) {
      if (cal.sessionClose(pktDateOf(r.ts)).getTime() > now.getTime()) continue;
      const list = barsBy.get(r.stockId) ?? [];
      list.push({
        ts: iso(r.ts),
        open: fromDb(r.open),
        high: fromDb(r.high),
        low: fromDb(r.low),
        close: fromDb(r.close),
        volume: d(r.volume.toString()),
        source: r.source,
      });
      barsBy.set(r.stockId, list);
    }
    const quoteBy = new Map(quoteRows.map((q) => [q.stockId, q]));
    const finBy = new Map<string, Row[]>();
    for (const r of finRows) finBy.set(r.stockId, [...(finBy.get(r.stockId) ?? []), r]);
    const divBy = new Map<string, DividendRecord[]>();
    for (const r of divRows)
      divBy.set(r.stockId, [
        ...(divBy.get(r.stockId) ?? []),
        // The ex-date is not stored separately; the book-closure start is the record used for dividend history.
        {
          exDate: dayOf(r.bookClosureFrom),
          amountPerShare: fromDb(r.dividendPerShare),
          currency: CURRENCY_FALLBACK,
          source: r.source,
        },
      ]);

    // Holdings valued at the latest completed bar close.
    const holdings: HoldingFact[] = holdRows.map((h) => ({
      stockId: h.stockId,
      symbol: h.stock.symbol,
      name: h.stock.name,
      sector: h.stock.sector,
      qty: fromDb(h.quantity),
      avgCost: fromDb(h.avgCost),
      totalCost: fromDb(h.totalCost),
      realizedPnl: fromDb(h.realizedPnl),
      dividendsReceived: divByStock.get(h.stockId) ?? ZERO,
    }));
    let marketValue = ZERO;
    const sectorMv = new Map<string, Decimal>();
    const unpriced: string[] = [];
    for (const h of holdings) {
      const last = barsBy.get(h.stockId)?.at(-1);
      if (!last) {
        unpriced.push(h.symbol);
        continue;
      }
      const mv = h.qty.times(last.close);
      marketValue = marketValue.plus(mv);
      if (h.sector) sectorMv.set(h.sector, (sectorMv.get(h.sector) ?? ZERO).plus(mv));
    }
    const equity = cash.plus(marketValue);
    if (!equity.gt(0))
      throw new UnprocessableEntityException({
        message: 'The portfolio has no cash and no priced holdings, so no position can be sized',
        code: 'PORTFOLIO_EMPTY',
      });
    const sectorExposure = new Map<string, Decimal>();
    for (const [s, mv] of sectorMv) sectorExposure.set(s, mv.div(equity).times(HUNDRED));

    const maxPositionPct = limit ? fromDb(limit.maxPositionPct) : d(DEFAULT_PAPER_LIMITS.maxPositionPct);
    const maxSectorPct = d(DEFAULT_MAX_SECTOR_PCT);
    const riskPerTradePct = d(settings.riskPerTradePct);
    const risk: RiskConfig = { riskPerTradePct, maxPositionPct, maxSectorPct, feeSchedule: sched.spec };
    const currency = portfolio.baseCurrency || CURRENCY_FALLBACK;
    const holdingBy = new Map(holdings.map((h) => [h.stockId, h]));

    // Peer multiples from stored statements + the peer's own latest verified (non-simulated) close.
    const fctx: FundamentalsContext = { asOf: now.toISOString(), maxAgeDays: 400, maxPriceAgeDays: 7 };
    const peerBy = new Map<string, PeerInput>();
    for (const s of stocks) {
      const last = barsBy.get(s.id)?.at(-1);
      const sel = selectStatements(finBy.get(s.id) ?? []);
      if (!last || !sel || last.source === 'SIMULATED') continue;
      const price = { value: last.close, currency, source: last.source, asOf: last.ts };
      const pe = peRatio(sel.current, price, fctx);
      const pb = pbRatio(sel.current, price, fctx);
      if (pe.status !== 'OK' && pb.status !== 'OK') continue;
      peerBy.set(s.id, {
        symbol: s.symbol,
        pe: pe.status === 'OK' ? pe.value : null,
        pb: pb.status === 'OK' ? pb.value : null,
        asOf: last.ts,
        source: sel.current.source,
      });
    }

    const bundles: StockBundle[] = stocks.map((s) => {
      const bars = barsBy.get(s.id) ?? [];
      const lastBar = bars.at(-1) ?? null;
      const q = quoteBy.get(s.id) ?? null;
      const quote: QuoteFact | null = q
        ? {
            last: fromDb(q.last),
            source: q.source,
            asOf: iso(q.asOf),
            delayMinutes: q.delayMinutes,
            stale: isStale({ asOf: iso(q.asOf), delayMinutes: q.delayMinutes }, now, cal),
          }
        : null;
      const sel = selectStatements(finBy.get(s.id) ?? []);
      const peers = s.sector
        ? stocks
            .filter((o) => o.id !== s.id && o.sector === s.sector)
            .flatMap((o) => (peerBy.has(o.id) ? [peerBy.get(o.id) as PeerInput] : []))
        : [];
      const fundamentals: FundamentalsBundle | null = sel
        ? { current: sel.current, priorYear: sel.priorYear, priorQuarter: sel.priorQuarter, peers }
        : null;
      const dividends = divBy.get(s.id) ?? [];
      const holding = holdingBy.get(s.id) ?? null;
      if (!lastBar) {
        return {
          stock: { id: s.id, symbol: s.symbol, name: s.name, sector: s.sector },
          bars,
          lastBar,
          asOfBar: null,
          input: null,
          quote,
          stale: true,
          hasFundamentals: fundamentals !== null,
          fundamentals,
          dividends,
          holding,
        };
      }
      const asOfBar = pktDateOf(new Date(lastBar.ts));
      const lastClose = cal.sessionClose(cal.lastCompletedSession(now));
      const sinceCloseMin = Math.max(0, Math.ceil((now.getTime() - lastClose.getTime()) / 60_000));
      // A real (non-simulated) quote carries its own timestamp and is judged by the shared staleness rule; with no
      // such quote the price is the last completed bar, observed at that session's close.
      const useQuote = q !== null && q.source !== 'SIMULATED';
      const delay = useQuote ? q.delayMinutes : 0;
      const allowance = delay + DEFAULT_FRESHNESS_MINUTES;
      const limitMinutes = useQuote && cal.isOpen(now) ? allowance : sinceCloseMin + allowance;
      const priceAsOf = useQuote ? iso(q.asOf) : iso(cal.sessionClose(asOfBar));
      const ageMin = (now.getTime() - Date.parse(priceAsOf)) / 60_000;
      const sectorExposurePct = s.sector ? (sectorExposure.get(s.sector) ?? ZERO) : null;
      const portfolioCtx: PortfolioContext = {
        equity,
        cash,
        holdingQty: holding?.qty ?? ZERO,
        sectorExposurePct,
      };
      const input: Omit<EvaluateStockInput, 'horizon'> = {
        symbol: s.symbol,
        sector: s.sector,
        asOf: now.toISOString(),
        bars,
        marketData: { priceAsOf, freshnessLimitMinutes: limitMinutes, delayMinutes: delay },
        currency,
        fundamentals,
        dividendHistory: dividends,
        portfolio: portfolioCtx,
        risk,
      };
      return {
        stock: { id: s.id, symbol: s.symbol, name: s.name, sector: s.sector },
        bars,
        lastBar,
        asOfBar,
        input,
        quote,
        stale: ageMin > limitMinutes,
        hasFundamentals: fundamentals !== null,
        fundamentals,
        dividends,
        holding,
      };
    });

    return {
      now,
      today,
      calendar: cal,
      portfolio: { id: portfolio.id, name: portfolio.name, kind: portfolio.kind, baseCurrency: currency },
      cash,
      equity,
      marketValue,
      risk,
      riskPerTradePct,
      maxPositionPct,
      maxSectorPct,
      feeSchedule: sched.spec,
      sectorExposure,
      unpricedHoldings: unpriced,
      bundles,
      holdings,
    };
  }
}
