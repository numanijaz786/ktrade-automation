/**
 * Pure mappers: NestJS API response shapes (apps/api/src/**) → web types (`../types`).
 *
 * The API is the source of truth. Rules:
 *  - a field the API omits or returns as null stays null here; nothing is invented or zero-filled;
 *  - provenance (`source`) is copied, never upgraded;
 *  - decimals stay strings; conversions use `Dec` (never JS floats).
 */
import type {
  BrokerAdapterKind,
  ConnectionStatus,
  DataSource,
  ExecutionMode,
  FeeComponent,
  OrderOrigin,
  OrderSide,
  OrderStatus,
  OrderType,
  PortfolioKind,
  CostBasisMethod,
  ActorType,
  Role,
  TransactionType,
  PriceInterval,
  RunStatus,
  SignalReason,
  SignalStatus,
  SignalType,
  StrategyType,
  NotificationChannel,
  NotificationStatus,
} from '@ktrade/shared';
import { Dec } from '../../decimal';
import { ApiError, type FieldError } from '../errors';
import type {
  Alert,
  AlertEvaluation,
  AlertInput,
  AlertKind,
  AlertUpdate,
  Notification,
  NotificationPage,
  PerformanceRange,
  PnlBasis,
  PnlFigure,
  PortfolioPerformance,
  SnapshotBackfillResult,
  BrokerConnection,
  Capability,
  CapabilityState,
  CandleSeries,
  DashboardSummary,
  ImportRow,
  MarketOverview,
  Order,
  Portfolio,
  Quote,
  RiskCheck,
  RiskLimits,
  Session,
  StepUpToken,
  StockDetail,
  StockPage,
  Transaction,
  User,
  Watchlist,
  Holding,
  Backtest,
  BacktestComparison,
  BacktestMetrics,
  BacktestTrade,
  BacktestTrades,
  DryRunSignal,
  OverlayTraceEntry,
  Signal,
  SignalTrace,
  Strategy,
  StrategyDefinition,
  StrategyEvaluation,
  StrategyInput,
  StrategyTemplate,
  StrategyUpdate,
  StrategyValidation,
  TemplateParam,
} from '../types';

// ─── problem+json ──────────────────────────────────────────────────────────

export interface ProblemDocument {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  requestId?: string;
  errors?: FieldError[];
}

/** RFC 9457 body (or anything else) → ApiError. Unknown bodies keep the HTTP status. */
export function problemToApiError(status: number, body: unknown): ApiError {
  const p = (body && typeof body === 'object' ? body : {}) as ProblemDocument;
  const code =
    typeof p.code === 'string' && p.code ? p.code : status === 401 ? 'UNAUTHENTICATED' : 'BAD_RESPONSE';
  const title = typeof p.title === 'string' && p.title ? p.title : `HTTP ${status}`;
  const detail = typeof p.detail === 'string' && p.detail ? p.detail : undefined;
  const errors = Array.isArray(p.errors)
    ? p.errors.filter(
        (e): e is FieldError => !!e && typeof e.path === 'string' && typeof e.message === 'string',
      )
    : [];
  return new ApiError(code, status, title, detail, {
    errors,
    requestId: typeof p.requestId === 'string' ? p.requestId : undefined,
  });
}

// ─── auth ──────────────────────────────────────────────────────────────────

export interface ApiUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  totpEnabled: boolean;
}

export function mapUser(u: ApiUser): User {
  return { id: u.id, email: u.email, displayName: u.displayName, role: u.role, totpEnabled: u.totpEnabled };
}

export function mapStepUp(r: { stepUpToken: string; expiresIn: number }, nowMs: number): StepUpToken {
  return { token: r.stepUpToken, expiresAt: new Date(nowMs + r.expiresIn * 1000).toISOString() };
}

export interface ApiSession {
  id: string;
  lastActiveAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export function mapSession(s: ApiSession): Session {
  return {
    id: s.id,
    device: s.userAgent ?? 'Unknown device',
    ip: s.ip,
    location: null,
    createdAt: null,
    lastSeenAt: s.lastActiveAt,
    expiresAt: s.expiresAt,
    current: s.current,
  };
}

// ─── market data ───────────────────────────────────────────────────────────

/** `QuoteView` (QuoteDto + name/sector/stale). Optional decimals are omitted from JSON when unknown. */
export interface ApiQuote {
  symbol: string;
  name?: string;
  sector?: string | null;
  last: string;
  open?: string;
  prevClose?: string;
  high?: string;
  low?: string;
  volume?: string;
  change?: string;
  changePct?: string;
  asOf: string;
  delayMinutes: number;
  source: DataSource;
  providerKey?: string;
  stale?: boolean;
}

const orNull = <T>(v: T | undefined | null): T | null => (v === undefined ? null : v);

export function mapQuote(q: ApiQuote): Quote {
  return {
    symbol: q.symbol,
    name: q.name,
    sector: q.sector ?? null,
    last: q.last,
    open: orNull(q.open),
    high: orNull(q.high),
    low: orNull(q.low),
    prevClose: orNull(q.prevClose),
    change: orNull(q.change),
    changePct: orNull(q.changePct),
    volume: orNull(q.volume),
    asOf: q.asOf,
    delayMinutes: q.delayMinutes,
    source: q.source,
    providerKey: q.providerKey,
    stale: q.stale === true,
  };
}

const mapQuoteOrNull = (q: ApiQuote | null | undefined): Quote | null => (q ? mapQuote(q) : null);

export interface ApiStockPage {
  total: number;
  data: { symbol: string; name: string; sector: string | null; isShariah: boolean; quote: ApiQuote | null }[];
}

export function mapStockPage(p: ApiStockPage): StockPage {
  return {
    total: p.total,
    data: p.data.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      isShariah: s.isShariah,
      quote: mapQuoteOrNull(s.quote),
    })),
  };
}

export type ApiStockDetail = Omit<StockDetail, 'quote'> & { quote: ApiQuote | null };

export function mapStockDetail(s: ApiStockDetail): StockDetail {
  return { ...s, quote: mapQuoteOrNull(s.quote), stats: { ...s.stats } };
}

export type ApiOverview = Omit<MarketOverview, 'gainers' | 'losers' | 'mostActive'> & {
  gainers: ApiQuote[];
  losers: ApiQuote[];
  mostActive: ApiQuote[];
};

export function mapOverview(o: ApiOverview): MarketOverview {
  return {
    ...o,
    gainers: o.gainers.map(mapQuote),
    losers: o.losers.map(mapQuote),
    mostActive: o.mostActive.map(mapQuote),
  };
}

export interface ApiCandles {
  symbol: string;
  interval: PriceInterval;
  from: string;
  to: string;
  source: DataSource | null;
  bars: {
    ts: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    source: DataSource;
  }[];
}

export function mapCandles(c: ApiCandles): CandleSeries {
  return {
    symbol: c.symbol,
    interval: c.interval,
    from: c.from,
    to: c.to,
    source: c.source,
    candles: c.bars.map((b) => ({
      ts: b.ts,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      source: b.source,
    })),
  };
}

export interface ApiWatchlist {
  id: string;
  name: string;
  createdAt: string;
  items: { symbol: string; addedAt: string; quote: ApiQuote | null }[];
}

export function mapWatchlist(w: ApiWatchlist): Watchlist {
  return {
    id: w.id,
    name: w.name,
    createdAt: w.createdAt,
    items: w.items.map((i) => ({ symbol: i.symbol, addedAt: i.addedAt, quote: mapQuoteOrNull(i.quote) })),
  };
}

// ─── portfolio ─────────────────────────────────────────────────────────────

export interface ApiPortfolio {
  id: string;
  name: string;
  kind: PortfolioKind;
  costBasisMethod: CostBasisMethod;
  baseCurrency?: string;
  initialCash: string | null;
}

export function mapPortfolio(p: ApiPortfolio): Portfolio {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    costBasisMethod: p.costBasisMethod,
    initialCash: p.initialCash,
    demo: false,
  };
}

/** Provenance of ledger-derived figures, exactly as the API derives it (portfolio.service `ledgerSource`). */
export function ledgerSourceOf(kind: PortfolioKind | undefined): DataSource {
  return kind === 'PAPER' ? 'SIMULATED' : 'USER_REPORTED';
}

export interface ApiHolding {
  symbol: string;
  companyName: string;
  sector: string | null;
  quantity: string;
  avgCost: string;
  totalCost: string;
  lastPrice: { value: string; source: DataSource; asOf: string } | null;
  marketValue: { value: string; source: DataSource } | null;
  unrealizedPnl: { value: string; pct: string | null; source: DataSource } | null;
  realizedPnl: string;
  weightPct: string | null;
  lastConfirmed: string | null;
}

/** `weightPct` (percent) → `weight` (fraction), exact decimal division. */
export function mapHolding(h: ApiHolding, positionSource: DataSource): Holding {
  return {
    symbol: h.symbol,
    name: h.companyName,
    sector: h.sector,
    quantity: h.quantity,
    avgCost: h.avgCost,
    lastPrice: h.lastPrice
      ? { value: h.lastPrice.value, source: h.lastPrice.source, asOf: h.lastPrice.asOf }
      : null,
    totalCost: h.totalCost,
    marketValue: h.marketValue?.value ?? null,
    unrealizedPnl: h.unrealizedPnl?.value ?? null,
    unrealizedPnlPct: h.unrealizedPnl?.pct ?? null,
    realizedPnl: h.realizedPnl,
    weight: h.weightPct === null ? null : Dec.of(h.weightPct).div(100).toString(),
    dayChangePct: null,
    source: positionSource,
    lastConfirmed: h.lastConfirmed ? h.lastConfirmed.slice(0, 10) : null,
  };
}

export interface ApiTransaction {
  id: string;
  symbol: string;
  type: TransactionType;
  tradeDate: string;
  quantity: string;
  price: string;
  grossAmount: string;
  feesTotal: string;
  taxesTotal: string;
  netAmount: string;
  realizedPnl: string | null;
  source: DataSource;
  reversed: boolean;
  fees: { component: FeeComponent; amount: string; source: DataSource }[];
}

export function mapTransaction(t: ApiTransaction, portfolioId: string): Transaction {
  return {
    id: t.id,
    portfolioId,
    tradeDate: t.tradeDate,
    type: t.type,
    symbol: t.symbol,
    quantity: t.quantity,
    price: t.price,
    grossAmount: t.grossAmount,
    fees: t.feesTotal,
    taxes: t.taxesTotal,
    netAmount: t.netAmount,
    source: t.source,
    reference: null,
    orderId: null,
    reversed: t.reversed,
    realizedPnl: t.realizedPnl,
    feeLines: t.fees.map((f) => ({ component: f.component, amount: f.amount, source: f.source })),
  };
}

type ApiValue = { value: string | null; source?: DataSource; asOf?: string; note?: string };

export interface ApiSummary {
  portfolio: { id: string; name: string; kind: PortfolioKind };
  accountValue: { value: string; source: DataSource };
  portfolioValue: { value: string; source: DataSource };
  investedAmount: { value: string; source: DataSource };
  cash: {
    ledger: { value: string; source: DataSource };
    broker: { value: string; asOf: string; source: DataSource } | null;
  };
  realizedPnl: { value: string; source: DataSource };
  unrealizedPnl: { value: string; source: DataSource };
  totalReturnPct: ApiValue & { method?: string };
  todayPnl: ApiValue & {
    pct?: string | null;
    basis?: PnlBasis;
    tradingDate?: string;
    previousCloseDate?: string | null;
  };
  monthPnl: ApiValue & { basis?: PnlBasis; month?: string; sessions?: number };
  /** Older API builds omit it. */
  twrPct?: ApiValue & { method?: string; since?: string | null; asOf?: string | null; basis?: string };
  dividendsReceived: { value: string; source: DataSource };
  feesAndTaxes: { fees: string; taxes: string; source: DataSource };
  activeHoldings: number;
  pendingOrders: number;
  unpricedHoldings: number;
}

const sourcedOrNull = (v: ApiValue | undefined) =>
  v && v.value !== null && v.source ? { value: v.value, source: v.source, asOf: v.asOf, note: v.note } : null;

type ApiPnl = ApiValue & {
  basis?: PnlBasis;
  tradingDate?: string;
  previousCloseDate?: string | null;
  month?: string;
  sessions?: number;
};

function pnlFigure(v: ApiPnl | undefined): PnlFigure | null {
  const base = sourcedOrNull(v);
  if (!base || !v) return null;
  const out: PnlFigure = { ...base };
  if (v.basis) out.basis = v.basis;
  if (v.tradingDate) out.tradingDate = v.tradingDate;
  if (v.previousCloseDate !== undefined) out.previousCloseDate = v.previousCloseDate;
  if (v.month) out.month = v.month;
  if (v.sessions !== undefined) out.sessions = v.sessions;
  return out;
}

export function mapSummary(s: ApiSummary): DashboardSummary {
  const today = pnlFigure(s.todayPnl);
  const todayPct = s.todayPnl?.pct;
  return {
    portfolioId: s.portfolio.id,
    accountValue: { ...s.accountValue },
    investedAmount: { ...s.investedAmount },
    marketValue: { ...s.portfolioValue },
    cash: { ledger: { ...s.cash.ledger }, broker: s.cash.broker ? { ...s.cash.broker } : null },
    realizedPnl: { ...s.realizedPnl },
    unrealizedPnl: { ...s.unrealizedPnl },
    todayPnl: today,
    todayPnlPct: today && todayPct ? { value: todayPct, source: today.source } : null,
    monthPnl: pnlFigure(s.monthPnl),
    totalReturnPct: sourcedOrNull(s.totalReturnPct),
    twrPct: sourcedOrNull(s.twrPct),
    xirrPct: null,
    dividendsReceived: { ...s.dividendsReceived },
    feesPaid: { value: s.feesAndTaxes.fees, source: s.feesAndTaxes.source },
    taxesPaid: { value: s.feesAndTaxes.taxes, source: s.feesAndTaxes.source },
    activeHoldings: s.activeHoldings,
    pendingOrders: s.pendingOrders,
    unpricedHoldings: s.unpricedHoldings,
    sourceBreakdown: null,
    pricesAsOf: null,
    priceSource: s.portfolioValue.source,
    snapshotsNote: today ? null : (s.todayPnl?.note ?? null),
  };
}

export interface ApiRiskLimits {
  maxOrderValue: string;
  maxOrderQty: string;
  maxDailyTradedValue: string;
  maxDailyOrders: number;
  maxPositionPct: string;
  priceBandPct: string;
  maxDailyLossPct: string;
  allowMarketOrders: boolean;
  liveAutoExecutionEnabled: boolean;
}

export function mapRiskLimits(r: ApiRiskLimits, portfolioId: string): RiskLimits {
  return {
    portfolioId,
    maxOrderValue: r.maxOrderValue,
    maxOrderQty: r.maxOrderQty,
    priceBandPct: r.priceBandPct,
    maxDailyValue: r.maxDailyTradedValue,
    maxDailyCount: r.maxDailyOrders,
    maxPositionPct: r.maxPositionPct,
    maxDailyLossPct: r.maxDailyLossPct,
    allowMarketOrders: r.allowMarketOrders,
    liveAutoExecutionEnabled: r.liveAutoExecutionEnabled,
  };
}

/** Request body for `PUT /portfolios/:id/risk-limits` (liveAutoExecutionEnabled is not settable). */
export function toApiRiskLimits(l: RiskLimits): Omit<ApiRiskLimits, 'liveAutoExecutionEnabled'> {
  return {
    maxOrderValue: l.maxOrderValue,
    maxOrderQty: l.maxOrderQty,
    maxDailyTradedValue: l.maxDailyValue,
    maxDailyOrders: l.maxDailyCount,
    maxPositionPct: l.maxPositionPct,
    priceBandPct: l.priceBandPct,
    maxDailyLossPct: l.maxDailyLossPct,
    allowMarketOrders: l.allowMarketOrders,
  };
}

// ─── orders ────────────────────────────────────────────────────────────────

export interface ApiOrder {
  id: string;
  portfolioId: string;
  symbol: string;
  companyName: string;
  mode: ExecutionMode;
  origin: OrderOrigin;
  side: OrderSide;
  type: OrderType;
  quantity: string;
  limitPrice: string | null;
  stopPrice: string | null;
  referencePrice: { value: string; source: DataSource } | null;
  status: OrderStatus;
  filledQuantity: string;
  avgFillPrice: string | null;
  estimate: { notional: string | null; fees: string | null; total: string | null; source: 'ESTIMATED' };
  previewHash: string | null;
  previewExpiresAt: string | null;
  rejectionReason: string | null;
  brokerOrderRef: string | null;
  createdAt: string;
  // detail (`GET /orders/:id`, preview/approve/... responses)
  riskChecks?: {
    rule: string;
    passed: boolean;
    observed: string | null;
    limit: string | null;
    message: string;
  }[];
  events?: {
    from: OrderStatus | null;
    to: OrderStatus;
    actorType: ActorType;
    reason: string | null;
    at: string;
  }[];
  executions?: { quantity: string; price: string; executedAt: string; source: DataSource }[];
  warnings?: string[];
  // preview only
  executionPath?: Order['executionPath'];
  feeBreakdown?: { component: FeeComponent; amount: string; source: DataSource; note?: string }[];
}

export function mapOrder(o: ApiOrder): Order {
  const e = o.estimate;
  const estimate =
    e && e.notional !== null && e.fees !== null && e.total !== null
      ? {
          notional: e.notional,
          fees: (o.feeBreakdown ?? []).map((f) => ({
            component: f.component,
            amount: f.amount,
            source: f.source,
            note: f.note,
          })),
          totalFees: e.fees,
          total: e.total,
        }
      : null;
  return {
    id: o.id,
    portfolioId: o.portfolioId,
    mode: o.mode,
    status: o.status,
    // Deterministic in the API: paper fills automatically, live is always a manual ticket (ADR-021).
    executionPath: o.executionPath ?? (o.mode === 'PAPER' ? 'PAPER_AUTO' : 'MANUAL_TICKET'),
    symbol: o.symbol,
    companyName: o.companyName,
    side: o.side,
    type: o.type,
    quantity: o.quantity,
    limitPrice: o.limitPrice,
    stopPrice: o.stopPrice,
    timeInForce: null,
    origin: o.origin,
    referencePrice: o.referencePrice ? { ...o.referencePrice } : null,
    estimate,
    riskChecks: (o.riskChecks ?? []).map((r): RiskCheck => ({
      rule: r.rule as RiskCheck['rule'],
      passed: r.passed,
      observed: r.observed ?? undefined,
      limit: r.limit ?? undefined,
      message: r.message,
    })),
    previewHash: o.previewHash,
    previewExpiresAt: o.previewExpiresAt,
    warnings: o.warnings ?? [],
    createdAt: o.createdAt,
    rejectionReason: o.rejectionReason,
    brokerOrderRef: o.brokerOrderRef,
    filledQuantity: o.filledQuantity,
    avgFillPrice: o.avgFillPrice,
    events: (o.events ?? []).map((ev, i) => ({
      id: `${o.id}:ev${i}`,
      at: ev.at,
      status: ev.to,
      actor: ev.actorType,
      note: ev.reason ?? '',
    })),
    executions: (o.executions ?? []).map((x, i) => ({
      id: `${o.id}:fill${i}`,
      orderId: o.id,
      symbol: o.symbol,
      side: o.side,
      quantity: x.quantity,
      price: x.price,
      executedAt: x.executedAt,
      source: x.source,
    })),
  };
}

// ─── broker & imports ──────────────────────────────────────────────────────

export interface ApiBrokerAccount {
  id: string;
  brokerCode: string;
  displayName: string;
  clientCodeMasked: string | null;
  portfolios: { id: string; name: string }[];
  connections: {
    adapter: BrokerAdapterKind;
    status: ConnectionStatus;
    capabilities: Record<Capability, CapabilityState & { authorizationRef?: string | null }>;
    authorizationRef: string | null;
  }[];
}

const ADAPTER_TEXT: Partial<Record<BrokerAdapterKind, { label: string; description: string }>> = {
  MANUAL_IMPORT: {
    label: 'Statement & CSV import',
    description: 'Reads files you upload. Always available; it never contacts KTrade.',
  },
  KTRADE_OFFICIAL_API: {
    label: 'KTrade official API',
    description: 'Disabled: KTrade publishes no API. Enabled only with written authorisation.',
  },
  KTRADE_BROWSER: {
    label: 'KTrade browser automation',
    description: 'Pending written authorisation from KTrade. Login, OTP and orders are never automated.',
  },
};

export function mapConnections(accounts: ApiBrokerAccount[]): BrokerConnection[] {
  return accounts.flatMap((a) =>
    a.connections.map((c) => {
      const text = ADAPTER_TEXT[c.adapter] ?? { label: c.adapter, description: '' };
      const capabilities = Object.fromEntries(
        Object.entries(c.capabilities ?? {}).map(([k, v]) => [
          k,
          {
            implemented: v.implemented,
            verified: v.verified,
            authorized: v.authorized,
            enabled: v.enabled,
            ...(v.authorizationRef ? { authorizationRef: v.authorizationRef } : {}),
          },
        ]),
      ) as Record<Capability, CapabilityState>;
      return {
        id: `${a.id}:${c.adapter}`,
        adapterKind: c.adapter,
        label: `${text.label} · ${a.displayName}`,
        status: c.status,
        description: text.description,
        capabilities,
      };
    }),
  );
}

/** `GET /imports/:id/rows` adds `raw` (the original cells); the review UI does not show it. */
export function mapImportRow(r: ImportRow & { raw?: unknown }): ImportRow {
  return {
    id: r.id,
    rowNo: r.rowNo,
    status: r.status,
    tradeDate: r.tradeDate,
    symbol: r.symbol,
    side: r.side,
    quantity: r.quantity,
    price: r.price,
    contractRef: r.contractRef,
    fees: r.fees,
    feeSource: r.feeSource,
    duplicateOf: r.duplicateOf,
    errors: r.errors,
    warnings: r.warnings,
    message: r.message,
  };
}

// ─── strategies, signals, backtests (apps/api/src/strategies) ──────────────

export interface ApiTemplate {
  type: StrategyType;
  label: string;
  description: string;
  params: {
    name: string;
    type: TemplateParam['type'];
    default: number | string | boolean | null;
    min: string | null;
    max: string | null;
    options: string[] | null;
    required: boolean;
    description: string;
  }[];
  overlays: string[];
}

export function mapTemplate(t: ApiTemplate): StrategyTemplate {
  return {
    type: t.type,
    label: t.label,
    description: t.description,
    params: (t.params ?? []).map((p) => ({ ...p, options: p.options ? [...p.options] : null })),
    overlays: [...(t.overlays ?? [])],
  };
}

export interface ApiStrategy {
  id: string;
  name: string;
  portfolioId: string;
  symbol: string;
  type: StrategyType;
  mode: ExecutionMode;
  isActive: boolean;
  autoExecute: boolean;
  version: number;
  parameters: Record<string, string | number | boolean>;
  stopLossPct: string | null;
  takeProfitPct: string | null;
  trailingStopPct: string | null;
  cooldownBars: number;
  maxInvestment: string;
  maxPositionQty: string | null;
  riskPerTradePct: string | null;
  lastEvaluatedAt: string | null;
  createdAt: string;
}

export function mapStrategy(s: ApiStrategy): Strategy {
  return {
    id: s.id,
    name: s.name,
    portfolioId: s.portfolioId,
    symbol: s.symbol,
    type: s.type,
    mode: s.mode,
    active: s.isActive,
    autoExecute: s.autoExecute,
    version: s.version,
    parameters: { ...s.parameters },
    stopLossPct: s.stopLossPct,
    takeProfitPct: s.takeProfitPct,
    trailingStopPct: s.trailingStopPct,
    cooldownBars: s.cooldownBars,
    maxInvestment: s.maxInvestment,
    maxPositionQty: s.maxPositionQty,
    riskPerTradePct: s.riskPerTradePct,
    lastEvaluatedAt: s.lastEvaluatedAt,
    createdAt: s.createdAt,
  };
}

/** Body for `POST /strategies/validate` and inline backtest definitions: unset overlays are omitted. */
export function toApiDefinition(d: StrategyDefinition): Record<string, unknown> {
  return {
    type: d.type,
    parameters: d.parameters,
    ...(d.stopLossPct ? { stopLossPct: d.stopLossPct } : {}),
    ...(d.takeProfitPct ? { takeProfitPct: d.takeProfitPct } : {}),
    ...(d.trailingStopPct ? { trailingStopPct: d.trailingStopPct } : {}),
    ...(d.cooldownBars !== undefined ? { cooldownBars: d.cooldownBars } : {}),
  };
}

export function toApiStrategyInput(i: StrategyInput): Record<string, unknown> {
  return {
    name: i.name,
    portfolioId: i.portfolioId,
    symbol: i.symbol,
    autoExecute: i.autoExecute,
    ...toApiDefinition(i),
    maxInvestment: i.maxInvestment,
    ...(i.maxPositionQty ? { maxPositionQty: i.maxPositionQty } : {}),
    ...(i.riskPerTradePct ? { riskPerTradePct: i.riskPerTradePct } : {}),
  };
}

/** PATCH body: fields set to null (or "") are cleared; undefined fields are left unchanged. */
export function toApiStrategyUpdate(u: StrategyUpdate): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(u)) if (v !== undefined) out[k] = v === '' ? null : v;
  return out;
}

export interface ApiSignal {
  id: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  mode: ExecutionMode;
  type: SignalType;
  reason: SignalReason;
  side: OrderSide;
  barTs: string;
  price: { value: string; source: DataSource };
  suggestedQty: string | null;
  status: SignalStatus;
  orderId: string | null;
  createdAt: string;
}

export function mapSignal(s: ApiSignal): Signal {
  return {
    id: s.id,
    strategyId: s.strategyId,
    strategyName: s.strategyName,
    symbol: s.symbol,
    mode: s.mode,
    type: s.type,
    reason: s.reason,
    side: s.side,
    barTs: s.barTs,
    price: { value: s.price.value, source: s.price.source, asOf: s.barTs },
    suggestedQty: s.suggestedQty,
    status: s.status,
    orderId: s.orderId,
    createdAt: s.createdAt,
  };
}

export interface ApiTrace {
  rule: {
    result: boolean;
    warm: boolean;
    trace: {
      path: string;
      kind: string;
      result: boolean;
      operands: { label: string; value: string | null; history?: unknown }[];
      text: string;
    }[];
  } | null;
  overlays: OverlayTraceEntry[];
  summary: string;
}

export function mapTrace(t: ApiTrace | null | undefined): SignalTrace {
  if (!t) return { rule: null, overlays: [], summary: '' };
  return {
    rule: t.rule
      ? {
          result: t.rule.result,
          warm: t.rule.warm,
          trace: t.rule.trace.map((e) => ({
            path: e.path,
            kind: e.kind,
            result: e.result,
            operands: e.operands.map((o) => ({ label: o.label, value: o.value })),
            text: e.text,
          })),
        }
      : null,
    overlays: (t.overlays ?? []).map((o) => ({ ...o })),
    summary: t.summary ?? '',
  };
}

export interface ApiDryRunSignal extends Omit<DryRunSignal, 'trace' | 'note'> {
  trace: ApiTrace;
  note?: string | null;
  barIndex?: number;
}

export interface ApiValidation {
  valid: true;
  warmupBars: number;
  rules?: unknown;
  parameters: Record<string, string>;
  dryRun: {
    symbol: string;
    bars: number;
    from?: string | null;
    to?: string;
    dataSource: DataSource | null;
    warmupComplete?: boolean;
    note?: string;
    signals: ApiDryRunSignal[];
    disclaimer: string;
  } | null;
}

export function mapValidation(v: ApiValidation): StrategyValidation {
  const r = v.dryRun;
  return {
    valid: true,
    warmupBars: v.warmupBars,
    parameters: { ...v.parameters },
    dryRun: r
      ? {
          symbol: r.symbol,
          bars: r.bars,
          from: r.from ?? null,
          to: r.to ?? null,
          dataSource: r.dataSource,
          warmupComplete: r.warmupComplete ?? null,
          note: r.note ?? null,
          signals: r.signals.map((s) => ({
            type: s.type,
            reason: s.reason,
            side: s.side,
            ts: s.ts,
            price: s.price,
            summary: s.summary,
            score: s.score,
            trace: mapTrace(s.trace),
            wouldFill: s.wouldFill,
            note: s.note ?? null,
          })),
          disclaimer: r.disclaimer,
        }
      : null,
  };
}

export interface ApiEvaluation {
  execution: StrategyEvaluation['execution'] & { mode?: string; details?: unknown };
  signal: ApiSignal | null;
  duplicate: boolean;
  order: { id: string; status: OrderStatus } | null;
  note?: string | null;
}

export function mapEvaluation(e: ApiEvaluation): StrategyEvaluation {
  const x = e.execution;
  return {
    execution: {
      id: x.id,
      status: x.status,
      startedAt: x.startedAt,
      finishedAt: x.finishedAt,
      barTs: x.barTs,
      signalsGenerated: x.signalsGenerated,
      error: x.error,
    },
    signal: e.signal ? mapSignal(e.signal) : null,
    duplicate: e.duplicate,
    order: e.order ?? null,
    note: e.note ?? null,
  };
}

type MetricKey = Exclude<keyof BacktestMetrics, 'tradeCount'>;
export type ApiMetrics = Partial<Record<MetricKey, string | null>> & { tradeCount?: number };

export function mapMetrics(m: ApiMetrics | null | undefined): BacktestMetrics | null {
  if (!m) return null;
  const v = (k: MetricKey) => m[k] ?? null;
  return {
    initialCapital: v('initialCapital'),
    finalEquity: v('finalEquity'),
    totalReturnPct: v('totalReturnPct'),
    cagrPct: v('cagrPct'),
    annualizedReturnPct: v('annualizedReturnPct'),
    maxDrawdownPct: v('maxDrawdownPct'),
    sharpe: v('sharpe'),
    sortino: v('sortino'),
    tradeCount: m.tradeCount ?? 0,
    winRatePct: v('winRatePct'),
    profitFactor: v('profitFactor'),
    avgWin: v('avgWin'),
    avgLoss: v('avgLoss'),
    riskReward: v('riskReward'),
    exposurePct: v('exposurePct'),
    feesTotal: v('feesTotal'),
    buyAndHoldReturnPct: v('buyAndHoldReturnPct'),
  };
}

export interface ApiBacktest {
  id: string;
  status: RunStatus;
  strategyId: string | null;
  strategyType: StrategyType;
  symbol: string;
  from: string;
  to: string;
  initialCapital: string;
  finalEquity: string | null;
  totalReturnPct: string | null;
  maxDrawdownPct: string | null;
  sharpe: string | null;
  winRatePct: string | null;
  tradesCount: number | null;
  feesTotal: string | null;
  benchmark: { label: string; totalReturnPct: string | null };
  metrics: ApiMetrics | null;
  dataSource: DataSource;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  params?: { slippageBps?: string } | null;
  equityCurve?: { t: string; equity: string | null; drawdown: string | null }[] | null;
  disclaimer: string;
}

/**
 * `metrics` holds the full values (stored params); when absent the summary columns fill in.
 * Equity points without a value are dropped rather than zero-filled.
 */
export function mapBacktest(b: ApiBacktest): Backtest {
  const metrics =
    mapMetrics(b.metrics) ??
    (b.status === 'SUCCEEDED'
      ? mapMetrics({
          initialCapital: b.initialCapital,
          finalEquity: b.finalEquity,
          totalReturnPct: b.totalReturnPct,
          maxDrawdownPct: b.maxDrawdownPct,
          sharpe: b.sharpe,
          winRatePct: b.winRatePct,
          feesTotal: b.feesTotal,
          buyAndHoldReturnPct: b.benchmark?.totalReturnPct ?? null,
          tradeCount: b.tradesCount ?? 0,
        })
      : null);
  return {
    id: b.id,
    status: b.status,
    strategyId: b.strategyId,
    strategyType: b.strategyType,
    symbol: b.symbol,
    from: b.from,
    to: b.to,
    initialCapital: b.initialCapital,
    slippageBps: b.params?.slippageBps ?? null,
    metrics,
    benchmark: {
      label: b.benchmark?.label ?? 'Buy & hold',
      totalReturnPct: b.benchmark?.totalReturnPct ?? null,
    },
    dataSource: b.dataSource,
    error: b.error,
    createdAt: b.createdAt,
    finishedAt: b.finishedAt,
    equityCurve: (b.equityCurve ?? []).flatMap((p) =>
      p.equity === null ? [] : [{ t: p.t, equity: p.equity, drawdownPct: p.drawdown ?? '0' }],
    ),
    disclaimer: b.disclaimer,
  };
}

export interface ApiBacktestTrades {
  data: BacktestTrade[];
  source: DataSource;
  disclaimer: string;
}

export function mapBacktestTrades(r: ApiBacktestTrades): BacktestTrades {
  return {
    data: r.data.map((t) => ({
      id: t.id,
      entryTs: t.entryTs,
      exitTs: t.exitTs,
      quantity: t.quantity,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      fees: t.fees,
      pnl: t.pnl,
      exitReason: t.exitReason,
      open: t.open,
    })),
    source: r.source,
    disclaimer: r.disclaimer,
  };
}

export interface ApiComparison {
  symbol: string;
  interval?: string;
  from: string;
  to: string;
  initialCapital: string;
  slippageBps: string;
  bars: number;
  dataSource: DataSource;
  rows: { label: string; strategyId: string | null; strategyType: StrategyType; metrics: ApiMetrics }[];
  benchmark: { label: string; totalReturnPct: string | null };
  disclaimer: string;
}

export function mapComparison(c: ApiComparison): BacktestComparison {
  return {
    symbol: c.symbol,
    from: c.from,
    to: c.to,
    initialCapital: c.initialCapital,
    slippageBps: c.slippageBps,
    bars: c.bars,
    dataSource: c.dataSource,
    rows: c.rows.map((r) => ({
      label: r.label,
      strategyId: r.strategyId,
      strategyType: r.strategyType,
      metrics: mapMetrics(r.metrics) ?? mapMetrics({})!,
    })),
    benchmark: { label: c.benchmark.label, totalReturnPct: c.benchmark.totalReturnPct },
    disclaimer: c.disclaimer,
  };
}

// ─── performance & snapshots (apps/api/src/snapshots) ─────────────────────

interface ApiReturnFigure {
  valuePct: string | null;
  method?: string;
  since?: string | null;
  asOf?: string;
  baseDate?: string | null;
  source: DataSource;
}

export interface ApiPerformance {
  portfolioId: string;
  range: PerformanceRange;
  from: string | null;
  to: string | null;
  source: DataSource;
  methodology?: string;
  note?: string;
  series: { date: string; totalValue: string; dailyPnl: string; twrIndex: string | null }[];
  twr: ApiReturnFigure;
  maxDrawdown: {
    valuePct: string | null;
    peakDate: string | null;
    troughDate: string | null;
    recoveryDate: string | null;
    source: DataSource;
  } | null;
  monthly: { month: string; pnl: string; days: number; source: DataSource }[];
  simpleReturn: ApiReturnFigure;
  xirr: ApiReturnFigure;
}

export function mapPerformance(p: ApiPerformance): PortfolioPerformance {
  return {
    portfolioId: p.portfolioId,
    range: p.range,
    from: p.from,
    to: p.to,
    source: p.source,
    methodology: p.methodology ?? null,
    note: p.note ?? null,
    series: p.series.map((x) => ({
      date: x.date,
      totalValue: x.totalValue,
      dailyPnl: x.dailyPnl,
      twrIndex: x.twrIndex,
    })),
    twr: { valuePct: p.twr.valuePct, baseDate: p.twr.baseDate ?? null, source: p.twr.source },
    maxDrawdown: p.maxDrawdown
      ? {
          valuePct: p.maxDrawdown.valuePct,
          peakDate: p.maxDrawdown.peakDate,
          troughDate: p.maxDrawdown.troughDate,
          recoveryDate: p.maxDrawdown.recoveryDate,
          source: p.maxDrawdown.source,
        }
      : null,
    monthly: p.monthly.map((m) => ({ month: m.month, pnl: m.pnl, days: m.days, source: m.source })),
    simpleReturn: {
      valuePct: p.simpleReturn.valuePct,
      asOf: p.simpleReturn.asOf ?? null,
      source: p.simpleReturn.source,
    },
    xirr: { valuePct: p.xirr.valuePct, asOf: p.xirr.asOf ?? null, source: p.xirr.source },
  };
}

export interface ApiBackfillResult {
  portfolioId: string;
  from: string;
  to: string;
  tradingDays: number;
  unpricedSymbols?: string[];
}

export function mapBackfill(r: ApiBackfillResult): SnapshotBackfillResult {
  return {
    portfolioId: r.portfolioId,
    from: r.from,
    to: r.to,
    tradingDays: r.tradingDays,
    unpricedSymbols: r.unpricedSymbols ?? [],
  };
}

// ─── notifications (apps/api/src/notifications) ───────────────────────────

export interface ApiNotification {
  id: string;
  type: string | null;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channel: NotificationChannel;
  status: NotificationStatus;
  alertId: string | null;
  createdAt: string;
  readAt: string | null;
}

/** In-app route for a notification (derived from its type; never from free-form data). */
export function notificationLink(type: string | null, alertId: string | null): string | undefined {
  if (alertId) return '/alerts';
  switch (type) {
    case 'ORDER_EXECUTED':
    case 'ORDER_REJECTED':
      return '/orders';
    case 'STRATEGY_SIGNAL':
      return '/strategies';
    case 'SYNC_DISCREPANCY':
      return '/integration';
    default:
      return undefined;
  }
}

export function mapNotification(n: ApiNotification): Notification {
  const link = notificationLink(n.type, n.alertId);
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    createdAt: n.createdAt,
    readAt: n.readAt,
    read: n.readAt !== null,
    channel: n.channel,
    status: n.status,
    alertId: n.alertId,
    ...(link ? { link } : {}),
  };
}

export interface ApiNotificationPage {
  data: ApiNotification[];
  nextCursor: string | null;
  unreadCount: number;
}

export function mapNotificationPage(p: ApiNotificationPage): NotificationPage {
  return { data: p.data.map(mapNotification), nextCursor: p.nextCursor, unreadCount: p.unreadCount };
}

// ─── alerts (apps/api/src/alerts) ─────────────────────────────────────────

export interface ApiAlert {
  id: string;
  type: AlertKind;
  symbol: string | null;
  portfolio: { id: string; name: string } | null;
  params: Record<string, string>;
  threshold: string | null;
  channels: NotificationChannel[];
  isActive: boolean;
  triggerOnce: boolean;
  cooldownMinutes: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function mapAlert(a: ApiAlert): Alert {
  return {
    id: a.id,
    type: a.type,
    symbol: a.symbol,
    portfolio: a.portfolio ? { id: a.portfolio.id, name: a.portfolio.name } : null,
    params: { ...a.params },
    threshold: a.threshold,
    channels: [...a.channels],
    active: a.isActive,
    triggerOnce: a.triggerOnce,
    cooldownMinutes: a.cooldownMinutes,
    lastTriggeredAt: a.lastTriggeredAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

const SYMBOL_ALERTS: ReadonlySet<AlertKind> = new Set<AlertKind>([
  'PRICE_ABOVE',
  'PRICE_BELOW',
  'PCT_CHANGE_ABOVE',
  'PCT_CHANGE_BELOW',
  'VOLUME_SPIKE',
  'POSITION_STOP_LOSS',
]);
const PORTFOLIO_ALERTS: ReadonlySet<AlertKind> = new Set<AlertKind>([
  'PORTFOLIO_DAILY_LOSS',
  'POSITION_STOP_LOSS',
]);

/** `POST /alerts` body — the API's strict discriminated union: only the target fields its type allows. */
export function toApiAlertInput(i: AlertInput): Record<string, unknown> {
  return {
    type: i.type,
    ...(SYMBOL_ALERTS.has(i.type) && i.symbol ? { symbol: i.symbol } : {}),
    ...(PORTFOLIO_ALERTS.has(i.type) && i.portfolioId ? { portfolioId: i.portfolioId } : {}),
    params: { ...i.params },
    channels: [...i.channels],
    cooldownMinutes: i.cooldownMinutes,
    triggerOnce: i.triggerOnce,
    isActive: i.active,
  };
}

/** `PATCH /alerts/:id` body (only the fields given). */
export function toApiAlertUpdate(u: AlertUpdate): Record<string, unknown> {
  return {
    ...(u.params ? { params: { ...u.params } } : {}),
    ...(u.channels ? { channels: [...u.channels] } : {}),
    ...(u.cooldownMinutes !== undefined ? { cooldownMinutes: u.cooldownMinutes } : {}),
    ...(u.triggerOnce !== undefined ? { triggerOnce: u.triggerOnce } : {}),
    ...(u.active !== undefined ? { isActive: u.active } : {}),
  };
}

export interface ApiAlertEvaluation {
  evaluatedAt: string;
  evaluated: number;
  fired: { alertId: string; type: string; observed: string; notificationsCreated: number }[];
  skipped: Record<string, number>;
}

export function mapAlertEvaluation(e: ApiAlertEvaluation): AlertEvaluation {
  return {
    evaluatedAt: e.evaluatedAt,
    evaluated: e.evaluated,
    fired: e.fired.map((f) => ({ ...f })),
    skipped: { ...e.skipped },
  };
}
