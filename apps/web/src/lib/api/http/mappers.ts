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
} from '@ktrade/shared';
import { Dec } from '../../decimal';
import { ApiError, type FieldError } from '../errors';
import type {
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
  todayPnl: ApiValue;
  monthPnl: ApiValue;
  dividendsReceived: { value: string; source: DataSource };
  feesAndTaxes: { fees: string; taxes: string; source: DataSource };
  activeHoldings: number;
  pendingOrders: number;
  unpricedHoldings: number;
}

const sourcedOrNull = (v: ApiValue | undefined) =>
  v && v.value !== null && v.source ? { value: v.value, source: v.source, asOf: v.asOf, note: v.note } : null;

export function mapSummary(s: ApiSummary): DashboardSummary {
  return {
    portfolioId: s.portfolio.id,
    accountValue: { ...s.accountValue },
    investedAmount: { ...s.investedAmount },
    marketValue: { ...s.portfolioValue },
    cash: { ledger: { ...s.cash.ledger }, broker: s.cash.broker ? { ...s.cash.broker } : null },
    realizedPnl: { ...s.realizedPnl },
    unrealizedPnl: { ...s.unrealizedPnl },
    todayPnl: sourcedOrNull(s.todayPnl),
    todayPnlPct: null,
    monthPnl: sourcedOrNull(s.monthPnl),
    totalReturnPct: sourcedOrNull(s.totalReturnPct),
    twrPct: null,
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
