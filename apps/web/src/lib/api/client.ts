'use client';

/**
 * The `ApiClient` contract the whole UI depends on. `DemoApiClient` implements it in memory;
 * an `HttpApiClient` against the BFF (`/bff/*`, httpOnly-cookie auth) is a drop-in swap via
 * `<ApiClientProvider client={...}>`. Method groups follow docs/07 §2.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { ImportKind } from '@ktrade/shared';
import type {
  Alert,
  AssistantMessage,
  Backtest,
  BacktestRequest,
  BrokerConnection,
  CandleSeries,
  CashMovement,
  ChannelConfig,
  ChartRange,
  DashboardCharts,
  DashboardSummary,
  DataMode,
  Discrepancy,
  Dividend,
  FeeEstimate,
  FeeEstimateQuery,
  FeeScheduleRow,
  FeesTaxes,
  FillRequest,
  Holding,
  HoldingDetail,
  ImportBatch,
  ImportRow,
  KillSwitch,
  LoginRequest,
  LoginResult,
  MailboxStatus,
  MarketProvider,
  MoverType,
  Notification,
  Order,
  OrderFilters,
  OrderPreviewRequest,
  PerformancePeriod,
  PerformanceRow,
  Portfolio,
  Quote,
  QuoteTick,
  RealizedUnrealized,
  RegisterRequest,
  Report,
  ReportFormat,
  ReportType,
  RiskLimits,
  SecurityOverview,
  Session,
  Signal,
  StepUpToken,
  Stock,
  Strategy,
  StrategyInput,
  StrategyTemplate,
  TaxRate,
  Transaction,
  TransactionFilters,
  Unsubscribe,
  User,
  UserSettings,
  Watchlist,
} from './types';

export interface AuthApi {
  login(req: LoginRequest): Promise<LoginResult>;
  register(req: RegisterRequest): Promise<User>;
  logout(): Promise<void>;
  me(): Promise<User | null>;
  /** TOTP → short-lived step-up token for 🔐 operations. */
  stepUp(totpCode: string): Promise<StepUpToken>;
}

export interface SystemApi {
  dataMode(): Promise<DataMode>;
  killSwitch(): Promise<KillSwitch>;
  setKillSwitch(input: { liveTradingEnabled: boolean; reason: string; stepUpToken: string }): Promise<KillSwitch>;
}

export interface DashboardApi {
  summary(portfolioId: string): Promise<DashboardSummary>;
  charts(portfolioId: string, range: ChartRange): Promise<DashboardCharts>;
}

export interface PortfoliosApi {
  list(): Promise<Portfolio[]>;
  holdings(portfolioId: string): Promise<Holding[]>;
  holding(portfolioId: string, symbol: string): Promise<HoldingDetail>;
  transactions(portfolioId: string, filters?: TransactionFilters): Promise<Transaction[]>;
  cashMovements(portfolioId: string): Promise<CashMovement[]>;
  resetPaper(portfolioId: string, stepUpToken: string): Promise<Portfolio>;
}

export interface OrdersApi {
  preview(req: OrderPreviewRequest): Promise<Order>;
  approve(orderId: string, input: { previewHash: string; stepUpToken: string }): Promise<Order>;
  markPlaced(orderId: string, input: { brokerOrderRef?: string }): Promise<Order>;
  recordFill(orderId: string, fill: FillRequest): Promise<Order>;
  cancel(orderId: string): Promise<Order>;
  list(filters?: OrderFilters): Promise<Order[]>;
  get(orderId: string): Promise<Order>;
  feeEstimate(q: FeeEstimateQuery): Promise<FeeEstimate>;
  riskLimits(portfolioId: string): Promise<RiskLimits>;
  updateRiskLimits(limits: RiskLimits, stepUpToken: string): Promise<RiskLimits>;
}

export interface MarketApi {
  stocks(query?: { search?: string; sector?: string }): Promise<Stock[]>;
  stock(symbol: string): Promise<Stock>;
  quotes(symbols?: string[]): Promise<Quote[]>;
  candles(symbol: string, query?: { from?: string; to?: string }): Promise<CandleSeries>;
  movers(type: MoverType, limit?: number): Promise<Quote[]>;
  providers(): Promise<MarketProvider[]>;
  watchlists(): Promise<Watchlist[]>;
  createWatchlist(name: string): Promise<Watchlist>;
  addToWatchlist(watchlistId: string, symbol: string): Promise<Watchlist>;
  removeFromWatchlist(watchlistId: string, symbol: string): Promise<Watchlist>;
  /** Realtime `quote` events (Socket.IO `/realtime` in the HTTP client). */
  subscribeQuotes(symbols: string[], onTick: (tick: QuoteTick) => void): Unsubscribe;
}

export interface StrategiesApi {
  templates(): Promise<StrategyTemplate[]>;
  list(): Promise<Strategy[]>;
  create(input: StrategyInput): Promise<Strategy>;
  setActive(strategyId: string, active: boolean): Promise<Strategy>;
  signals(query?: { strategyId?: string }): Promise<Signal[]>;
  dismissSignal(signalId: string): Promise<Signal>;
}

export interface BacktestsApi {
  run(req: BacktestRequest): Promise<Backtest>;
  list(): Promise<Backtest[]>;
  get(id: string): Promise<Backtest>;
}

export interface DividendsApi {
  list(portfolioId: string): Promise<Dividend[]>;
}

export interface AnalyticsApi {
  performance(portfolioId: string, period: PerformancePeriod): Promise<PerformanceRow[]>;
  realizedUnrealized(portfolioId: string): Promise<RealizedUnrealized>;
  feesTaxes(portfolioId: string): Promise<FeesTaxes>;
}

export interface ReportsApi {
  create(input: { type: ReportType; format: ReportFormat; portfolioId: string }): Promise<Report>;
  list(): Promise<Report[]>;
}

export interface NotificationsApi {
  list(query?: { unread?: boolean }): Promise<Notification[]>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  alerts(): Promise<Alert[]>;
  setAlertActive(id: string, active: boolean): Promise<Alert>;
}

export interface AssistantApi {
  history(): Promise<AssistantMessage[]>;
  send(text: string): Promise<AssistantMessage[]>;
}

export interface BrokerApi {
  connections(): Promise<BrokerConnection[]>;
  imports(): Promise<ImportBatch[]>;
  importRows(importId: string): Promise<ImportRow[]>;
  upload(input: { fileName: string; kind?: ImportKind; size: number }): Promise<ImportBatch>;
  commitImport(importId: string): Promise<ImportBatch>;
  rejectImport(importId: string): Promise<ImportBatch>;
  mailbox(): Promise<MailboxStatus>;
  discrepancies(): Promise<Discrepancy[]>;
}

export interface SecurityApi {
  overview(): Promise<SecurityOverview>;
  sessions(): Promise<Session[]>;
  revokeSession(id: string): Promise<void>;
  revokeAllSessions(): Promise<void>;
  destroyAll(stepUpToken: string): Promise<void>;
}

export interface SettingsApi {
  feeSchedules(): Promise<FeeScheduleRow[]>;
  taxRates(): Promise<TaxRate[]>;
  channels(): Promise<ChannelConfig[]>;
  updateChannel(config: ChannelConfig): Promise<ChannelConfig>;
  testChannel(channel: ChannelConfig['channel']): Promise<{ ok: boolean; message: string }>;
  user(): Promise<UserSettings>;
  updateUser(s: UserSettings): Promise<UserSettings>;
}

export interface ApiClient {
  readonly kind: 'demo' | 'http';
  auth: AuthApi;
  system: SystemApi;
  dashboard: DashboardApi;
  portfolios: PortfoliosApi;
  orders: OrdersApi;
  market: MarketApi;
  strategies: StrategiesApi;
  backtests: BacktestsApi;
  dividends: DividendsApi;
  analytics: AnalyticsApi;
  reports: ReportsApi;
  notifications: NotificationsApi;
  assistant: AssistantApi;
  broker: BrokerApi;
  security: SecurityApi;
  settings: SettingsApi;
}


const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return createElement(ApiClientContext.Provider, { value: client }, children);
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error('useApiClient must be used inside <ApiClientProvider>');
  return client;
}
