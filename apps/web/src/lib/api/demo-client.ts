/**
 * DemoApiClient — a complete in-memory implementation of `ApiClient` over SIMULATED data.
 * No network calls. Prices are deterministic (seeded); quote ticks are a seeded random walk.
 * Everything is labelled `SIMULATED` except a few deliberate demo items that show the other
 * provenance badges (a broker-confirmed contract-note trade, a user-reported trade, estimated
 * fees/taxes, a broker-confirmed cash figure).
 *
 * The constructor is pure (no clock, no timers) so it is safe to create during SSR; state is
 * built lazily on the first call.
 */
import { weakestSource, type DataSource, type OrderStatus } from '@ktrade/shared';
import { Dec } from '../decimal';
import { estimateFees } from '../fees';
import { DEMO_DAYS, avgCost, daysAgo, entryDate, makeTrade, positionSource, replay, seedLivePortfolio, seedPaperPortfolio, type LedgerEntry, type LedgerState } from '../demo/ledger';
import { allBars, barsFor, DEMO_TODAY, mulberry32, paisaToString, gaussian, type RawBar } from '../demo/prices';
import { BACKTEST_DISCLAIMER, defaultParams, runBacktest, runStrategy, scoreAt, STRATEGY_TEMPLATES } from '../demo/strategy-engine';
import { DEMO_UNIVERSE, findSeed } from '../demo/universe';
import {
  LIVE_PORTFOLIO_ID,
  PAPER_PORTFOLIO_ID,
  seedAlerts,
  seedChannels,
  seedConnections,
  seedDiscrepancies,
  seedFeeSchedules,
  seedImports,
  seedMailbox,
  seedNotifications,
  seedProviders,
  seedSessions,
  seedTaxRates,
  seedUserSettings,
  seedWatchlists,
} from '../demo/fixtures';
import type { ApiClient } from './client';
import { ApiError } from './errors';
import type {
  Alert,
  AssistantMessage,
  Backtest,
  BrokerConnection,
  ChannelConfig,
  ChartRange,
  DashboardCharts,
  DashboardSummary,
  Discrepancy,
  Dividend,
  Holding,
  ImportBatch,
  ImportRow,
  KillSwitch,
  MailboxStatus,
  MarketProvider,
  Notification,
  Order,
  OrderEvent,
  OrderPreviewRequest,
  PerformancePeriod,
  PerformanceRow,
  Portfolio,
  Quote,
  QuoteTick,
  Report,
  RiskCheck,
  RiskLimits,
  Session,
  Signal,
  Stock,
  Strategy,
  User,
  UserSettings,
  Watchlist,
} from './types';

export { LIVE_PORTFOLIO_ID, PAPER_PORTFOLIO_ID };

interface QuoteState {
  symbol: string;
  last: number; // paisa
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  asOf: string;
}

interface DayPoint {
  date: string;
  value: Dec;
  deposits: Dec;
  flow: Dec;
}

interface State {
  user: User | null;
  quotes: Map<string, QuoteState>;
  ledgers: Map<string, LedgerEntry[]>;
  dividends: Map<string, Dividend[]>;
  portfolios: Portfolio[];
  orders: Order[];
  watchlists: Watchlist[];
  strategies: Strategy[];
  signals: Signal[];
  backtests: Backtest[];
  notifications: Notification[];
  alerts: Alert[];
  assistant: AssistantMessage[];
  imports: ImportBatch[];
  importRows: Map<string, ImportRow[]>;
  mailbox: MailboxStatus;
  discrepancies: Discrepancy[];
  connections: BrokerConnection[];
  killSwitch: KillSwitch;
  riskLimits: Map<string, RiskLimits>;
  sessions: Session[];
  channels: ChannelConfig[];
  userSettings: UserSettings;
  providers: MarketProvider[];
  reports: Report[];
  stepUp: Map<string, number>;
  seriesCache: Map<string, { version: number; points: DayPoint[] }>;
  ledgerVersion: Map<string, number>;
}

export interface DemoApiClientOptions {
  /** Artificial latency per call (ms). Default 120; use 0 in tests. */
  latencyMs?: number;
  /** Quote tick interval (ms). Default 1500. */
  tickMs?: number;
  /** Override the clock (tests). */
  now?: () => number;
}

const PRICE_SOURCE: DataSource = 'SIMULATED';
const ACTIVE_ORDER_STATUSES: OrderStatus[] = ['APPROVED', 'AWAITING_MANUAL_PLACEMENT', 'PLACED_BY_USER', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED'];
const MANUAL_WARNING = 'Live execution is manual: place this order in the KTrade app after approval.';

function clone<T>(v: T): T {
  return structuredClone(v);
}

function hashHex(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).repeat(2);
}

export class DemoApiClient implements ApiClient {
  readonly kind = 'demo' as const;
  private s: State | null = null;
  private readonly latency: number;
  private readonly tickMs: number;
  private readonly now: () => number;
  private seq = 0;
  private tickRand = mulberry32(20261113);
  private listeners = new Set<{ symbols: Set<string>; cb: (t: QuoteTick) => void }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DemoApiClientOptions = {}) {
    this.latency = opts.latencyMs ?? 120;
    this.tickMs = opts.tickMs ?? 1500;
    this.now = opts.now ?? (() => Date.now());
  }

  // ─── infrastructure ──────────────────────────────────────────────────────

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq.toString(36)}${(this.now() % 1679616).toString(36)}`;
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  private async run<T>(fn: (s: State) => T): Promise<T> {
    if (this.latency > 0) await new Promise((r) => setTimeout(r, this.latency));
    return clone(fn(this.state()));
  }

  private state(): State {
    if (this.s) return this.s;
    const nowIso = this.iso();
    const quotes = new Map<string, QuoteState>();
    for (const [symbol, bars] of allBars()) {
      const today = bars[bars.length - 1];
      const prev = bars[bars.length - 2];
      quotes.set(symbol, { symbol, last: today.close, open: today.open, high: today.high, low: today.low, prevClose: prev.close, volume: today.volume, asOf: nowIso });
    }
    const live = seedLivePortfolio(LIVE_PORTFOLIO_ID);
    const paper = seedPaperPortfolio(PAPER_PORTFOLIO_ID);
    const imports = seedImports();
    const s: State = {
      user: null,
      quotes,
      ledgers: new Map([
        [LIVE_PORTFOLIO_ID, live.entries],
        [PAPER_PORTFOLIO_ID, paper.entries],
      ]),
      dividends: new Map([
        [LIVE_PORTFOLIO_ID, live.dividends],
        [PAPER_PORTFOLIO_ID, paper.dividends],
      ]),
      portfolios: [
        { id: LIVE_PORTFOLIO_ID, name: 'KTrade account (demo)', kind: 'LIVE', costBasisMethod: 'WEIGHTED_AVERAGE', createdAt: `${daysAgo(262)}T04:00:00Z`, demo: true },
        { id: PAPER_PORTFOLIO_ID, name: 'Paper — strategies', kind: 'PAPER', costBasisMethod: 'WEIGHTED_AVERAGE', initialCash: '1000000.00', createdAt: `${daysAgo(125)}T04:00:00Z`, demo: true },
      ],
      orders: [],
      watchlists: seedWatchlists(),
      strategies: [],
      signals: [],
      backtests: [],
      notifications: seedNotifications(),
      alerts: seedAlerts(),
      assistant: [],
      imports: imports.batches,
      importRows: imports.rows,
      mailbox: seedMailbox(),
      discrepancies: seedDiscrepancies(),
      connections: seedConnections(),
      killSwitch: { liveTradingEnabled: true, reason: 'Default: live order preparation allowed (execution is manual)', updatedAt: `${daysAgo(30)}T04:00:00Z` },
      riskLimits: new Map(
        [LIVE_PORTFOLIO_ID, PAPER_PORTFOLIO_ID].map((id) => [
          id,
          { portfolioId: id, maxOrderValue: '500000.00', maxOrderQty: '10000', priceBandPct: '5', maxDailyValue: '1000000.00', maxDailyCount: 10, maxPositionPct: '25', maxDailyLossPct: '3', liveAutoExecutionEnabled: false },
        ]),
      ),
      sessions: seedSessions(),
      channels: seedChannels(),
      userSettings: seedUserSettings(),
      providers: seedProviders(),
      reports: [],
      stepUp: new Map(),
      seriesCache: new Map(),
      ledgerVersion: new Map(),
    };
    this.s = s;
    // Discrepancy figures come from the seeded ledger.
    const pso = replay(live.entries).positions.get('PSO')?.qty ?? Dec.zero();
    s.discrepancies[0] = { ...s.discrepancies[0], ledger: pso.toString(), broker: pso.sub(5).toString(), difference: '5' };
    const cashNow = replay(live.entries).cash;
    s.discrepancies[1] = { ...s.discrepancies[1], ledger: cashNow.add('12.40').toFixed(2), broker: cashNow.toFixed(2), difference: '-12.40' };
    s.orders = this.seedOrders(s);
    s.strategies = this.seedStrategies();
    s.signals = this.buildSignals(s.strategies);
    s.assistant = [
      {
        id: 'msg-welcome',
        role: 'ASSISTANT',
        content:
          'Hi — I am the portfolio assistant running in DEMO mode: answers are canned and computed from simulated data, no language model is called. Try “summarise my portfolio”, “dividends”, “what if OGDC drops 10%”, “explain the latest signal” or “suggest an order”.',
        createdAt: `${DEMO_TODAY}T04:00:00Z`,
        toolCalls: [],
        citations: [],
        demo: true,
      },
    ];
    return s;
  }

  // ─── derived data helpers ────────────────────────────────────────────────

  private portfolio(s: State, id: string): Portfolio {
    const p = s.portfolios.find((x) => x.id === id);
    if (!p) throw new ApiError('NOT_FOUND', 404, 'Portfolio not found', id);
    return p;
  }

  private ledger(s: State, id: string): LedgerEntry[] {
    this.portfolio(s, id);
    return s.ledgers.get(id) ?? [];
  }

  private appendLedger(s: State, id: string, entry: LedgerEntry) {
    const l = this.ledger(s, id);
    l.push(entry);
    l.sort((a, b) => entryDate(a).localeCompare(entryDate(b)));
    s.ledgerVersion.set(id, (s.ledgerVersion.get(id) ?? 0) + 1);
  }

  private last(s: State, symbol: string): Dec {
    const q = s.quotes.get(symbol);
    return q ? Dec.fromMinor(q.last, 2) : Dec.zero();
  }

  private quote(s: State, symbol: string): Quote {
    const q = s.quotes.get(symbol);
    if (!q) throw new ApiError('NOT_FOUND', 404, 'Unknown symbol', symbol);
    const change = q.last - q.prevClose;
    return {
      symbol,
      last: paisaToString(q.last),
      open: paisaToString(q.open),
      high: paisaToString(q.high),
      low: paisaToString(q.low),
      prevClose: paisaToString(q.prevClose),
      change: paisaToString(change),
      changePct: Dec.of(change).div(q.prevClose).mul(100).toFixed(2),
      volume: String(q.volume),
      asOf: q.asOf,
      delayMinutes: 0,
      source: PRICE_SOURCE,
      stale: false,
    };
  }

  private holdings(s: State, pfId: string): { list: Holding[]; state: LedgerState } {
    const state = replay(this.ledger(s, pfId));
    const open = [...state.positions.values()].filter((p) => p.qty.gt(0));
    const mvs = open.map((p) => p.qty.mul(this.last(s, p.symbol)));
    const totalMv = Dec.sum(mvs);
    const list = open.map((p, i): Holding => {
      const seed = findSeed(p.symbol);
      const last = this.last(s, p.symbol);
      const mv = mvs[i];
      const unreal = mv.sub(p.cost);
      return {
        symbol: p.symbol,
        name: seed?.name ?? p.symbol,
        sector: seed?.sector ?? 'Other',
        quantity: p.qty.toString(),
        avgCost: avgCost(p).toFixed(4),
        lastPrice: { value: last.toFixed(2), source: PRICE_SOURCE, asOf: s.quotes.get(p.symbol)?.asOf },
        totalCost: p.cost.toFixed(2),
        marketValue: mv.toFixed(2),
        unrealizedPnl: unreal.toFixed(2),
        unrealizedPnlPct: p.cost.isZero() ? '0.00' : unreal.div(p.cost).mul(100).toFixed(2),
        realizedPnl: p.realized.toFixed(2),
        weight: totalMv.isZero() ? '0' : mv.div(totalMv).toFixed(6),
        dayChangePct: this.quote(s, p.symbol).changePct,
        source: positionSource(p),
        lastConfirmed: p.lastConfirmed,
      };
    });
    list.sort((a, b) => Dec.of(b.marketValue).cmp(a.marketValue));
    return { list, state };
  }

  /** Daily account value series, replaying the ledger over the simulated calendar. */
  private series(s: State, pfId: string): DayPoint[] {
    const entries = this.ledger(s, pfId);
    const version = s.ledgerVersion.get(pfId) ?? 0;
    const cached = s.seriesCache.get(pfId);
    let points: DayPoint[];
    if (cached && cached.version === version) {
      points = cached.points.slice();
    } else {
      points = [];
      if (entries.length) {
        const first = entries[0].kind === 'txn' ? entries[0].txn.tradeDate : entries[0].cash.date;
        const days = DEMO_DAYS.filter((d) => d >= first);
        const bars = allBars();
        const idx = new Map<string, number>();
        let st = replay([]);
        let k = 0;
        for (const day of days) {
          const before = st.deposits;
          while (k < entries.length && entryDate(entries[k]) <= day) k++;
          st = replay(entries.slice(0, k));
          let mv = Dec.zero();
          for (const p of st.positions.values()) {
            if (!p.qty.gt(0)) continue;
            const b = bars.get(p.symbol) ?? [];
            let j = idx.get(p.symbol) ?? 0;
            while (j + 1 < b.length && b[j + 1].date <= day) j++;
            idx.set(p.symbol, j);
            mv = mv.add(p.qty.mul(Dec.fromMinor(b[j].close, 2)));
          }
          points.push({ date: day, value: st.cash.add(mv), deposits: st.deposits, flow: st.deposits.sub(before) });
        }
      }
      s.seriesCache.set(pfId, { version, points: points.slice() });
    }
    // Today's point uses live quotes.
    if (points.length && points[points.length - 1].date === DEMO_TODAY) {
      const { state } = this.holdings(s, pfId);
      let mv = Dec.zero();
      for (const p of state.positions.values()) if (p.qty.gt(0)) mv = mv.add(p.qty.mul(this.last(s, p.symbol)));
      points[points.length - 1] = { ...points[points.length - 1], value: state.cash.add(mv) };
    }
    return points;
  }

  private dailyReturns(points: DayPoint[]): { date: string; pnl: Dec; ret: Dec }[] {
    const out: { date: string; pnl: Dec; ret: Dec }[] = [];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1].value;
      const pnl = points[i].value.sub(prev).sub(points[i].flow);
      const base = prev.add(points[i].flow);
      out.push({ date: points[i].date, pnl, ret: base.isZero() ? Dec.zero() : pnl.div(base) });
    }
    return out;
  }

  // ─── orders ──────────────────────────────────────────────────────────────

  private event(status: OrderStatus, actor: OrderEvent['actor'], note: string, at: string): OrderEvent {
    return { id: this.id('ev'), at, status, actor, note };
  }

  private pendingBuyValue(s: State, pfId: string, excludeId?: string): Dec {
    return Dec.sum(
      s.orders
        .filter((o) => o.portfolioId === pfId && o.side === 'BUY' && o.id !== excludeId && ACTIVE_ORDER_STATUSES.includes(o.status))
        .map((o) => Dec.of(o.estimate.total).mul(Dec.of(o.quantity).sub(o.filledQuantity)).div(o.quantity)),
    );
  }

  private pendingSellQty(s: State, pfId: string, symbol: string, excludeId?: string): Dec {
    return Dec.sum(
      s.orders
        .filter((o) => o.portfolioId === pfId && o.symbol === symbol && o.side === 'SELL' && o.id !== excludeId && ACTIVE_ORDER_STATUSES.includes(o.status))
        .map((o) => Dec.of(o.quantity).sub(o.filledQuantity)),
    );
  }

  private riskChecks(s: State, o: Pick<Order, 'id' | 'portfolioId' | 'mode' | 'symbol' | 'side' | 'type' | 'quantity' | 'limitPrice' | 'estimate'>): RiskCheck[] {
    const limits = s.riskLimits.get(o.portfolioId)!;
    const { list, state } = this.holdings(s, o.portfolioId);
    const qty = Dec.of(o.quantity);
    const notional = Dec.of(o.estimate.notional);
    const total = Dec.of(o.estimate.total);
    const last = this.last(s, o.symbol);
    const live = o.mode === 'LIVE';
    const today = this.iso().slice(0, 10);
    const todays = s.orders.filter((x) => x.portfolioId === o.portfolioId && x.id !== o.id && x.createdAt.slice(0, 10) === today && (ACTIVE_ORDER_STATUSES.includes(x.status) || x.status === 'FILLED'));
    const dailyValue = Dec.sum(todays.map((x) => x.estimate.notional)).add(notional);
    const mvTotal = Dec.sum(list.map((h) => h.marketValue));
    const account = mvTotal.add(state.cash);
    const posMv = Dec.of(list.find((h) => h.symbol === o.symbol)?.marketValue ?? '0');
    const todayPnl = Dec.sum(list.map((h) => Dec.of(h.quantity).mul(Dec.of(this.quote(s, h.symbol).change))));
    const todayPct = account.isZero() ? Dec.zero() : todayPnl.div(account.sub(todayPnl)).mul(100);

    const checks: RiskCheck[] = [];
    checks.push(
      live
        ? { rule: 'KILL_SWITCH', passed: s.killSwitch.liveTradingEnabled, observed: s.killSwitch.liveTradingEnabled ? 'ON' : 'OFF', limit: 'ON', message: s.killSwitch.liveTradingEnabled ? 'Live trading switch is on' : `Kill switch engaged: ${s.killSwitch.reason}` }
        : { rule: 'KILL_SWITCH', passed: true, message: 'Not applicable to paper trading' },
    );
    checks.push(
      live
        ? { rule: 'CAPABILITY', passed: true, observed: 'MANUAL_TICKET', message: 'No KTrade adapter is authorized, so the order is routed to a manual ticket you place yourself' }
        : { rule: 'CAPABILITY', passed: true, observed: 'PAPER', message: 'Paper broker: all capabilities enabled' },
    );
    checks.push({ rule: 'MARKET_HOURS', passed: true, observed: 'Simulated session', message: 'Demo calendar treats the simulated session as open (real: Mon–Fri 09:30–15:30 PKT)' });
    if (o.side === 'BUY') {
      const available = state.cash.sub(this.pendingBuyValue(s, o.portfolioId, o.id));
      checks.push({ rule: 'BUYING_POWER', passed: available.gte(total), observed: available.toFixed(2), limit: total.toFixed(2), message: available.gte(total) ? 'Cash minus pending buys covers the estimated total' : 'Insufficient cash after pending buys' });
      checks.push({ rule: 'HOLDING_QTY', passed: true, message: 'Not applicable to buys' });
    } else {
      const held = Dec.of(list.find((h) => h.symbol === o.symbol)?.quantity ?? '0');
      const available = held.sub(this.pendingSellQty(s, o.portfolioId, o.symbol, o.id));
      checks.push({ rule: 'BUYING_POWER', passed: true, message: 'Not applicable to sells' });
      checks.push({ rule: 'HOLDING_QTY', passed: available.gte(qty), observed: available.toString(), limit: qty.toString(), message: available.gte(qty) ? 'Held minus pending sells covers the quantity' : 'Not enough shares (short selling is not modelled)' });
    }
    checks.push({ rule: 'MAX_ORDER_VALUE', passed: notional.lte(limits.maxOrderValue), observed: notional.toFixed(2), limit: limits.maxOrderValue, message: 'Order value within the per-order cap' });
    checks.push({ rule: 'MAX_ORDER_QTY', passed: qty.lte(limits.maxOrderQty), observed: qty.toString(), limit: limits.maxOrderQty, message: 'Quantity within the per-order cap' });
    if (o.limitPrice && !last.isZero()) {
      const dev = Dec.of(o.limitPrice).sub(last).abs().div(last).mul(100);
      checks.push({ rule: 'PRICE_BAND', passed: dev.lte(limits.priceBandPct), observed: `${dev.toFixed(2)}%`, limit: `${limits.priceBandPct}%`, message: 'Limit price close enough to the last price' });
    } else {
      checks.push({ rule: 'PRICE_BAND', passed: true, message: 'Market order: reference price used' });
    }
    checks.push({ rule: 'DAILY_VALUE', passed: dailyValue.lte(limits.maxDailyValue), observed: dailyValue.toFixed(2), limit: limits.maxDailyValue, message: "Today's approved value within the daily cap" });
    checks.push({ rule: 'DAILY_COUNT', passed: todays.length + 1 <= limits.maxDailyCount, observed: String(todays.length + 1), limit: String(limits.maxDailyCount), message: "Today's order count within the daily cap" });
    if (o.side === 'BUY') {
      const post = account.isZero() ? Dec.zero() : posMv.add(notional).div(account).mul(100);
      checks.push({ rule: 'CONCENTRATION', passed: post.lte(limits.maxPositionPct), observed: `${post.toFixed(2)}%`, limit: `${limits.maxPositionPct}%`, message: 'Post-trade position weight within the cap' });
      const blocked = todayPct.lt(Dec.of(limits.maxDailyLossPct).neg());
      checks.push({ rule: 'DAILY_LOSS', passed: !blocked, observed: `${todayPct.toFixed(2)}%`, limit: `−${limits.maxDailyLossPct}%`, message: blocked ? 'Portfolio is down more than the daily loss limit; buys are blocked' : 'Daily loss limit not breached' });
    } else {
      checks.push({ rule: 'CONCENTRATION', passed: true, message: 'Sells reduce concentration' });
      checks.push({ rule: 'DAILY_LOSS', passed: true, message: 'Only blocks buys' });
    }
    return checks;
  }

  private validatePreview(req: OrderPreviewRequest) {
    const errs: string[] = [];
    if (!findSeed(req.symbol)) errs.push(`Unknown symbol ${req.symbol}`);
    if (!/^\d+$/.test(req.quantity) || Dec.of(req.quantity).lte(0)) errs.push('Quantity must be a whole number of shares > 0');
    if ((req.type === 'LIMIT' || req.type === 'STOP_LIMIT') && !req.limitPrice) errs.push('Limit price is required');
    if ((req.type === 'STOP_LOSS' || req.type === 'STOP_LIMIT') && !req.stopPrice) errs.push('Stop price is required');
    for (const p of [req.limitPrice, req.stopPrice]) if (p !== undefined && (!/^\d+(\.\d{1,2})?$/.test(p) || Dec.of(p).lte(0))) errs.push('Prices must be positive with at most 2 decimals');
    if (errs.length) throw new ApiError('VALIDATION_FAILED', 422, 'Invalid order', errs.join('; '));
  }

  private buildPreview(s: State, req: OrderPreviewRequest): Order {
    this.validatePreview(req);
    const pf = this.portfolio(s, req.portfolioId);
    const mode = pf.kind === 'PAPER' ? 'PAPER' : 'LIVE';
    const q = s.quotes.get(req.symbol)!;
    const ref = paisaToString(q.last);
    const px = req.limitPrice ?? req.stopPrice ?? ref;
    const estimate = estimateFees(req.side, req.quantity, px);
    const now = this.iso();
    const id = this.id('ord');
    const draft = { id, portfolioId: req.portfolioId, mode, symbol: req.symbol, side: req.side, type: req.type, quantity: req.quantity, limitPrice: req.limitPrice ?? null, estimate } as const;
    const riskChecks = this.riskChecks(s, draft);
    const passed = riskChecks.every((c) => c.passed);
    const hashInput = JSON.stringify([req.portfolioId, req.symbol, req.side, req.type, req.quantity, req.limitPrice ?? '', req.stopPrice ?? '', estimate.total]);
    const warnings: string[] = [];
    if (mode === 'LIVE') {
      warnings.push(MANUAL_WARNING);
      warnings.push('Reference price is SIMULATED. The real API refuses live previews on simulated prices; the demo allows it so you can explore the flow.');
    }
    if (estimate.fees.some((f) => f.component === 'CDC_CHARGES')) warnings.push('CDC charges are at actual and will be known from the contract note.');
    const status: OrderStatus = passed ? 'PREVIEWED' : 'REJECTED_BY_RISK';
    return {
      ...draft,
      status,
      executionPath: mode === 'PAPER' ? 'PAPER_AUTO' : 'MANUAL_TICKET',
      stopPrice: req.stopPrice ?? null,
      timeInForce: req.timeInForce ?? 'DAY',
      origin: req.origin,
      referencePrice: { value: ref, asOf: q.asOf, source: PRICE_SOURCE, delayMinutes: 0 },
      riskChecks,
      previewHash: `sha256:demo-${hashHex(hashInput)}`,
      previewExpiresAt: this.iso(5 * 60 * 1000),
      warnings,
      createdAt: now,
      updatedAt: now,
      brokerOrderRef: null,
      filledQuantity: '0',
      avgFillPrice: null,
      events: [
        this.event('DRAFT', 'USER', `Order ticket submitted (${req.origin.toLowerCase().replace('_', ' ')})`, now),
        this.event(status, 'SYSTEM', passed ? 'Preview created; all 12 risk checks passed' : `Rejected: ${riskChecks.filter((c) => !c.passed).map((c) => c.rule).join(', ')}`, now),
      ],
      executions: [],
    };
  }

  private order(s: State, id: string): Order {
    const o = s.orders.find((x) => x.id === id);
    if (!o) throw new ApiError('NOT_FOUND', 404, 'Order not found', id);
    return o;
  }

  private expireStale(s: State) {
    const now = this.now();
    for (const o of s.orders) {
      if (o.status === 'PREVIEWED' && Date.parse(o.previewExpiresAt) < now) {
        o.status = 'EXPIRED';
        o.updatedAt = o.previewExpiresAt;
        o.events.push(this.event('EXPIRED', 'SYSTEM', 'Preview expired after 5 minutes without approval', o.previewExpiresAt));
      }
    }
  }

  private requireStepUp(s: State, token: string) {
    const exp = s.stepUp.get(token);
    if (!exp || exp < this.now()) throw new ApiError('STEP_UP_REQUIRED', 401, 'Step-up required', 'Confirm with your authenticator code (valid 5 minutes).');
  }

  private applyFill(s: State, o: Order, qty: string, price: string, at: string, source: DataSource, note: string) {
    const execution = { id: this.id('ex'), orderId: o.id, symbol: o.symbol, side: o.side, quantity: qty, price, executedAt: at, source };
    o.executions.push(execution);
    const prevFilled = Dec.of(o.filledQuantity);
    const newFilled = prevFilled.add(qty);
    const prevValue = o.avgFillPrice ? Dec.of(o.avgFillPrice).mul(prevFilled) : Dec.zero();
    o.avgFillPrice = prevValue.add(Dec.of(price).mul(qty)).div(newFilled).toFixed(4);
    o.filledQuantity = newFilled.toString();
    o.status = newFilled.gte(o.quantity) ? 'FILLED' : 'PARTIALLY_FILLED';
    o.updatedAt = this.iso();
    o.events.push(this.event(o.status, source === 'SIMULATED' ? 'SYSTEM' : 'USER', note, this.iso()));
    const txn = makeTrade({ portfolioId: o.portfolioId, date: DEMO_TODAY, type: o.side, symbol: o.symbol, quantity: qty, price, source, orderId: o.id, reference: `Order ${o.id}` });
    this.appendLedger(s, o.portfolioId, { kind: 'txn', txn });
  }

  private seedOrders(s: State): Order[] {
    const mk = (req: OrderPreviewRequest, createdAt: string, steps: { status: OrderStatus; note: string; actor?: OrderEvent['actor']; at?: string }[], extra: Partial<Order> = {}): Order => {
      const base = this.buildPreview(s, req);
      const expires = new Date(Date.parse(createdAt) + 5 * 60 * 1000).toISOString();
      const o: Order = { ...base, createdAt, updatedAt: createdAt, previewExpiresAt: expires, ...extra };
      o.events = [
        { ...base.events[0], at: createdAt },
        { ...base.events[1], at: createdAt },
        ...steps.map((st) => this.event(st.status, st.actor ?? 'USER', st.note, st.at ?? createdAt)),
      ];
      o.status = steps.length ? steps[steps.length - 1].status : base.status;
      return o;
    };
    const live = LIVE_PORTFOLIO_ID;
    const t = (n: number, hm: string) => `${daysAgo(n)}T${hm}:00Z`;
    const mariTxn = replay(s.ledgers.get(live)!).positions.get('MARI');
    const mariQty = mariTxn?.qty.toString() ?? '200';
    const mariPx = paisaToString(barsFor('MARI').find((b) => b.date === daysAgo(10))?.close ?? 60000);
    const orders: Order[] = [];
    orders.push(
      mk({ portfolioId: live, symbol: 'MARI', side: 'BUY', type: 'LIMIT', quantity: mariQty, limitPrice: mariPx, origin: 'MANUAL' }, t(10, '05:02'), [
        { status: 'APPROVED', note: 'Approved with step-up (TOTP)', at: t(10, '05:03') },
        { status: 'AWAITING_MANUAL_PLACEMENT', note: 'Manual ticket issued — place in the KTrade app', actor: 'SYSTEM', at: t(10, '05:03') },
        { status: 'PLACED_BY_USER', note: 'You marked the order as placed (KTrade ref KT-88213)', at: t(10, '05:06') },
        { status: 'FILLED', note: 'Fill recorded from contract note CN-2026-10-30-0042 (broker-confirmed)', actor: 'WORKER', at: t(9, '03:00') },
      ], { brokerOrderRef: 'KT-88213', filledQuantity: mariQty, avgFillPrice: Dec.of(mariPx).toFixed(4) }),
    );
    orders[0].executions = [{ id: 'ex-mari', orderId: orders[0].id, symbol: 'MARI', side: 'BUY', quantity: mariQty, price: mariPx, executedAt: t(10, '05:20'), source: 'BROKER_CONFIRMED' }];
    const luck = paisaToString(s.quotes.get('LUCK')!.prevClose - 150);
    orders.push(
      mk({ portfolioId: live, symbol: 'LUCK', side: 'BUY', type: 'LIMIT', quantity: '100', limitPrice: luck, origin: 'STRATEGY' }, t(0, '04:41'), [
        { status: 'APPROVED', note: 'Approved with step-up (TOTP)', at: t(0, '04:42') },
        { status: 'AWAITING_MANUAL_PLACEMENT', note: 'Manual ticket issued — place in the KTrade app', actor: 'SYSTEM', at: t(0, '04:42') },
        { status: 'PLACED_BY_USER', note: 'You marked the order as placed', at: t(0, '04:47') },
      ], { brokerOrderRef: null }),
    );
    const ffc = paisaToString(s.quotes.get('FFC')!.prevClose + 200);
    orders.push(
      mk({ portfolioId: live, symbol: 'FFC', side: 'SELL', type: 'LIMIT', quantity: '50', limitPrice: ffc, origin: 'MANUAL' }, t(0, '05:15'), [
        { status: 'APPROVED', note: 'Approved with step-up (TOTP)', at: t(0, '05:16') },
        { status: 'AWAITING_MANUAL_PLACEMENT', note: 'Manual ticket issued — place in the KTrade app', actor: 'SYSTEM', at: t(0, '05:16') },
      ]),
    );
    orders.push(
      mk({ portfolioId: live, symbol: 'ENGRO', side: 'BUY', type: 'MARKET', quantity: '200', origin: 'MANUAL' }, t(5, '06:00'), [
        { status: 'APPROVED', note: 'Approved with step-up (TOTP)', at: t(5, '06:01') },
        { status: 'AWAITING_MANUAL_PLACEMENT', note: 'Manual ticket issued', actor: 'SYSTEM', at: t(5, '06:01') },
        { status: 'CANCELLED', note: 'Cancelled before placement — nothing was sent to KTrade', at: t(5, '06:30') },
      ]),
    );
    orders.push(mk({ portfolioId: live, symbol: 'KEL', side: 'BUY', type: 'MARKET', quantity: '60000', origin: 'ALERT' }, t(4, '07:00'), []));
    orders.push(
      mk({ portfolioId: live, symbol: 'PPL', side: 'BUY', type: 'MARKET', quantity: '150', origin: 'AI_SUGGESTION' }, t(3, '08:00'), [
        { status: 'EXPIRED', note: 'Preview expired after 5 minutes without approval', actor: 'SYSTEM', at: t(3, '08:05') },
      ]),
    );
    const polBar = barsFor('POL').find((b) => b.date === daysAgo(12));
    const polTxn = s.ledgers.get(PAPER_PORTFOLIO_ID)!.find((e) => e.kind === 'txn' && e.txn.symbol === 'POL');
    const polQty = polTxn && polTxn.kind === 'txn' ? polTxn.txn.quantity : '100';
    const polPx = paisaToString(polBar?.close ?? 56000);
    const paperOrder = mk({ portfolioId: PAPER_PORTFOLIO_ID, symbol: 'POL', side: 'BUY', type: 'MARKET', quantity: polQty, origin: 'STRATEGY' }, t(12, '10:31'), [
      { status: 'APPROVED', note: 'Auto-approved (paper + strategy.autoExecute)', actor: 'STRATEGY', at: t(12, '10:31') },
      { status: 'SUBMITTED', note: 'Sent to paper broker', actor: 'SYSTEM', at: t(12, '10:31') },
      { status: 'FILLED', note: 'Simulated fill at next quote', actor: 'SYSTEM', at: t(12, '10:32') },
    ], { filledQuantity: polQty, avgFillPrice: Dec.of(polPx).toFixed(4) });
    paperOrder.executions = [{ id: 'ex-pol', orderId: paperOrder.id, symbol: 'POL', side: 'BUY', quantity: polQty, price: polPx, executedAt: t(12, '10:32'), source: 'SIMULATED' }];
    orders.push(paperOrder);
    return orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ─── strategies & signals ────────────────────────────────────────────────

  private seedStrategies(): Strategy[] {
    const created = `${daysAgo(90)}T04:00:00Z`;
    return [
      { id: 'st-ema', name: 'EMA 9/21 — energy', type: 'MA_CROSSOVER', mode: 'PAPER', symbols: ['OGDC', 'PPL', 'HUBC'], parameters: defaultParams('MA_CROSSOVER'), active: true, autoExecute: true, version: 3, createdAt: created, lastEvaluatedAt: `${DEMO_TODAY}T10:35:00Z` },
      { id: 'st-rsi', name: 'RSI swing — banks', type: 'RSI', mode: 'PAPER', symbols: ['MCB', 'UBL', 'MEBL'], parameters: defaultParams('RSI'), active: true, autoExecute: false, version: 1, createdAt: created, lastEvaluatedAt: `${DEMO_TODAY}T10:35:00Z` },
      { id: 'st-macd', name: 'MACD momentum — tech', type: 'MACD', mode: 'PAPER', symbols: ['SYS', 'TRG', 'NETSOL'], parameters: defaultParams('MACD'), active: true, autoExecute: false, version: 2, createdAt: created, lastEvaluatedAt: `${DEMO_TODAY}T10:35:00Z` },
      { id: 'st-trail', name: 'Trailing stop 7% — LUCK', type: 'TRAILING_STOP', mode: 'LIVE', symbols: ['LUCK'], parameters: defaultParams('TRAILING_STOP'), active: false, autoExecute: false, version: 1, createdAt: created, lastEvaluatedAt: null },
    ];
  }

  private buildSignals(strategies: Strategy[]): Signal[] {
    const out: Signal[] = [];
    for (const st of strategies) {
      if (st.type === 'TRAILING_STOP' || st.type === 'STOP_LOSS' || st.type === 'TAKE_PROFIT') continue;
      for (const sym of st.symbols) {
        const bars = barsFor(sym).slice(-260);
        const events = runStrategy(st.type, st.parameters, bars).filter((e) => e.i >= bars.length - 40);
        events.forEach((ev, k) => {
          const bar = bars[ev.i];
          const { score, components } = scoreAt(bars, ev.i);
          const newest = k === events.length - 1 && ev.i >= bars.length - 10;
          out.push({
            id: `sig-${st.id}-${sym}-${bar.date}`,
            strategyId: st.id,
            strategyName: st.name,
            symbol: sym,
            type: ev.type,
            reason: ev.reason,
            price: { value: paisaToString(bar.close), source: PRICE_SOURCE, asOf: `${bar.date}T10:30:00Z` },
            score,
            scoreComponents: components,
            status: newest ? 'NEW' : st.autoExecute && st.mode === 'PAPER' ? 'AUTO_EXECUTED_PAPER' : 'DISMISSED',
            createdAt: `${bar.date}T10:35:00Z`,
            trace: ev.trace,
            explanation: ev.explanation,
          });
        });
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ─── quote stream ────────────────────────────────────────────────────────

  private tick() {
    const s = this.state();
    const asOf = this.iso();
    const changed: QuoteTick[] = [];
    for (const q of s.quotes.values()) {
      if (this.tickRand() > 0.45) continue;
      const seed = findSeed(q.symbol)!;
      const move = gaussian(this.tickRand) * seed.vol * 0.12;
      const band = Math.round(q.prevClose * 0.075);
      const next = Math.min(q.prevClose + band, Math.max(q.prevClose - band, Math.max(1, Math.round(q.last * (1 + move)))));
      q.last = next;
      q.high = Math.max(q.high, next);
      q.low = Math.min(q.low, next);
      q.volume += Math.round(seed.adv * 0.002 * (0.5 + this.tickRand()));
      q.asOf = asOf;
      const quote = this.quote(s, q.symbol);
      changed.push({ symbol: q.symbol, last: quote.last, change: quote.change, changePct: quote.changePct, volume: quote.volume, high: quote.high, low: quote.low, asOf, source: PRICE_SOURCE, delayMinutes: 0 });
    }
    for (const l of this.listeners) for (const t of changed) if (l.symbols.has(t.symbol)) l.cb(t);
  }

  // ─── API groups ──────────────────────────────────────────────────────────

  auth: ApiClient['auth'] = {
    login: (req) =>
      this.run((s) => {
        if (!/^\S+@\S+\.\S+$/.test(req.email) || req.password.length < 8) throw new ApiError('INVALID_CREDENTIALS', 401, 'Invalid credentials', 'Demo: use any email and a password of 8+ characters.');
        s.user = { id: 'usr-demo', email: req.email, displayName: s.userSettings.displayName, role: 'OWNER' };
        return { user: s.user, totpRequired: false as const };
      }),
    register: (req) =>
      this.run((s) => {
        s.user = { id: 'usr-demo', email: req.email, displayName: req.displayName, role: 'OWNER' };
        s.userSettings.displayName = req.displayName;
        return s.user;
      }),
    logout: () =>
      this.run((s) => {
        s.user = null;
      }),
    me: () => this.run((s) => s.user ?? { id: 'usr-demo', email: 'owner@example.com', displayName: s.userSettings.displayName, role: 'OWNER' as const }),
    stepUp: (code) =>
      this.run((s) => {
        if (!/^\d{6}$/.test(code) || code === '000000') throw new ApiError('INVALID_TOTP', 401, 'Invalid code', 'Demo: any 6 digits except 000000 are accepted.');
        const token = this.id('stepup');
        const exp = this.now() + 5 * 60 * 1000;
        s.stepUp.set(token, exp);
        return { token, expiresAt: new Date(exp).toISOString() };
      }),
  };

  system: ApiClient['system'] = {
    dataMode: () => this.run(() => ({ priceSource: PRICE_SOURCE, providerKey: 'simulated', delayMinutes: 0, liveExecution: 'MANUAL' as const, demo: true })),
    killSwitch: () => this.run((s) => s.killSwitch),
    setKillSwitch: ({ liveTradingEnabled, reason, stepUpToken }) =>
      this.run((s) => {
        this.requireStepUp(s, stepUpToken);
        s.killSwitch = { liveTradingEnabled, reason: reason || (liveTradingEnabled ? 'Re-enabled' : 'Engaged by owner'), updatedAt: this.iso() };
        return s.killSwitch;
      }),
  };

  dashboard: ApiClient['dashboard'] = {
    summary: (pfId) =>
      this.run((s): DashboardSummary => {
        const { list, state } = this.holdings(s, pfId);
        const mv = Dec.sum(list.map((h) => h.marketValue));
        const account = mv.add(state.cash);
        const unreal = Dec.sum(list.map((h) => h.unrealizedPnl));
        const realized = Dec.sum([...state.positions.values()].map((p) => p.realized));
        const invested = Dec.sum(list.map((h) => h.totalCost));
        const todayPnl = Dec.sum(list.map((h) => Dec.of(h.quantity).mul(this.quote(s, h.symbol).change)));
        const points = this.series(s, pfId);
        const rets = this.dailyReturns(points);
        const monthStart = DEMO_TODAY.slice(0, 7);
        const monthPnl = Dec.sum(rets.filter((r) => r.date.startsWith(monthStart)).map((r) => r.pnl));
        const twr = rets.reduce((acc, r) => acc.mul(Dec.of(1).add(r.ret)), Dec.of(1)).sub(1).mul(100);
        const xirr = this.xirr(points, account);
        const priced = list.map((h) => h.lastPrice.source);
        const breakdown = this.breakdown(list);
        const pendingOrders = s.orders.filter((o) => o.portfolioId === pfId && (ACTIVE_ORDER_STATUSES.includes(o.status) || o.status === 'PREVIEWED')).length;
        const asOf = [...s.quotes.values()].reduce((a, q) => (q.asOf > a ? q.asOf : a), '');
        const src = priced.length ? weakestSource(priced) : PRICE_SOURCE;
        const isLive = this.portfolio(s, pfId).kind === 'LIVE';
        return {
          portfolioId: pfId,
          accountValue: { value: account.toFixed(2), source: src, sourceBreakdown: breakdown },
          investedAmount: { value: invested.toFixed(2), source: 'SIMULATED' },
          marketValue: { value: mv.toFixed(2), source: src, sourceBreakdown: breakdown },
          cash: {
            ledger: { value: state.cash.toFixed(2), source: 'SIMULATED' },
            broker: isLive ? { value: state.cash.toFixed(2), source: 'BROKER_CONFIRMED', asOf: `${daysAgo(1)}T11:00:00Z`, note: 'Demo item: shows how a statement-confirmed cash balance is labelled' } : null,
          },
          realizedPnl: { value: realized.toFixed(2), source: 'SIMULATED' },
          unrealizedPnl: { value: unreal.toFixed(2), source: src },
          todayPnl: { value: todayPnl.toFixed(2), source: src },
          todayPnlPct: { value: account.sub(todayPnl).isZero() ? '0.00' : todayPnl.div(account.sub(todayPnl)).mul(100).toFixed(2), source: src },
          monthPnl: { value: monthPnl.toFixed(2), source: src },
          totalReturnPct: { value: state.deposits.isZero() ? '0.00' : account.sub(state.deposits).div(state.deposits).mul(100).toFixed(2), source: src },
          twrPct: { value: twr.toFixed(2), source: src },
          xirrPct: { value: xirr, source: src },
          dividendsReceived: { value: state.dividends.toFixed(2), source: 'SIMULATED' },
          feesPaid: { value: state.fees.toFixed(2), source: 'ESTIMATED' },
          taxesPaid: { value: state.taxes.toFixed(2), source: 'ESTIMATED' },
          activeHoldings: list.length,
          pendingOrders,
          sourceBreakdown: breakdown,
          pricesAsOf: asOf,
          priceSource: src,
        };
      }),
    charts: (pfId, range) =>
      this.run((s): DashboardCharts => {
        const all = this.series(s, pfId);
        const n = range === '1M' ? 21 : range === '3M' ? 63 : range === '1Y' ? 250 : all.length;
        const pts = range === 'YTD' ? all.filter((p) => p.date >= `${DEMO_TODAY.slice(0, 4)}-01-01`) : all.slice(-n);
        const rets = this.dailyReturns(all);
        const firstDate = pts[0]?.date ?? DEMO_TODAY;
        const { list } = this.holdings(s, pfId);
        const total = Dec.sum(list.map((h) => h.marketValue));
        const bySector = new Map<string, Dec>();
        for (const h of list) bySector.set(h.sector, (bySector.get(h.sector) ?? Dec.zero()).add(h.marketValue));
        const months = new Map<string, { pnl: Dec; start: Dec }>();
        let prevVal = all[0]?.value ?? Dec.zero();
        for (let i = 1; i < all.length; i++) {
          const m = all[i].date.slice(0, 7);
          if (!months.has(m)) months.set(m, { pnl: Dec.zero(), start: prevVal.add(all[i].flow) });
          const r = rets[i - 1];
          months.get(m)!.pnl = months.get(m)!.pnl.add(r.pnl);
          prevVal = all[i].value;
        }
        return {
          range,
          source: PRICE_SOURCE,
          performance: pts.map((p) => ({ date: p.date, value: p.value.toFixed(2), invested: p.deposits.toFixed(2) })),
          allocation: [...bySector.entries()].map(([sector, v]) => ({ sector, value: v.toFixed(2), weight: total.isZero() ? '0' : v.div(total).toFixed(6) })).sort((a, b) => Dec.of(b.value).cmp(a.value)),
          dailyPnl: rets.filter((r) => r.date >= firstDate).slice(-60).map((r) => ({ date: r.date, pnl: r.pnl.toFixed(2) })),
          monthly: [...months.entries()].slice(-12).map(([month, v]) => ({ month, pnl: v.pnl.toFixed(2), returnPct: v.start.isZero() ? '0.00' : v.pnl.div(v.start).mul(100).toFixed(2) })),
          distribution: list.map((h) => ({ symbol: h.symbol, value: h.marketValue, weight: h.weight })),
        };
      }),
  };

  private breakdown(list: Holding[]): Partial<Record<DataSource, string>> {
    const total = Dec.sum(list.map((h) => h.marketValue));
    if (total.isZero()) return { SIMULATED: '1' };
    const m = new Map<DataSource, Dec>();
    for (const h of list) m.set(h.lastPrice.source, (m.get(h.lastPrice.source) ?? Dec.zero()).add(h.marketValue));
    return Object.fromEntries([...m.entries()].map(([k, v]) => [k, v.div(total).toFixed(4)]));
  }

  /** Money-weighted return (annualised), solved by bisection. A statistic, rounded to 2 dp. */
  private xirr(points: DayPoint[], terminal: Dec): string {
    const flows: { t: number; v: number }[] = [];
    const t0 = points.length ? Date.parse(points[0].date) : 0;
    for (const p of points) if (!p.flow.isZero()) flows.push({ t: (Date.parse(p.date) - t0) / 31_536_000_000, v: -p.flow.toNumber() });
    if (!flows.length || !points.length) return '0.00';
    flows.push({ t: (Date.parse(points[points.length - 1].date) - t0) / 31_536_000_000, v: terminal.toNumber() });
    const npv = (r: number) => flows.reduce((a, f) => a + f.v / Math.pow(1 + r, f.t), 0);
    let lo = -0.99;
    let hi = 10;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (npv(mid) > 0) lo = mid;
      else hi = mid;
    }
    return (((lo + hi) / 2) * 100).toFixed(2);
  }

  portfolios: ApiClient['portfolios'] = {
    list: () => this.run((s) => s.portfolios),
    holdings: (pfId) => this.run((s) => this.holdings(s, pfId).list),
    holding: (pfId, symbol) =>
      this.run((s) => {
        const { list, state } = this.holdings(s, pfId);
        const holding = list.find((h) => h.symbol === symbol);
        if (!holding) throw new ApiError('NOT_FOUND', 404, 'Holding not found', symbol);
        const txns = this.ledger(s, pfId).flatMap((e) => (e.kind === 'txn' && e.txn.symbol === symbol ? [e.txn] : []));
        return {
          holding,
          lots: state.positions.get(symbol)?.lots ?? [],
          transactions: txns.reverse(),
          dividends: (s.dividends.get(pfId) ?? []).filter((d) => d.symbol === symbol),
        };
      }),
    transactions: (pfId, f = {}) =>
      this.run((s) =>
        this.ledger(s, pfId)
          .flatMap((e) => (e.kind === 'txn' ? [e.txn] : []))
          .filter((t) => (!f.symbol || t.symbol === f.symbol) && (!f.type || t.type === f.type) && (!f.from || t.tradeDate >= f.from) && (!f.to || t.tradeDate <= f.to))
          .reverse(),
      ),
    cashMovements: (pfId) =>
      this.run((s) =>
        this.ledger(s, pfId)
          .map((e) =>
            e.kind === 'cash'
              ? e.cash
              : e.txn.type === 'BUY' || e.txn.type === 'SELL'
                ? { id: `cm-${e.txn.id}`, portfolioId: pfId, date: e.txn.tradeDate, type: e.txn.type === 'BUY' ? ('TRADE_DEBIT' as const) : ('TRADE_CREDIT' as const), amount: e.txn.netAmount, description: `${e.txn.type} ${e.txn.quantity} ${e.txn.symbol} @ ${e.txn.price} (incl. fees)`, source: e.txn.source }
                : null,
          )
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .reverse(),
      ),
    resetPaper: (pfId, token) =>
      this.run((s) => {
        this.requireStepUp(s, token);
        const pf = this.portfolio(s, pfId);
        if (pf.kind !== 'PAPER') throw new ApiError('INVALID_STATE', 409, 'Only paper portfolios can be reset');
        s.ledgers.set(pfId, [{ kind: 'cash', cash: { id: this.id('cash'), portfolioId: pfId, date: DEMO_TODAY, type: 'DEPOSIT', amount: pf.initialCash ?? '1000000.00', description: 'Paper reset', source: 'SIMULATED' } }]);
        s.ledgerVersion.set(pfId, (s.ledgerVersion.get(pfId) ?? 0) + 1);
        s.orders = s.orders.filter((o) => o.portfolioId !== pfId);
        return pf;
      }),
  };

  orders: ApiClient['orders'] = {
    preview: (req) =>
      this.run((s) => {
        const o = this.buildPreview(s, req);
        s.orders.unshift(o);
        return o;
      }),
    approve: (id, { previewHash, stepUpToken }) =>
      this.run((s) => {
        this.expireStale(s);
        const o = this.order(s, id);
        this.requireStepUp(s, stepUpToken);
        if (o.status === 'EXPIRED') throw new ApiError('PREVIEW_EXPIRED', 409, 'Preview expired', 'Create a new preview; prices and checks may have changed.');
        if (o.status !== 'PREVIEWED') throw new ApiError('INVALID_STATE', 409, 'Order cannot be approved', `Status is ${o.status}`);
        if (o.previewHash !== previewHash) throw new ApiError('PREVIEW_MISMATCH', 409, 'Preview changed', 'Approval must match the exact previewed order.');
        const now = this.iso();
        o.riskChecks = this.riskChecks(s, o);
        if (!o.riskChecks.every((c) => c.passed)) {
          o.status = 'REJECTED_BY_RISK';
          o.updatedAt = now;
          o.events.push(this.event('REJECTED_BY_RISK', 'SYSTEM', 'Risk checks failed on re-check at approval', now));
          throw new ApiError('RISK_CHECK_FAILED', 422, 'Risk checks failed', o.riskChecks.filter((c) => !c.passed).map((c) => c.rule).join(', '));
        }
        o.status = 'APPROVED';
        o.updatedAt = now;
        o.events.push(this.event('APPROVED', 'USER', 'Approved with step-up (TOTP); risk checks re-run and passed', now));
        if (o.mode === 'PAPER') {
          o.status = 'SUBMITTED';
          o.events.push(this.event('SUBMITTED', 'SYSTEM', 'Sent to paper broker', now));
          const px = o.limitPrice ?? paisaToString(s.quotes.get(o.symbol)!.last);
          this.applyFill(s, o, o.quantity, px, now, 'SIMULATED', 'Simulated paper fill');
        } else {
          o.status = 'AWAITING_MANUAL_PLACEMENT';
          o.events.push(this.event('AWAITING_MANUAL_PLACEMENT', 'SYSTEM', 'Manual ticket issued — place this order in the KTrade app', now));
        }
        return o;
      }),
    markPlaced: (id, { brokerOrderRef }) =>
      this.run((s) => {
        const o = this.order(s, id);
        if (o.status !== 'AWAITING_MANUAL_PLACEMENT') throw new ApiError('INVALID_STATE', 409, 'Order is not awaiting placement', `Status is ${o.status}`);
        o.status = 'PLACED_BY_USER';
        o.brokerOrderRef = brokerOrderRef?.trim() || null;
        o.updatedAt = this.iso();
        o.events.push(this.event('PLACED_BY_USER', 'USER', `You marked the order as placed in KTrade${o.brokerOrderRef ? ` (ref ${o.brokerOrderRef})` : ''}. Not executed until a fill is recorded.`, o.updatedAt));
        return o;
      }),
    recordFill: (id, fill) =>
      this.run((s) => {
        const o = this.order(s, id);
        if (!['PLACED_BY_USER', 'AWAITING_MANUAL_PLACEMENT', 'PARTIALLY_FILLED'].includes(o.status)) throw new ApiError('INVALID_STATE', 409, 'Cannot record a fill', `Status is ${o.status}`);
        if (!/^\d+$/.test(fill.quantity) || Dec.of(fill.quantity).lte(0)) throw new ApiError('VALIDATION_FAILED', 422, 'Invalid fill', 'Quantity must be a whole number > 0');
        if (!/^\d+(\.\d{1,4})?$/.test(fill.price) || Dec.of(fill.price).lte(0)) throw new ApiError('VALIDATION_FAILED', 422, 'Invalid fill', 'Price must be positive');
        const remaining = Dec.of(o.quantity).sub(o.filledQuantity);
        if (Dec.of(fill.quantity).gt(remaining)) throw new ApiError('VALIDATION_FAILED', 422, 'Invalid fill', `Only ${remaining.toString()} shares remain unfilled`);
        if (o.status === 'AWAITING_MANUAL_PLACEMENT') {
          o.status = 'PLACED_BY_USER';
          o.events.push(this.event('PLACED_BY_USER', 'USER', 'Implicitly marked placed when the fill was recorded', this.iso()));
        }
        this.applyFill(s, o, fill.quantity, fill.price, fill.executedAt, 'USER_REPORTED', `Fill recorded by you: ${fill.quantity} @ ${fill.price} (user-reported until the contract note reconciles it)`);
        s.notifications.unshift({ id: this.id('n'), type: 'ORDER_EXECUTED', title: `${o.symbol} fill recorded`, body: `${fill.quantity} shares @ Rs ${fill.price} (user-reported).`, createdAt: this.iso(), read: false, channel: 'IN_APP', link: '/orders' });
        return o;
      }),
    cancel: (id) =>
      this.run((s) => {
        const o = this.order(s, id);
        const now = this.iso();
        if (['PREVIEWED', 'APPROVED', 'AWAITING_MANUAL_PLACEMENT'].includes(o.status)) {
          o.status = 'CANCELLED';
          o.events.push(this.event('CANCELLED', 'USER', 'Cancelled before placement — nothing was sent to KTrade', now));
        } else if (['PLACED_BY_USER', 'PARTIALLY_FILLED', 'SUBMITTED', 'ACCEPTED'].includes(o.status)) {
          if (o.mode === 'PAPER') {
            o.status = 'CANCELLED';
            o.events.push(this.event('CANCELLED', 'SYSTEM', 'Paper order cancelled', now));
          } else {
            o.status = 'CANCEL_REQUESTED';
            o.events.push(this.event('CANCEL_REQUESTED', 'USER', 'Cancel requested — cancel it in the KTrade app too; status becomes CANCELLED once confirmed', now));
          }
        } else {
          throw new ApiError('INVALID_STATE', 409, 'Order cannot be cancelled', `Status is ${o.status}`);
        }
        o.updatedAt = now;
        return o;
      }),
    list: (f = {}) =>
      this.run((s) => {
        this.expireStale(s);
        return s.orders.filter((o) => (!f.status || o.status === f.status) && (!f.mode || o.mode === f.mode) && (!f.symbol || o.symbol === f.symbol));
      }),
    get: (id) =>
      this.run((s) => {
        this.expireStale(s);
        return this.order(s, id);
      }),
    feeEstimate: (q) => this.run(() => estimateFees(q.side, q.quantity, q.price)),
    riskLimits: (pfId) => this.run((s) => s.riskLimits.get(this.portfolio(s, pfId).id)!),
    updateRiskLimits: (limits, token) =>
      this.run((s) => {
        this.requireStepUp(s, token);
        s.riskLimits.set(limits.portfolioId, { ...limits, liveAutoExecutionEnabled: false });
        return s.riskLimits.get(limits.portfolioId)!;
      }),
  };

  market: ApiClient['market'] = {
    stocks: (q = {}) =>
      this.run(() =>
        DEMO_UNIVERSE.filter((st) => (!q.sector || st.sector === q.sector) && (!q.search || `${st.symbol} ${st.name}`.toLowerCase().includes(q.search.toLowerCase()))).map((st) => this.stockOf(st.symbol)),
      ),
    stock: (symbol) => this.run(() => this.stockOf(symbol)),
    quotes: (symbols) => this.run((s) => (symbols?.length ? symbols : [...s.quotes.keys()]).filter((x) => s.quotes.has(x)).map((x) => this.quote(s, x))),
    candles: (symbol, q = {}) =>
      this.run((s) => {
        const bars = barsFor(symbol);
        if (!bars.length) throw new ApiError('NOT_FOUND', 404, 'Unknown symbol', symbol);
        const live = s.quotes.get(symbol)!;
        const withLive: RawBar[] = [...bars.slice(0, -1), { ...bars[bars.length - 1], close: live.last, high: live.high, low: live.low, volume: live.volume }];
        return {
          symbol,
          interval: 'D1' as const,
          source: PRICE_SOURCE,
          candles: withLive
            .filter((b) => (!q.from || b.date >= q.from) && (!q.to || b.date <= q.to))
            .map((b) => ({ time: b.date, open: paisaToString(b.open), high: paisaToString(b.high), low: paisaToString(b.low), close: paisaToString(b.close), volume: String(b.volume) })),
        };
      }),
    movers: (type, limit = 10) =>
      this.run((s) => {
        const qs = [...s.quotes.keys()].map((x) => this.quote(s, x));
        const sorted = type === 'active' ? qs.sort((a, b) => Dec.of(b.volume).mul(b.last).cmp(Dec.of(a.volume).mul(a.last))) : qs.sort((a, b) => (type === 'gainers' ? Dec.of(b.changePct).cmp(a.changePct) : Dec.of(a.changePct).cmp(b.changePct)));
        return sorted.slice(0, limit);
      }),
    providers: () => this.run((s) => s.providers),
    watchlists: () => this.run((s) => s.watchlists),
    createWatchlist: (name) =>
      this.run((s) => {
        const w = { id: this.id('wl'), name: name.trim() || 'Untitled', symbols: [] };
        s.watchlists.push(w);
        return w;
      }),
    addToWatchlist: (wid, symbol) =>
      this.run((s) => {
        const w = s.watchlists.find((x) => x.id === wid);
        if (!w) throw new ApiError('NOT_FOUND', 404, 'Watchlist not found');
        if (!findSeed(symbol)) throw new ApiError('NOT_FOUND', 404, 'Unknown symbol', symbol);
        if (!w.symbols.includes(symbol)) w.symbols.push(symbol);
        return w;
      }),
    removeFromWatchlist: (wid, symbol) =>
      this.run((s) => {
        const w = s.watchlists.find((x) => x.id === wid);
        if (!w) throw new ApiError('NOT_FOUND', 404, 'Watchlist not found');
        w.symbols = w.symbols.filter((x) => x !== symbol);
        return w;
      }),
    subscribeQuotes: (symbols, onTick) => {
      const l = { symbols: new Set(symbols), cb: onTick };
      this.listeners.add(l);
      if (!this.timer && this.tickMs > 0) this.timer = setInterval(() => this.tick(), this.tickMs);
      return () => {
        this.listeners.delete(l);
        if (!this.listeners.size && this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
      };
    },
  };

  /** Exposed for tests: advance the simulated quote stream by one tick. */
  tickOnce(): void {
    this.tick();
  }

  private stockOf(symbol: string): Stock {
    const seed = findSeed(symbol);
    if (!seed) throw new ApiError('NOT_FOUND', 404, 'Unknown symbol', symbol);
    const s = this.state();
    const shares = Dec.of(Math.round(seed.sharesM * 1000)).mul(1000);
    const h = (seed.symbol.charCodeAt(0) * 7 + seed.symbol.length * 13) % 100;
    return {
      symbol,
      name: seed.name,
      sector: seed.sector,
      lotSize: 1,
      marketCap: shares.mul(this.last(s, symbol)).toFixed(0),
      sharesOutstanding: shares.toFixed(0),
      freeFloatPct: Dec.of(15 + (h % 60)).toFixed(0),
      peRatio: h % 9 === 0 ? null : Dec.of(30 + (h % 90)).div(10).toFixed(1),
      dividendYieldPct: h % 5 === 0 ? null : Dec.of(10 + (h % 120)).div(10).toFixed(1),
      source: 'SIMULATED',
    };
  }

  strategies: ApiClient['strategies'] = {
    templates: () => this.run(() => STRATEGY_TEMPLATES),
    list: () => this.run((s) => s.strategies),
    create: (input) =>
      this.run((s) => {
        if (!input.symbols.length) throw new ApiError('VALIDATION_FAILED', 422, 'Pick at least one symbol');
        if (input.mode === 'LIVE' && input.autoExecute) throw new ApiError('CAPABILITY_UNAVAILABLE', 409, 'Auto-execution unavailable for live', 'Live strategies only prepare orders for manual approval.');
        const st: Strategy = { ...input, id: this.id('st'), active: false, version: 1, createdAt: this.iso(), lastEvaluatedAt: null };
        s.strategies.push(st);
        return st;
      }),
    setActive: (id, active) =>
      this.run((s) => {
        const st = s.strategies.find((x) => x.id === id);
        if (!st) throw new ApiError('NOT_FOUND', 404, 'Strategy not found');
        st.active = active;
        if (active) {
          st.lastEvaluatedAt = this.iso();
          s.signals = [...this.buildSignals([st]).filter((n) => !s.signals.some((o) => o.id === n.id)), ...s.signals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        }
        return st;
      }),
    signals: (q = {}) => this.run((s) => s.signals.filter((x) => !q.strategyId || x.strategyId === q.strategyId)),
    dismissSignal: (id) =>
      this.run((s) => {
        const sig = s.signals.find((x) => x.id === id);
        if (!sig) throw new ApiError('NOT_FOUND', 404, 'Signal not found');
        sig.status = 'DISMISSED';
        return sig;
      }),
  };

  backtests: ApiClient['backtests'] = {
    run: (req) =>
      this.run((s) => {
        if (!findSeed(req.symbol)) throw new ApiError('NOT_FOUND', 404, 'Unknown symbol', req.symbol);
        if (req.from >= req.to) throw new ApiError('VALIDATION_FAILED', 422, 'Invalid period', '“From” must be before “to”.');
        const bt = runBacktest(this.id('bt'), this.iso(), req, barsFor(req.symbol));
        s.backtests.unshift(bt);
        return bt;
      }),
    list: () => this.run((s) => s.backtests.map((b) => ({ ...b, equityCurve: [], trades: [] }))),
    get: (id) =>
      this.run((s) => {
        const b = s.backtests.find((x) => x.id === id);
        if (!b) throw new ApiError('NOT_FOUND', 404, 'Backtest not found');
        return b;
      }),
  };

  dividends: ApiClient['dividends'] = {
    list: (pfId) => this.run((s) => [...(s.dividends.get(this.portfolio(s, pfId).id) ?? [])].sort((a, b) => b.exDate.localeCompare(a.exDate))),
  };

  analytics: ApiClient['analytics'] = {
    performance: (pfId, period) =>
      this.run((s) => {
        const pts = this.series(s, pfId);
        const key = (d: string) => {
          if (period === 'day') return d;
          if (period === 'month') return d.slice(0, 7);
          if (period === 'year') return d.slice(0, 4);
          const dt = new Date(`${d}T00:00:00Z`);
          const monday = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86_400_000);
          return `Wk of ${monday.toISOString().slice(0, 10)}`;
        };
        const groups = new Map<string, DayPoint[]>();
        for (const p of pts) {
          const k = key(p.date);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k)!.push(p);
        }
        const rows: PerformanceRow[] = [];
        let prevEnd: Dec | null = null;
        for (const [k, g] of groups) {
          const start: Dec = prevEnd ?? g[0].value.sub(g[0].flow);
          const end = g[g.length - 1].value;
          const flows = Dec.sum(g.map((p) => p.flow));
          const pnl = end.sub(start).sub(flows);
          const base = start.add(flows);
          rows.push({ period: k, startValue: start.toFixed(2), endValue: end.toFixed(2), netFlows: flows.toFixed(2), pnl: pnl.toFixed(2), returnPct: base.isZero() ? '0.00' : pnl.div(base).mul(100).toFixed(2), source: PRICE_SOURCE });
          prevEnd = end;
        }
        const limit = period === 'day' ? 20 : period === 'week' ? 12 : period === 'month' ? 12 : 5;
        return rows.slice(-limit).reverse();
      }),
    realizedUnrealized: (pfId) =>
      this.run((s) => {
        const { list, state } = this.holdings(s, pfId);
        const bySymbol = [...state.positions.values()].map((p) => ({ symbol: p.symbol, realized: p.realized.toFixed(2), unrealized: list.find((h) => h.symbol === p.symbol)?.unrealizedPnl ?? '0.00' }));
        return {
          realized: { value: Dec.sum(bySymbol.map((b) => b.realized)).toFixed(2), source: 'SIMULATED' as const },
          unrealized: { value: Dec.sum(bySymbol.map((b) => b.unrealized)).toFixed(2), source: 'SIMULATED' as const },
          bySymbol: bySymbol.sort((a, b) => Dec.of(b.realized).add(b.unrealized).cmp(Dec.of(a.realized).add(a.unrealized))),
        };
      }),
    feesTaxes: (pfId) =>
      this.run((s) => {
        const acc = new Map<string, { est: Dec; conf: Dec }>();
        const add = (c: string, v: Dec, confirmed: boolean) => {
          const cur = acc.get(c) ?? { est: Dec.zero(), conf: Dec.zero() };
          if (confirmed) cur.conf = cur.conf.add(v);
          else cur.est = cur.est.add(v);
          acc.set(c, cur);
        };
        for (const e of this.ledger(s, pfId)) {
          if (e.kind === 'txn' && (e.txn.type === 'BUY' || e.txn.type === 'SELL')) {
            const est = estimateFees(e.txn.type, e.txn.quantity, e.txn.price);
            for (const f of est.fees) add(f.component, Dec.of(f.amount), e.txn.source === 'BROKER_CONFIRMED');
          } else if (e.kind === 'cash' && e.cash.type === 'TAX') {
            add('DIVIDEND_WHT', Dec.of(e.cash.amount).neg(), e.cash.source === 'BROKER_CONFIRMED');
          }
        }
        const rows = [...acc.entries()].map(([component, v]) => ({ component: component as never, estimated: v.est.toFixed(2), confirmed: v.conf.toFixed(2) }));
        return { rows, totalEstimated: Dec.sum(rows.map((r) => r.estimated)).toFixed(2), totalConfirmed: Dec.sum(rows.map((r) => r.confirmed)).toFixed(2) };
      }),
  };

  reports: ApiClient['reports'] = {
    create: ({ type, format }) =>
      this.run((s) => {
        const r: Report = { id: this.id('rep'), type, format, status: 'SUCCEEDED', createdAt: this.iso(), fileName: `${type.toLowerCase()}-${DEMO_TODAY}.${format.toLowerCase()}`, note: 'Demo: the report job is simulated and no file is generated. The live API returns a short-lived signed download link.' };
        s.reports.unshift(r);
        return r;
      }),
    list: () => this.run((s) => s.reports),
  };

  notifications: ApiClient['notifications'] = {
    list: (q = {}) => this.run((s) => s.notifications.filter((n) => !q.unread || !n.read)),
    markRead: (id) =>
      this.run((s) => {
        const n = s.notifications.find((x) => x.id === id);
        if (n) n.read = true;
      }),
    markAllRead: () =>
      this.run((s) => {
        s.notifications.forEach((n) => (n.read = true));
      }),
    alerts: () => this.run((s) => s.alerts),
    setAlertActive: (id, active) =>
      this.run((s) => {
        const a = s.alerts.find((x) => x.id === id);
        if (!a) throw new ApiError('NOT_FOUND', 404, 'Alert not found');
        a.active = active;
        return a;
      }),
  };

  assistant: ApiClient['assistant'] = {
    history: () => this.run((s) => s.assistant),
    send: (text) =>
      this.run((s) => {
        const user: AssistantMessage = { id: this.id('msg'), role: 'USER', content: text, createdAt: this.iso(), toolCalls: [], citations: [], demo: false };
        const reply = this.cannedReply(s, text);
        s.assistant.push(user, reply);
        return [user, reply];
      }),
  };

  private cannedReply(s: State, text: string): AssistantMessage {
    const t = text.toLowerCase();
    const base = { id: this.id('msg'), role: 'ASSISTANT' as const, createdAt: this.iso(), demo: true };
    const { list, state } = this.holdings(s, LIVE_PORTFOLIO_ID);
    const mv = Dec.sum(list.map((h) => h.marketValue));
    const fmt = (d: Dec) => d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (/shock|drop|fall|what if|crash/.test(t)) {
      const sym = list.find((h) => t.includes(h.symbol.toLowerCase()))?.symbol ?? list[0]?.symbol ?? 'OGDC';
      const pctMatch = /(\d{1,2})\s*%/.exec(t);
      const pct = pctMatch ? pctMatch[1] : '10';
      const h = list.find((x) => x.symbol === sym);
      const impact = h ? Dec.of(h.marketValue).mul(pct).div(100).neg() : Dec.zero();
      const total = mv.add(state.cash);
      return { ...base, content: `If ${sym} fell ${pct}% from the current simulated price, your position would lose about Rs ${fmt(impact.abs())} — ${total.isZero() ? '0.00' : impact.abs().div(total).mul(100).toFixed(2)}% of account value. This is a simple linear shock: it ignores correlation with other holdings and fees.`, toolCalls: [{ name: 'simulate_price_shock', args: { symbol: sym, pct: `-${pct}` }, digest: `position MV Rs ${h ? fmt(Dec.of(h.marketValue)) : '0'}` }], citations: [{ label: `${sym} holding`, href: '/holdings' }] };
    }
    if (/dividend/.test(t)) {
      const divs = s.dividends.get(LIVE_PORTFOLIO_ID) ?? [];
      const upcoming = divs.filter((d) => d.status === 'ANNOUNCED' || d.status === 'ENTITLED');
      return { ...base, content: `You have received Rs ${fmt(state.dividends)} in gross dividends (simulated ledger). Upcoming/entitled: ${upcoming.map((d) => `${d.symbol} Rs ${d.perShare}/share (${d.status.toLowerCase()})`).join(', ') || 'none'}. Withholding tax is shown at a placeholder 15% filer rate that has not been verified.`, toolCalls: [{ name: 'get_dividends', args: { portfolioId: LIVE_PORTFOLIO_ID }, digest: `${divs.length} records` }], citations: [{ label: 'Dividends', href: '/dividends' }, { label: 'Tax-rate settings', href: '/settings' }] };
    }
    if (/signal|strategy|why/.test(t)) {
      const sig = s.signals[0];
      if (sig) return { ...base, content: `Latest signal: ${sig.type} ${sig.symbol} from “${sig.strategyName}”. Why: ${sig.explanation}. Confidence ${sig.score}/100 (${sig.scoreComponents.map((c) => `${c.label} ${c.points}/${c.max}`).join('; ')}). I can explain signals but cannot create or approve orders.`, toolCalls: [{ name: 'explain_signal', args: { id: sig.id }, digest: `${sig.trace.length} conditions` }], citations: [{ label: 'Strategies & signals', href: '/strategies' }] };
    }
    if (/buy|sell|order|suggest/.test(t)) {
      const sym = list[list.length - 1]?.symbol ?? 'HUBC';
      return { ...base, content: `Here is a draft you can open and review — I created nothing. It goes through the normal preview, 12 risk checks and your TOTP approval, then you place it yourself in KTrade. Draft: BUY 50 ${sym} (market).`, toolCalls: [{ name: 'draft_order_suggestion', args: { symbol: sym, side: 'BUY', quantity: '50' }, digest: 'prefilled preview link only' }], citations: [{ label: `Open draft ticket for ${sym}`, href: `/trade?symbol=${sym}&side=BUY&qty=50` }] };
    }
    if (/portfolio|summary|summar|holding|how am i|performance/.test(t)) {
      const unreal = Dec.sum(list.map((h) => h.unrealizedPnl));
      const top = list.slice(0, 3).map((h) => `${h.symbol} ${Dec.of(h.weight).mul(100).toFixed(1)}%`).join(', ');
      return { ...base, content: `Account value is Rs ${fmt(mv.add(state.cash))} (Rs ${fmt(mv)} in ${list.length} holdings + Rs ${fmt(state.cash)} cash). Unrealized P&L is Rs ${fmt(unreal)}. Largest weights: ${top}. All prices are SIMULATED.`, toolCalls: [{ name: 'get_portfolio_summary', args: { portfolioId: LIVE_PORTFOLIO_ID }, digest: `${list.length} holdings` }, { name: 'get_holdings', args: { portfolioId: LIVE_PORTFOLIO_ID }, digest: 'weights, P&L' }], citations: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Holdings', href: '/holdings' }] };
    }
    return { ...base, content: 'Demo mode understands a few prompts: “summarise my portfolio”, “dividends”, “what if OGDC drops 10%”, “explain the latest signal”, “suggest an order”. With a configured LLM provider and opt-in, the assistant uses read-only tools over your data.', toolCalls: [], citations: [{ label: 'Assistant settings', href: '/settings' }] };
  }

  broker: ApiClient['broker'] = {
    connections: () => this.run((s) => s.connections),
    imports: () => this.run((s) => s.imports),
    importRows: (id) => this.run((s) => s.importRows.get(id) ?? []),
    upload: ({ fileName, kind, size }) =>
      this.run((s) => {
        if (s.imports.some((b) => b.fileName === fileName)) throw new ApiError('DUPLICATE_IMPORT', 409, 'Duplicate import', `${fileName} was already imported (same file hash).`);
        if (size > 20 * 1024 * 1024) throw new ApiError('VALIDATION_FAILED', 422, 'File too large', 'Max 20 MB');
        const id = this.id('imp');
        const detected = kind ?? (/contract/i.test(fileName) ? 'CONTRACT_NOTE' : /cdc/i.test(fileName) ? 'CDC_STATEMENT' : /\.csv$/i.test(fileName) ? 'GENERIC_TRANSACTIONS_CSV' : 'LEDGER_STATEMENT');
        const rows: ImportRow[] = ['OGDC', 'HUBC'].map((sym, i) => ({ id: `${id}-r${i + 1}`, rowNo: i + 1, status: 'VALID', tradeDate: daysAgo(2 + i), symbol: sym, side: 'BUY', quantity: '25', price: paisaToString(s.quotes.get(sym)!.prevClose), contractRef: `DEMO-${i + 1}`, message: 'Demo parser output (file contents are not read in demo mode)' }));
        s.importRows.set(id, rows);
        const b: ImportBatch = { id, kind: detected, channel: 'UPLOAD', fileName, status: 'AWAITING_REVIEW', uploadedAt: this.iso(), rowCounts: { VALID: rows.length } };
        s.imports.unshift(b);
        return b;
      }),
    commitImport: (id) =>
      this.run((s) => {
        const b = s.imports.find((x) => x.id === id);
        if (!b || b.status !== 'AWAITING_REVIEW') throw new ApiError('INVALID_STATE', 409, 'Import is not awaiting review');
        b.status = 'COMMITTED';
        const rows = s.importRows.get(id) ?? [];
        const committed = rows.filter((r) => r.status === 'VALID').length;
        rows.forEach((r) => {
          if (r.status === 'VALID') r.status = 'COMMITTED';
          else if (r.status === 'INVALID' || r.status === 'DUPLICATE') r.status = 'SKIPPED';
        });
        b.rowCounts = { COMMITTED: committed, SKIPPED: rows.length - committed };
        return b;
      }),
    rejectImport: (id) =>
      this.run((s) => {
        const b = s.imports.find((x) => x.id === id);
        if (!b || b.status !== 'AWAITING_REVIEW') throw new ApiError('INVALID_STATE', 409, 'Import is not awaiting review');
        b.status = 'REJECTED';
        return b;
      }),
    mailbox: () => this.run((s) => s.mailbox),
    discrepancies: () => this.run((s) => s.discrepancies),
  };

  security: ApiClient['security'] = {
    overview: () =>
      this.run(() => ({
        twoFactorEnabled: true,
        passwordUpdatedAt: `${daysAgo(60)}T05:00:00Z`,
        recentEvents: [
          { id: 'ae-1', at: `${daysAgo(0)}T04:42:00Z`, action: 'order.approve', actor: 'USER' as const, detail: 'Step-up verified; LUCK BUY approved' },
          { id: 'ae-2', at: `${daysAgo(3)}T04:00:00Z`, action: 'auth.login', actor: 'USER' as const, detail: 'Login with TOTP from Chrome on Windows' },
          { id: 'ae-3', at: `${daysAgo(9)}T03:00:00Z`, action: 'sync.import.commit', actor: 'WORKER' as const, detail: 'Contract note auto-committed (1 trade)' },
          { id: 'ae-4', at: `${daysAgo(30)}T04:00:00Z`, action: 'killswitch.update', actor: 'USER' as const, detail: 'Live order preparation enabled' },
        ],
      })),
    sessions: () => this.run((s) => s.sessions),
    revokeSession: (id) =>
      this.run((s) => {
        const ses = s.sessions.find((x) => x.id === id);
        if (ses?.current) throw new ApiError('INVALID_STATE', 409, 'Use sign out to end the current session');
        s.sessions = s.sessions.filter((x) => x.id !== id);
      }),
    revokeAllSessions: () =>
      this.run((s) => {
        s.sessions = s.sessions.filter((x) => x.current);
      }),
    destroyAll: (token) =>
      this.run((s) => {
        this.requireStepUp(s, token);
        s.sessions = s.sessions.filter((x) => x.current);
        s.mailbox = { ...s.mailbox, connected: false, address: null };
        s.killSwitch = { liveTradingEnabled: false, reason: 'Destroy-all executed', updatedAt: this.iso() };
      }),
  };

  settings: ApiClient['settings'] = {
    feeSchedules: () => this.run(() => seedFeeSchedules()),
    taxRates: () => this.run(() => seedTaxRates()),
    channels: () => this.run((s) => s.channels),
    updateChannel: (c) =>
      this.run((s) => {
        const configured = c.channel === 'IN_APP' || c.target.trim().length > 0;
        const next = { ...c, configured, enabled: c.enabled && configured };
        s.channels = s.channels.map((x) => (x.channel === c.channel ? next : x));
        return next;
      }),
    testChannel: (channel) =>
      this.run((s) => {
        const c = s.channels.find((x) => x.channel === channel);
        return c?.configured ? { ok: true, message: `Demo: a test ${channel.toLowerCase()} message would be sent to ${c.target}. Nothing was sent.` } : { ok: false, message: 'Channel is not configured' };
      }),
    user: () => this.run((s) => s.userSettings),
    updateUser: (u) =>
      this.run((s) => {
        s.userSettings = { ...u };
        return s.userSettings;
      }),
  };
}

export { BACKTEST_DISCLAIMER };

let browserClient: DemoApiClient | null = null;
/** One demo client per browser tab (state survives client-side navigation). */
export function getDemoClient(): DemoApiClient {
  if (typeof window === 'undefined') return new DemoApiClient();
  browserClient ??= new DemoApiClient();
  return browserClient;
}
