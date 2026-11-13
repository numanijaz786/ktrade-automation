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
}

export interface LoginRequest {
  email: string;
  password: string;
}
export interface RegisterRequest extends LoginRequest {
  displayName: string;
}
export type LoginResult = { user: User; totpRequired: false } | { totpRequired: true; challengeId: string };

export interface StepUpToken {
  token: string;
  expiresAt: Instant;
}

export interface Session {
  id: string;
  device: string;
  ip: string;
  location: string;
  createdAt: Instant;
  lastSeenAt: Instant;
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
  reason: string;
  updatedAt: Instant;
}

// ─── Dashboard & portfolio ─────────────────────────────────────────────────

export interface Portfolio {
  id: string;
  name: string;
  kind: PortfolioKind;
  costBasisMethod: CostBasisMethod;
  initialCash?: Decimal;
  createdAt: Instant;
  demo: boolean;
}

export interface DashboardSummary {
  portfolioId: string;
  accountValue: AggregateValue;
  investedAmount: AggregateValue;
  marketValue: AggregateValue;
  cash: { ledger: SourcedValue; broker: SourcedValue | null };
  realizedPnl: AggregateValue;
  unrealizedPnl: AggregateValue;
  todayPnl: AggregateValue;
  todayPnlPct: SourcedValue;
  monthPnl: AggregateValue;
  totalReturnPct: SourcedValue;
  twrPct: SourcedValue;
  xirrPct: SourcedValue;
  dividendsReceived: AggregateValue;
  feesPaid: AggregateValue;
  taxesPaid: AggregateValue;
  activeHoldings: number;
  pendingOrders: number;
  sourceBreakdown: SourceBreakdown;
  pricesAsOf: Instant;
  priceSource: DataSource;
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

export interface Holding {
  symbol: string;
  name: string;
  sector: string;
  quantity: Decimal;
  avgCost: Decimal;
  lastPrice: SourcedValue;
  totalCost: Decimal;
  marketValue: Decimal;
  unrealizedPnl: Decimal;
  unrealizedPnlPct: Decimal;
  realizedPnl: Decimal;
  /** Fraction of portfolio market value. */
  weight: Decimal;
  dayChangePct: Decimal;
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
  netAmount: Decimal;
  source: DataSource;
  reference: string | null;
  orderId: string | null;
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

// ─── Market data ───────────────────────────────────────────────────────────

export interface Stock {
  symbol: string;
  name: string;
  sector: string;
  lotSize: number;
  /** Simulated fundamentals for the stats panel. */
  marketCap: Decimal;
  sharesOutstanding: Decimal;
  freeFloatPct: Decimal;
  peRatio: Decimal | null;
  dividendYieldPct: Decimal | null;
  source: DataSource;
}

export interface Quote {
  symbol: string;
  last: Decimal;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  prevClose: Decimal;
  change: Decimal;
  changePct: Decimal;
  volume: Decimal;
  asOf: Instant;
  delayMinutes: number;
  source: DataSource;
  stale: boolean;
}

/** WebSocket `quote` event payload. */
export type QuoteTick = Pick<Quote, 'symbol' | 'last' | 'change' | 'changePct' | 'volume' | 'asOf' | 'source' | 'delayMinutes'> &
  Partial<Pick<Quote, 'high' | 'low'>>;

export interface Candle {
  time: IsoDate;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

export interface CandleSeries {
  symbol: string;
  interval: PriceInterval;
  source: DataSource;
  candles: Candle[];
}

export type MoverType = 'gainers' | 'losers' | 'active';

export interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
}

export interface MarketProvider {
  key: string;
  name: string;
  source: DataSource;
  active: boolean;
  available: boolean;
  delayMinutes: number;
  health: 'OK' | 'DEGRADED' | 'DOWN' | 'NOT_CONFIGURED';
  capabilities: { quotes: boolean; intradayBars: boolean; eodBars: boolean; corporateActions: boolean; streaming: boolean };
  note: string;
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
  | 'DAILY_LOSS';

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
  timeInForce: TimeInForce;
  origin: OrderOrigin;
  referencePrice: SourcedValue & { delayMinutes: number };
  estimate: FeeEstimate;
  riskChecks: RiskCheck[];
  previewHash: string;
  previewExpiresAt: Instant;
  warnings: string[];
  createdAt: Instant;
  updatedAt: Instant;
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

export type ReportType = 'PERFORMANCE' | 'TRANSACTIONS' | 'HOLDINGS' | 'DIVIDENDS' | 'FEES_TAXES' | 'CGT_ESTIMATE';
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
