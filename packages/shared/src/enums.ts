/**
 * Domain enums shared by api, worker and web.
 * MUST stay identical to the Prisma enums in apps/api/prisma/schema.prisma —
 * enforced by the enum-sync test in apps/api.
 */
const e = <const T extends readonly string[]>(values: T): T => values;

export const DATA_SOURCES = e([
  'BROKER_CONFIRMED',
  'BROKER_DISPLAYED',
  'PROVIDER',
  'USER_REPORTED',
  'ESTIMATED',
  'SIMULATED',
]);
export type DataSource = (typeof DATA_SOURCES)[number];
/** Lower index = more trusted. */
export const dataSourceRank = (s: DataSource): number => DATA_SOURCES.indexOf(s);
/** The least-trusted of several sources (an aggregate is only as good as its weakest input). */
export const weakestSource = (sources: readonly DataSource[]): DataSource =>
  sources.reduce<DataSource>(
    (w, s) => (dataSourceRank(s) > dataSourceRank(w) ? s : w),
    'BROKER_CONFIRMED',
  );

export const ROLES = e(['OWNER', 'VIEWER']);
export type Role = (typeof ROLES)[number];

export const PORTFOLIO_KINDS = e(['LIVE', 'PAPER']);
export type PortfolioKind = (typeof PORTFOLIO_KINDS)[number];

export const COST_BASIS_METHODS = e(['WEIGHTED_AVERAGE', 'FIFO']);
export type CostBasisMethod = (typeof COST_BASIS_METHODS)[number];

export const TAX_FILER_STATUSES = e(['FILER', 'NON_FILER', 'UNKNOWN']);
export type TaxFilerStatus = (typeof TAX_FILER_STATUSES)[number];

export const BROKER_ADAPTER_KINDS = e(['MANUAL_IMPORT', 'PAPER', 'KTRADE_OFFICIAL_API', 'KTRADE_BROWSER']);
export type BrokerAdapterKind = (typeof BROKER_ADAPTER_KINDS)[number];

export const CONNECTION_STATUSES = e([
  'DISABLED',
  'PENDING_AUTHORIZATION',
  'PENDING_USER_LOGIN',
  'CONNECTED',
  'SESSION_EXPIRED',
  'ERROR',
  'REVOKED',
]);
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const ORDER_SIDES = e(['BUY', 'SELL']);
export type OrderSide = (typeof ORDER_SIDES)[number];

export const ORDER_TYPES = e(['MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LIMIT']);
export type OrderType = (typeof ORDER_TYPES)[number];

export const TIME_IN_FORCE = e(['DAY', 'GTC']);
export type TimeInForce = (typeof TIME_IN_FORCE)[number];

export const EXECUTION_MODES = e(['BACKTEST', 'PAPER', 'LIVE']);
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const ORDER_ORIGINS = e(['MANUAL', 'STRATEGY', 'ALERT', 'AI_SUGGESTION']);
export type OrderOrigin = (typeof ORDER_ORIGINS)[number];

export const ORDER_STATUSES = e([
  'DRAFT',
  'PREVIEWED',
  'REJECTED_BY_RISK',
  'APPROVED',
  'EXPIRED',
  'AWAITING_MANUAL_PLACEMENT',
  'PLACED_BY_USER',
  'SUBMITTED',
  'ACCEPTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'REJECTED_BY_BROKER',
  'UNKNOWN',
]);
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TRANSACTION_TYPES = e([
  'BUY',
  'SELL',
  'BONUS_IN',
  'SPLIT_ADJUSTMENT',
  'RIGHTS_SUBSCRIPTION',
  'TRANSFER_IN',
  'TRANSFER_OUT',
]);
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const CASH_MOVEMENT_TYPES = e([
  'DEPOSIT',
  'WITHDRAWAL',
  'TRADE_DEBIT',
  'TRADE_CREDIT',
  'FEE',
  'TAX',
  'DIVIDEND',
  'PROFIT_ON_IDLE_FUNDS',
  'ADJUSTMENT',
]);
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export const FEE_COMPONENTS = e([
  'COMMISSION',
  'SST_ON_COMMISSION',
  'CDC_CHARGES',
  'NCCPL_CHARGES',
  'SECP_LEVY',
  'PSX_LEVY',
  'CVT',
  'CGT',
  'DIVIDEND_WHT',
  'ZAKAT',
  'OTHER',
]);
export type FeeComponent = (typeof FEE_COMPONENTS)[number];

export const FEE_APPLIES_TO = e(['BUY', 'SELL', 'BOTH', 'DIVIDEND']);
export type FeeAppliesTo = (typeof FEE_APPLIES_TO)[number];

export const FEE_METHODS = e([
  'PCT_OF_VALUE',
  'PER_SHARE',
  'MAX_OF_PCT_OR_PER_SHARE',
  'FIXED',
  'PCT_OF_COMPONENT',
  'AT_ACTUAL',
]);
export type FeeMethod = (typeof FEE_METHODS)[number];

export const TAX_TYPES = e(['CAPITAL_GAINS', 'DIVIDEND_WITHHOLDING']);
export type TaxType = (typeof TAX_TYPES)[number];

export const CORPORATE_ACTION_TYPES = e(['CASH_DIVIDEND', 'BONUS', 'SPLIT', 'REVERSE_SPLIT', 'RIGHTS']);
export type CorporateActionType = (typeof CORPORATE_ACTION_TYPES)[number];

export const DIVIDEND_PAYMENT_STATUSES = e(['ANNOUNCED', 'ENTITLED', 'PAID', 'RECONCILED', 'CANCELLED']);
export type DividendPaymentStatus = (typeof DIVIDEND_PAYMENT_STATUSES)[number];

export const IMPORT_KINDS = e([
  'CONTRACT_NOTE',
  'LEDGER_STATEMENT',
  'HOLDINGS_STATEMENT',
  'CDC_STATEMENT',
  'DIVIDEND_STATEMENT',
  'GENERIC_TRANSACTIONS_CSV',
  'PRICE_HISTORY_CSV',
]);
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_CHANNELS = e(['UPLOAD', 'MAILBOX', 'BROWSER_ADAPTER', 'BROKER_API']);
export type ImportChannel = (typeof IMPORT_CHANNELS)[number];

export const IMPORT_STATUSES = e([
  'UPLOADED',
  'PARSING',
  'AWAITING_REVIEW',
  'COMMITTING',
  'COMMITTED',
  'REJECTED',
  'FAILED',
]);
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const IMPORT_ROW_STATUSES = e([
  'PENDING',
  'VALID',
  'INVALID',
  'DUPLICATE',
  'MATCHED',
  'COMMITTED',
  'SKIPPED',
]);
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const PRICE_INTERVALS = e(['M1', 'M5', 'M15', 'H1', 'D1']);
export type PriceInterval = (typeof PRICE_INTERVALS)[number];

export const STRATEGY_TYPES = e([
  'MA_CROSSOVER',
  'RSI',
  'MACD',
  'STOP_LOSS',
  'TAKE_PROFIT',
  'TRAILING_STOP',
  'PRICE_ALERT',
  'CUSTOM_RULES',
]);
export type StrategyType = (typeof STRATEGY_TYPES)[number];

export const SIGNAL_TYPES = e(['ENTRY', 'EXIT']);
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const SIGNAL_REASONS = e([
  'RULE_ENTRY',
  'RULE_EXIT',
  'STOP_LOSS',
  'TRAILING_STOP',
  'TAKE_PROFIT',
  'PRICE_TARGET',
  'MANUAL',
]);
export type SignalReason = (typeof SIGNAL_REASONS)[number];

export const SIGNAL_STATUSES = e([
  'NEW',
  'ORDER_PREPARED',
  'AUTO_EXECUTED_PAPER',
  'DISMISSED',
  'EXPIRED',
  'BLOCKED_BY_RISK',
]);
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export const RUN_STATUSES = e(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ALERT_TYPES = e([
  'PRICE_ABOVE',
  'PRICE_BELOW',
  'PCT_CHANGE_ABOVE',
  'PCT_CHANGE_BELOW',
  'VOLUME_SPIKE',
  'PORTFOLIO_DAILY_LOSS',
  'POSITION_STOP_LOSS',
  'ORDER_EXECUTED',
  'ORDER_REJECTED',
  'DIVIDEND_ANNOUNCED',
  'DIVIDEND_RECEIVED',
  'STRATEGY_SIGNAL',
  'SYNC_DISCREPANCY',
  'BROKER_SESSION_EXPIRED',
]);
export type AlertType = (typeof ALERT_TYPES)[number];

export const NOTIFICATION_CHANNELS = e(['IN_APP', 'EMAIL', 'TELEGRAM']);
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = e(['PENDING', 'SENT', 'FAILED', 'READ']);
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const ACTOR_TYPES = e(['USER', 'SYSTEM', 'WORKER', 'STRATEGY', 'BROWSER_AGENT']);
export type ActorType = (typeof ACTOR_TYPES)[number];

export const AI_MESSAGE_ROLES = e(['USER', 'ASSISTANT', 'TOOL']);
export type AiMessageRole = (typeof AI_MESSAGE_ROLES)[number];

/** Every enum keyed by its Prisma enum name — consumed by the enum-sync test. */
export const ALL_ENUMS: Readonly<Record<string, readonly string[]>> = {
  DataSource: DATA_SOURCES,
  Role: ROLES,
  PortfolioKind: PORTFOLIO_KINDS,
  CostBasisMethod: COST_BASIS_METHODS,
  TaxFilerStatus: TAX_FILER_STATUSES,
  BrokerAdapterKind: BROKER_ADAPTER_KINDS,
  ConnectionStatus: CONNECTION_STATUSES,
  OrderSide: ORDER_SIDES,
  OrderType: ORDER_TYPES,
  TimeInForce: TIME_IN_FORCE,
  ExecutionMode: EXECUTION_MODES,
  OrderOrigin: ORDER_ORIGINS,
  OrderStatus: ORDER_STATUSES,
  TransactionType: TRANSACTION_TYPES,
  CashMovementType: CASH_MOVEMENT_TYPES,
  FeeComponent: FEE_COMPONENTS,
  FeeAppliesTo: FEE_APPLIES_TO,
  FeeMethod: FEE_METHODS,
  TaxType: TAX_TYPES,
  CorporateActionType: CORPORATE_ACTION_TYPES,
  DividendPaymentStatus: DIVIDEND_PAYMENT_STATUSES,
  ImportKind: IMPORT_KINDS,
  ImportChannel: IMPORT_CHANNELS,
  ImportStatus: IMPORT_STATUSES,
  ImportRowStatus: IMPORT_ROW_STATUSES,
  PriceInterval: PRICE_INTERVALS,
  StrategyType: STRATEGY_TYPES,
  SignalType: SIGNAL_TYPES,
  SignalReason: SIGNAL_REASONS,
  SignalStatus: SIGNAL_STATUSES,
  RunStatus: RUN_STATUSES,
  AlertType: ALERT_TYPES,
  NotificationChannel: NOTIFICATION_CHANNELS,
  NotificationStatus: NOTIFICATION_STATUSES,
  ActorType: ACTOR_TYPES,
  AiMessageRole: AI_MESSAGE_ROLES,
};
