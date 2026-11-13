/**
 * Response/request shapes for the BFF API (docs/07-api-specification.md).
 *
 * Conventions mirrored from the spec:
 *  - money / price / qty / percent are decimal STRINGS (`Decimal`), never numbers;
 *  - every financial figure carries a `source` (DataSource) — aggregates add `sourceBreakdown`;
 *  - instants are ISO-8601 UTC strings, calendar dates are `YYYY-MM-DD` (PKT trading calendar).
 *  - percent fields named `*Pct` hold percent values ("2.35" = 2.35%); `sourceBreakdown`
 *    and `weight` hold fractions ("0.82").
 */
import type {
  ActorType,
  AlertType,
  BrokerAdapterKind,
  CashMovementType,
  ConnectionStatus,
  CostBasisMethod,
  DataSource,
  DividendPaymentStatus,
  ExecutionMode,
  FeeAppliesTo,
  FeeComponent,
  FeeMethod,
  ImportChannel,
  ImportKind,
  ImportRowStatus,
  ImportStatus,
  NotificationChannel,
  OrderOrigin,
  OrderSide,
  OrderStatus,
  OrderType,
  PortfolioKind,
  PriceInterval,
  Role,
  RunStatus,
  SignalReason,
  SignalStatus,
  SignalType,
  StrategyType,
  TaxFilerStatus,
  TaxType,
  TimeInForce,
  TransactionType,
} from '@ktrade/shared';

export type { DataSource, OrderStatus, OrderSide, OrderType, StrategyType, FeeComponent };

/** Decimal string, e.g. "25086.2500". */
export type Decimal = string;
/** ISO-8601 instant. */
export type Instant = string;
/** YYYY-MM-DD. */
export type IsoDate = string;

export interface SourcedValue {
  value: Decimal;
  source: DataSource;
  asOf?: Instant;
  note?: string;
}

/** Fractions per source; values sum to "1". */
export type SourceBreakdown = Partial<Record<DataSource, Decimal>>;

export interface AggregateValue extends SourcedValue {
  sourceBreakdown?: SourceBreakdown;
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}

// ─── Auth & security ───────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  /** From the API (`AuthTokensResponse.user`); the demo omits it. */
  totpEnabled?: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
  /** Required by the API once TOTP is enabled (it answers 401 `TOTP_REQUIRED` without it). */
  totpCode?: string;
}
export interface RegisterRequest {
  email: string;
  password: string;
  displayName: string;
}
export type LoginResult = { user: User; totpRequired: false } | { totpRequired: true };

export interface StepUpToken {
  token: string;
  expiresAt: Instant;
}

export interface Session {
  id: string;
  device: string;
  ip: string | null;
  /** Not tracked by the API (null there). */
  location: string | null;
  /** Not tracked by the API (null there). */
  createdAt: Instant | null;
  lastSeenAt: Instant;
  expiresAt?: Instant;
  current: boolean;
}

export interface SecurityOverview {
  twoFactorEnabled: boolean;
  passwordUpdatedAt: Instant;
  recentEvents: { id: string; at: Instant; action: string; actor: ActorType; detail: string }[];
}

// ─── Data mode / system ────────────────────────────────────────────────────

export interface DataMode {
  priceSource: DataSource;
  providerKey: string;
  delayMinutes: number;
  /** Live order submission path today; always manual until KTrade authorizes an adapter. */
  liveExecution: 'MANUAL';
  demo: boolean;
}

export interface KillSwitch {
  liveTradingEnabled: boolean;
  /** The API returns only `liveTradingEnabled` (the reason lives in the audit log). */
  reason?: string;
  updatedAt?: Instant;
}

// ─── Dashboard & portfolio ─────────────────────────────────────────────────

export interface Portfolio {
  id: string;
  name: string;
  kind: PortfolioKind;
  costBasisMethod: CostBasisMethod;
  initialCash?: Decimal | null;
  /** Not returned by `GET /portfolios`. */
  createdAt?: Instant;
  demo: boolean;
}

/**
 * `GET /dashboard/summary`. Figures the API cannot compute yet (daily snapshots arrive in Phase 10)
 * are `null`, never zero-filled.
 */
export interface DashboardSummary {
  portfolioId: string;
  accountValue: AggregateValue;
  investedAmount: AggregateValue;
  marketValue: AggregateValue;
  cash: { ledger: SourcedValue; broker: SourcedValue | null };
  realizedPnl: AggregateValue;
  unrealizedPnl: AggregateValue;
  todayPnl: AggregateValue | null;
  todayPnlPct: SourcedValue | null;
  monthPnl: AggregateValue | null;
  totalReturnPct: SourcedValue | null;
  twrPct: SourcedValue | null;
  xirrPct: SourcedValue | null;
  dividendsReceived: AggregateValue;
  feesPaid: AggregateValue;
  taxesPaid: AggregateValue;
  activeHoldings: number;
  pendingOrders: number;
  /** Holdings with no quote (excluded from market value). */
  unpricedHoldings?: number;
  sourceBreakdown: SourceBreakdown | null;
  pricesAsOf: Instant | null;
  priceSource: DataSource | null;
}

export type ChartRange = '1M' | '3M' | 'YTD' | '1Y' | 'ALL';

export interface DashboardCharts {
  range: ChartRange;
  source: DataSource;
  performance: { date: IsoDate; value: Decimal; invested: Decimal }[];
  allocation: { sector: string; value: Decimal; weight: Decimal }[];
  dailyPnl: { date: IsoDate; pnl: Decimal }[];
  monthly: { month: string; pnl: Decimal; returnPct: Decimal }[];
  distribution: { symbol: string; value: Decimal; weight: Decimal }[];
}

/** Price-derived fields are `null` when the symbol has no quote (the API never invents one). */
export interface Holding {
  symbol: string;
  name: string;
  sector: string | null;
  quantity: Decimal;
  avgCost: Decimal;
  lastPrice: SourcedValue | null;
  totalCost: Decimal;
  marketValue: Decimal | null;
  unrealizedPnl: Decimal | null;
  unrealizedPnlPct: Decimal | null;
  realizedPnl: Decimal;
  /** Fraction of portfolio market value. */
  weight: Decimal | null;
  /** Not provided by the API holdings endpoint (null there). */
  dayChangePct: Decimal | null;
  /** Provenance of the position itself (quantity / cost basis). */
  source: DataSource;
  lastConfirmed: IsoDate | null;
}

export interface Lot {
  id: string;
  acquiredAt: IsoDate;
  quantity: Decimal;
  remainingQty: Decimal;
  unitCost: Decimal;
  source: DataSource;
}

export interface Transaction {
  id: string;
  portfolioId: string;
  tradeDate: IsoDate;
  type: TransactionType;
  symbol: string;
  quantity: Decimal;
  price: Decimal;
  grossAmount: Decimal;
  fees: Decimal;
  /** Taxes are reported separately by the API (`taxesTotal`). */
  taxes?: Decimal;
  netAmount: Decimal;
  source: DataSource;
  reference: string | null;
  orderId: string | null;
  /** Reversed transactions stay visible but no longer count. */
  reversed?: boolean;
}

export interface CashMovement {
  id: string;
  portfolioId: string;
  date: IsoDate;
  type: CashMovementType;
  amount: Decimal;
  description: string;
  source: DataSource;
}

export interface Dividend {
  id: string;
  symbol: string;
  name: string;
  announcementDate: IsoDate;
  exDate: IsoDate;
  paymentDate: IsoDate | null;
  perShare: Decimal;
  eligibleQty: Decimal;
  grossAmount: Decimal;
  whtAmount: Decimal;
  netAmount: Decimal;
  status: DividendPaymentStatus;
  source: DataSource;
}

export interface HoldingDetail {
  holding: Holding;
  lots: Lot[];
  transactions: Transaction[];
  dividends: Dividend[];
}

export interface TransactionFilters {
  symbol?: string;
  type?: TransactionType;
  from?: IsoDate;
  to?: IsoDate;
}

// ─── Market data (mirrors apps/api/src/market-data, ADR-024) ──────────────

/**
 * One quote. Fields the provider did not supply are `null` (the API omits them).
 * `stale` = older than the trading session allows; the UI must mark it visibly.
 */
export interface Quote {
  symbol: string;
  name?: string;
  sector?: string | null;
  last: Decimal;
  open: Decimal | null;
  high: Decimal | null;
  low: Decimal | null;
  prevClose: Decimal | null;
  change: Decimal | null;
  changePct: Decimal | null;
  volume: Decimal | null;
  asOf: Instant;
  delayMinutes: number;
  source: DataSource;
  providerKey?: string;
  stale: boolean;
}

/** Realtime / polled `quote` event payload. */
export type QuoteTick = Pick<
  Quote,
  'symbol' | 'last' | 'change' | 'changePct' | 'volume' | 'asOf' | 'source' | 'delayMinutes'
> &
  Partial<Pick<Quote, 'high' | 'low' | 'stale'>>;

export interface StockQuery {
  search?: string;
  sector?: string;
  limit?: number;
  offset?: number;
}

/** `GET /market/stocks` row. */
export interface StockListItem {
  symbol: string;
  name: string;
  sector: string | null;
  isShariah: boolean;
  quote: Quote | null;
}

export interface StockPage {
  total: number;
  data: StockListItem[];
}

/** `GET /market/stocks/:symbol`. Stats come from stored daily bars (last 365 days). */
export interface StockDetail {
  symbol: string;
  name: string;
  sector: string | null;
  isShariah: boolean;
  faceValue: Decimal | null;
  quote: Quote | null;
  stats: {
    week52High: Decimal | null;
    week52Low: Decimal | null;
    avgVolume20d: Decimal | null;
    sessions: number;
    historySources: DataSource[];
    /** Weakest source across the history window. */
    historySource: DataSource | null;
  };
}

export interface SectorSummary {
  sector: string;
  stocks: number;
  advancers: number;
  decliners: number;
  avgChangePct: Decimal | null;
  volume: Decimal;
  source: DataSource;
}

/** `GET /market/overview`. */
export interface MarketOverview {
  session: { open: boolean; tradingDay: boolean; lastCompletedSession: IsoDate | null; hours: string };
  breadth: { advancers: number; decliners: number; unchanged: number; total: number };
  totalVolume: Decimal;
  gainers: Quote[];
  losers: Quote[];
  mostActive: Quote[];
  sectors: SectorSummary[];
  /** Weakest source across all quotes. */
  dataSource: DataSource | null;
  staleQuotes: number;
  asOf: Instant | null;
  providerKey: string;
}

/** A bar carries its own provenance (one series can mix imported and simulated days). */
export interface Candle {
  /** Bar open, ISO instant. */
  ts: Instant;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
  source: DataSource;
}

export interface CandleSeries {
  symbol: string;
  interval: PriceInterval;
  from: Instant;
  to: Instant;
  /** Weakest source across the bars (null when there are none). */
  source: DataSource | null;
  candles: Candle[];
}

export type MoverType = 'gainers' | 'losers' | 'active';

export interface WatchlistItem {
  symbol: string;
  addedAt: Instant;
  quote: Quote | null;
}

export interface Watchlist {
  id: string;
  name: string;
  createdAt: Instant;
  items: WatchlistItem[];
}

export interface MarketProvider {
  key: string;
  displayName: string;
  source: DataSource;
  enabled: boolean;
  active: boolean;
  disabledReason: string | null;
  capabilities: {
    quotes: boolean;
    intradayBars: boolean;
    eodBars: boolean;
    corporateActions: boolean;
    streaming: boolean;
    delayMinutes: number;
  };
  /** null for disabled providers (never health-checked). */
  health: { ok: boolean; checkedAt: Instant; message?: string } | null;
}

export type Unsubscribe = () => void;

// ─── Orders & trading ──────────────────────────────────────────────────────

export type ExecutionPath = 'PAPER_AUTO' | 'MANUAL_TICKET' | 'ADAPTER';

export type RiskRule =
  | 'KILL_SWITCH'
  | 'CAPABILITY'
  | 'MARKET_HOURS'
  | 'BUYING_POWER'
  | 'HOLDING_QTY'
  | 'MAX_ORDER_VALUE'
  | 'MAX_ORDER_QTY'
  | 'PRICE_BAND'
  | 'DAILY_VALUE'
  | 'DAILY_COUNT'
  | 'CONCENTRATION'
  | 'DAILY_LOSS'
  | 'MARKET_ORDERS_ALLOWED'
  | 'PRICE_SOURCE';

export interface RiskCheck {
  rule: RiskRule;
  passed: boolean;
  observed?: string;
  limit?: string;
  message: string;
}

export interface FeeLine {
  component: FeeComponent;
  amount: Decimal;
  source: DataSource;
  /** Human description of the rule, e.g. "max(0.30% of value, Rs 0.06/share)". */
  basis?: string;
  note?: string;
}

export interface FeeEstimate {
  notional: Decimal;
  fees: FeeLine[];
  totalFees: Decimal;
  /** BUY: notional + fees (cash needed). SELL: notional − fees (net proceeds). */
  total: Decimal;
}

export interface OrderPreviewRequest {
  portfolioId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: Decimal;
  limitPrice?: Decimal;
  stopPrice?: Decimal;
  timeInForce?: TimeInForce;
  origin: OrderOrigin;
  signalId?: string;
}

export interface OrderEvent {
  id: string;
  at: Instant;
  status: OrderStatus;
  actor: ActorType;
  note: string;
}

export interface Execution {
  id: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: Decimal;
  price: Decimal;
  executedAt: Instant;
  source: DataSource;
}

export interface Order {
  id: string;
  portfolioId: string;
  mode: ExecutionMode;
  status: OrderStatus;
  executionPath: ExecutionPath;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: Decimal;
  limitPrice: Decimal | null;
  stopPrice: Decimal | null;
  /** Not stored by the API (null there). */
  timeInForce: TimeInForce | null;
  origin: OrderOrigin;
  referencePrice: (SourcedValue & { delayMinutes?: number }) | null;
  /** Null when the API has no estimate (e.g. orders listed before preview data existed). */
  estimate: FeeEstimate | null;
  /** Empty in list responses; full detail comes from `get`. */
  riskChecks: RiskCheck[];
  /** Only present while the order is PREVIEWED. */
  previewHash: string | null;
  previewExpiresAt: Instant | null;
  warnings: string[];
  createdAt: Instant;
  updatedAt?: Instant;
  companyName?: string;
  rejectionReason?: string | null;
  brokerOrderRef: string | null;
  filledQuantity: Decimal;
  avgFillPrice: Decimal | null;
  events: OrderEvent[];
  executions: Execution[];
}

export interface OrderFilters {
  status?: OrderStatus;
  mode?: ExecutionMode;
  symbol?: string;
}

export interface FillRequest {
  quantity: Decimal;
  price: Decimal;
  executedAt: Instant;
}

export interface RiskLimits {
  portfolioId: string;
  maxOrderValue: Decimal;
  maxOrderQty: Decimal;
  priceBandPct: Decimal;
  maxDailyValue: Decimal;
  maxDailyCount: number;
  maxPositionPct: Decimal;
  maxDailyLossPct: Decimal;
  /** MARKET orders are refused unless enabled (LIVE default: off). */
  allowMarketOrders: boolean;
  liveAutoExecutionEnabled: boolean;
}

export interface FeeEstimateQuery {
  symbol: string;
  side: OrderSide;
  quantity: Decimal;
  price: Decimal;
}

// ─── Strategies, signals, backtests ────────────────────────────────────────

/** A JSON-Schema subset sufficient to render strategy parameter forms. */
export interface ParamSchemaProperty {
  type: 'integer' | 'string' | 'boolean';
  /** `decimal` = decimal string; `percent` = decimal string interpreted as percent. */
  format?: 'decimal' | 'percent';
  title: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  default: number | string | boolean;
  enum?: string[];
}

export interface ParamSchema {
  type: 'object';
  properties: Record<string, ParamSchemaProperty>;
  required: string[];
}

export type StrategyParams = Record<string, number | string | boolean>;

export interface StrategyTemplate {
  type: StrategyType;
  name: string;
  description: string;
  entry: string;
  exit: string;
  parameterSchema: ParamSchema;
}

export interface Strategy {
  id: string;
  name: string;
  type: StrategyType;
  mode: ExecutionMode;
  symbols: string[];
  parameters: StrategyParams;
  active: boolean;
  autoExecute: boolean;
  version: number;
  createdAt: Instant;
  lastEvaluatedAt: Instant | null;
}

export interface StrategyInput {
  name: string;
  type: StrategyType;
  mode: ExecutionMode;
  symbols: string[];
  parameters: StrategyParams;
  autoExecute: boolean;
}

export interface TraceCondition {
  condition: string;
  operands: { label: string; value: Decimal }[];
  result: boolean;
}

export interface Signal {
  id: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  type: SignalType;
  reason: SignalReason;
  price: SourcedValue;
  /** 0–100 confidence. */
  score: number;
  scoreComponents: { label: string; points: number; max: number }[];
  status: SignalStatus;
  createdAt: Instant;
  trace: TraceCondition[];
  explanation: string;
}

export interface BacktestRequest {
  strategyType: StrategyType;
  parameters: StrategyParams;
  symbol: string;
  interval: PriceInterval;
  from: IsoDate;
  to: IsoDate;
  initialCapital: Decimal;
  slippageBps: number;
}

export interface BacktestMetrics {
  totalReturnPct: Decimal;
  cagrPct: Decimal;
  maxDrawdownPct: Decimal;
  sharpe: Decimal;
  winRatePct: Decimal;
  profitFactor: Decimal | null;
  avgWin: Decimal;
  avgLoss: Decimal;
  exposurePct: Decimal;
  feesPaid: Decimal;
  tradeCount: number;
  benchmarkReturnPct: Decimal;
  finalEquity: Decimal;
}

export interface BacktestTrade {
  id: string;
  entryDate: IsoDate;
  exitDate: IsoDate | null;
  side: OrderSide;
  quantity: Decimal;
  entryPrice: Decimal;
  exitPrice: Decimal | null;
  pnl: Decimal;
  returnPct: Decimal;
  fees: Decimal;
  exitReason: SignalReason | 'END_OF_TEST' | null;
}

export interface Backtest {
  id: string;
  status: RunStatus;
  request: BacktestRequest;
  createdAt: Instant;
  metrics: BacktestMetrics | null;
  equityCurve: { date: IsoDate; equity: Decimal; benchmark: Decimal; drawdownPct: Decimal }[];
  trades: BacktestTrade[];
  source: DataSource;
  disclaimer: string;
}

// ─── Notifications, alerts, assistant ──────────────────────────────────────

export interface Notification {
  id: string;
  type: AlertType;
  title: string;
  body: string;
  createdAt: Instant;
  read: boolean;
  channel: NotificationChannel;
  link?: string;
}

export interface Alert {
  id: string;
  type: AlertType;
  symbol: string | null;
  params: Record<string, string>;
  active: boolean;
  channels: NotificationChannel[];
}

export interface AssistantToolCall {
  name: string;
  args: Record<string, string>;
  digest: string;
}

export interface AssistantCitation {
  label: string;
  href: string;
}

export interface AssistantMessage {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  createdAt: Instant;
  toolCalls: AssistantToolCall[];
  citations: AssistantCitation[];
  /** True for canned demo responses (no LLM involved). */
  demo: boolean;
}

// ─── Analytics & reports ───────────────────────────────────────────────────

export type PerformancePeriod = 'day' | 'week' | 'month' | 'year';

export interface PerformanceRow {
  period: string;
  startValue: Decimal;
  endValue: Decimal;
  netFlows: Decimal;
  pnl: Decimal;
  returnPct: Decimal;
  source: DataSource;
}

export interface RealizedUnrealized {
  realized: AggregateValue;
  unrealized: AggregateValue;
  bySymbol: { symbol: string; realized: Decimal; unrealized: Decimal }[];
}

export interface FeesTaxes {
  rows: { component: FeeComponent; estimated: Decimal; confirmed: Decimal }[];
  totalEstimated: Decimal;
  totalConfirmed: Decimal;
}

export type ReportType =
  'PERFORMANCE' | 'TRANSACTIONS' | 'HOLDINGS' | 'DIVIDENDS' | 'FEES_TAXES' | 'CGT_ESTIMATE';
export type ReportFormat = 'PDF' | 'CSV' | 'XLSX';

export interface Report {
  id: string;
  type: ReportType;
  format: ReportFormat;
  status: RunStatus;
  createdAt: Instant;
  fileName: string;
  note: string;
}

// ─── Broker & sync ─────────────────────────────────────────────────────────

export type Capability =
  | 'readAccount'
  | 'readCash'
  | 'readHoldings'
  | 'readOrders'
  | 'readExecutions'
  | 'prepareOrder'
  | 'placeOrder'
  | 'cancelOrder'
  | 'streamOrderUpdates';

export interface CapabilityState {
  implemented: boolean;
  verified: boolean;
  authorized: boolean;
  authorizationRef?: string;
  enabled: boolean;
}

export interface BrokerConnection {
  id: string;
  adapterKind: BrokerAdapterKind;
  label: string;
  status: ConnectionStatus;
  description: string;
  capabilities: Record<Capability, CapabilityState>;
}

/** Mirrors `GET /api/v1/imports/:id` (apps/api/src/imports/imports.service.ts → present()). */
export interface ImportBatch {
  id: string;
  portfolioId: string | null;
  kind: ImportKind;
  channel: ImportChannel;
  fileName: string;
  sizeBytes: number;
  parserKey: string;
  /** Provenance of rows this file produces (user CSV → USER_REPORTED; KTrade documents → BROKER_CONFIRMED). */
  source: DataSource | null;
  status: ImportStatus;
  uploadedAt: Instant;
  committedAt: Instant | null;
  periodFrom: IsoDate | null;
  periodTo: IsoDate | null;
  rowCounts: Partial<Record<ImportRowStatus, number>>;
}

/** Mirrors `GET /api/v1/imports/:id/rows`. Trade fields are null on rows that could not be parsed. */
export interface ImportRow {
  id: string;
  rowNo: number;
  status: ImportRowStatus;
  tradeDate: IsoDate | null;
  symbol: string | null;
  side: OrderSide | null;
  quantity: Decimal | null;
  price: Decimal | null;
  contractRef: string | null;
  /** Charges stated in the file. Empty → the fee engine estimates them on commit. */
  fees: { component: FeeComponent; amount: Decimal }[];
  feeSource: 'FILE' | 'ESTIMATED_ON_COMMIT' | null;
  duplicateOf: { kind: 'IMPORT_ROW' | 'TRANSACTION'; id: string; detail: string } | null;
  errors: string[];
  warnings: string[];
  message: string | null;
}

export type ImportRowAction = 'skip' | 'include';

export interface MailboxStatus {
  connected: boolean;
  address: string | null;
  senderFilter: string;
  lastSyncAt: Instant | null;
  messagesProcessed: number;
  scope: string;
}

export interface Discrepancy {
  id: string;
  kind: 'HOLDING' | 'CASH';
  symbol: string | null;
  ledger: Decimal;
  broker: Decimal;
  difference: Decimal;
  brokerSource: DataSource;
  detectedAt: Instant;
  status: 'OPEN' | 'RESOLVED';
  note: string;
}

// ─── Settings ──────────────────────────────────────────────────────────────

export interface FeeScheduleRow {
  id: string;
  component: FeeComponent;
  appliesTo: FeeAppliesTo;
  method: FeeMethod;
  rate: Decimal | null;
  perShare: Decimal | null;
  description: string;
  effectiveFrom: IsoDate;
  source: DataSource;
  verified: boolean;
}

export interface TaxRate {
  id: string;
  type: TaxType;
  filerStatus: TaxFilerStatus;
  ratePct: Decimal;
  effectiveFrom: IsoDate;
  verified: boolean;
  note: string;
}

export interface ChannelConfig {
  channel: NotificationChannel;
  enabled: boolean;
  target: string;
  configured: boolean;
}

export interface UserSettings {
  displayName: string;
  taxFilerStatus: TaxFilerStatus;
  costBasisMethod: CostBasisMethod;
  aiDataSharingOptIn: boolean;
}
