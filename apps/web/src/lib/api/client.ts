'use client';

/**
 * The `ApiClient` contract the whole UI depends on. `DemoApiClient` implements it in memory;
 * an `HttpApiClient` against the BFF (`/bff/*`, httpOnly-cookie auth) is a drop-in swap via
 * `<ApiClientProvider client={...}>`. Method groups follow docs/07 §2.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { ImportKind, SignalStatus } from '@ktrade/shared';
import type {
  AdvisorHorizon,
  AdvisorRunSummary,
  AdvisorSettings,
  DailyReport,
  HoldingsAdviceReport,
  ScannerFilter,
  ScannerReport,
  StockReport,
  Alert,
  AlertEvaluation,
  AlertInput,
  AlertUpdate,
  AnnouncementInput,
  AnnouncementsImportResult,
  AssistantMessage,
  Backtest,
  BacktestCompareRequest,
  BacktestComparison,
  BacktestRequest,
  BacktestTrades,
  BrokerConnection,
  CandleSeries,
  CashMovement,
  ChannelConfig,
  ChartRange,
  DashboardCharts,
  DashboardSummary,
  DataMode,
  Discrepancy,
  DividendComputeResult,
  DividendDeclaration,
  DividendDeclarationDeleted,
  DividendDeclarationInput,
  DividendDeclarationUpdate,
  DividendDeclarationUpdated,
  DividendEntitlement,
  DividendEntitlementList,
  DividendMarkPaidInput,
  DividendMarkPaidResult,
  DividendReconcileInput,
  FeeEstimate,
  FeeEstimateQuery,
  EvaluationSummary,
  FeeScheduleRow,
  FinancialInput,
  FinancialSaved,
  FinancialsImportResult,
  FinancialsList,
  MacroInput,
  MacroList,
  MacroObservation,
  NewsFeed,
  NewsFeedQuery,
  NewsItem,
  PerformanceQuery,
  RecommendationDetail,
  RecommendationPage,
  RecommendationPerformance,
  RecommendationQuery,
  ResearchProviderStatus,
  FeesTaxes,
  FillRequest,
  Holding,
  HoldingDetail,
  ImportBatch,
  ImportRow,
  ImportRowAction,
  KillSwitch,
  LoginRequest,
  LoginResult,
  MailboxStatus,
  MarketOverview,
  MarketProvider,
  MoverType,
  Notification,
  NotificationPage,
  NotificationQuery,
  Order,
  Paginated,
  OrderFilters,
  OrderPreviewRequest,
  PerformancePeriod,
  PerformanceRange,
  PerformanceRow,
  Portfolio,
  PortfolioPerformance,
  Quote,
  QuoteTick,
  RealizedUnrealized,
  RegisterRequest,
  Report,
  ReportFormat,
  ReportType,
  RiskLimits,
  SecurityOverview,
  SectorSummary,
  Session,
  Signal,
  SnapshotBackfillResult,
  StepUpProof,
  StepUpToken,
  StockDetail,
  StockPage,
  StockQuery,
  Strategy,
  StrategyEvaluation,
  StrategyInput,
  StrategyUpdate,
  StrategyValidateRequest,
  StrategyValidation,
  StrategyTemplate,
  TaxRate,
  Transaction,
  TransactionPageQuery,
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
  /** TOTP code (2FA enabled) or password (no TOTP) → short-lived step-up token for 🔐 operations. */
  stepUp(proof: StepUpProof): Promise<StepUpToken>;
}

export interface SystemApi {
  dataMode(): Promise<DataMode>;
  killSwitch(): Promise<KillSwitch>;
  setKillSwitch(input: {
    liveTradingEnabled: boolean;
    reason: string;
    stepUpToken: string;
  }): Promise<KillSwitch>;
}

export interface DashboardApi {
  summary(portfolioId: string): Promise<DashboardSummary>;
  charts(portfolioId: string, range: ChartRange): Promise<DashboardCharts>;
  /** GET /portfolios/:id/performance?range= — snapshot-backed value series, TWR, drawdown, monthly P&L. */
  performance(portfolioId: string, range: PerformanceRange): Promise<PortfolioPerformance>;
  /** POST /portfolios/:id/snapshots/backfill (OWNER) — rebuild daily close snapshots; idempotent. */
  backfillSnapshots(portfolioId: string): Promise<SnapshotBackfillResult>;
}

export interface PortfoliosApi {
  list(): Promise<Portfolio[]>;
  /** POST /portfolios — a PAPER portfolio with SIMULATED starting cash and default risk limits. */
  createPaper(input: { name: string; initialCash: string }): Promise<Portfolio>;
  holdings(portfolioId: string): Promise<Holding[]>;
  holding(portfolioId: string, symbol: string): Promise<HoldingDetail>;
  transactions(portfolioId: string, query?: TransactionPageQuery): Promise<Paginated<Transaction>>;
  cashMovements(portfolioId: string): Promise<CashMovement[]>;
  resetPaper(portfolioId: string, stepUpToken: string): Promise<Portfolio>;
}

export interface OrdersApi {
  preview(req: OrderPreviewRequest): Promise<Order>;
  approve(orderId: string, input: { previewHash: string; stepUpToken: string }): Promise<Order>;
  markPlaced(orderId: string, input: { brokerOrderRef?: string }): Promise<Order>;
  recordFill(orderId: string, fill: FillRequest): Promise<Order>;
  cancel(orderId: string): Promise<Order>;
  list(filters?: OrderFilters): Promise<Paginated<Order>>;
  get(orderId: string): Promise<Order>;
  feeEstimate(q: FeeEstimateQuery): Promise<FeeEstimate>;
  /** null when the portfolio has no limits configured (the API then refuses to trade). */
  riskLimits(portfolioId: string): Promise<RiskLimits | null>;
  updateRiskLimits(limits: RiskLimits, stepUpToken: string): Promise<RiskLimits>;
}

export interface MarketApi {
  overview(): Promise<MarketOverview>;
  stocks(query?: StockQuery): Promise<StockPage>;
  stock(symbol: string): Promise<StockDetail>;
  sectors(): Promise<SectorSummary[]>;
  quotes(symbols?: string[]): Promise<Quote[]>;
  candles(symbol: string, query?: { from?: string; to?: string }): Promise<CandleSeries>;
  movers(type: MoverType, limit?: number): Promise<Quote[]>;
  providers(): Promise<MarketProvider[]>;
  watchlists(): Promise<Watchlist[]>;
  createWatchlist(name: string, symbols?: string[]): Promise<Watchlist>;
  renameWatchlist(watchlistId: string, name: string): Promise<Watchlist>;
  deleteWatchlist(watchlistId: string): Promise<void>;
  addToWatchlist(watchlistId: string, symbol: string): Promise<Watchlist>;
  removeFromWatchlist(watchlistId: string, symbol: string): Promise<Watchlist>;
  /** Quote updates. The HTTP client polls `/market/quotes` (the API has no realtime gateway yet). */
  subscribeQuotes(symbols: string[], onTick: (tick: QuoteTick) => void): Unsubscribe;
}

export interface StrategiesApi {
  templates(): Promise<StrategyTemplate[]>;
  list(): Promise<Strategy[]>;
  create(input: StrategyInput): Promise<Strategy>;
  update(strategyId: string, patch: StrategyUpdate): Promise<Strategy>;
  /** Refused (409) while the strategy is active. */
  remove(strategyId: string): Promise<void>;
  /** Activating a LIVE strategy needs a step-up token; PAPER activation and any deactivation do not. */
  setActive(strategyId: string, active: boolean, stepUpToken?: string): Promise<Strategy>;
  /** Dry run: validates the definition and replays it over recent bars. Persists nothing. */
  validate(req: StrategyValidateRequest): Promise<StrategyValidation>;
  evaluate(strategyId: string): Promise<StrategyEvaluation>;
  signals(query?: { strategyId?: string; status?: SignalStatus }): Promise<Signal[]>;
}

export interface BacktestsApi {
  run(req: BacktestRequest): Promise<Backtest>;
  list(): Promise<Backtest[]>;
  get(id: string): Promise<Backtest>;
  trades(id: string): Promise<BacktestTrades>;
  compare(req: BacktestCompareRequest): Promise<BacktestComparison>;
}

/** docs/07 "dividends", ADR-031. Declarations are shared reference data; entitlements are per portfolio. */
export interface DividendsApi {
  /** GET /dividends — newest book closure first. */
  declarations(query?: { symbol?: string }): Promise<DividendDeclaration[]>;
  /** POST /dividends (OWNER) — recorded as USER_REPORTED. */
  createDeclaration(input: DividendDeclarationInput): Promise<DividendDeclaration>;
  /** PATCH /dividends/:id (OWNER) — 409 DIVIDEND_LOCKED once paid; clears that dividend's estimates. */
  updateDeclaration(id: string, patch: DividendDeclarationUpdate): Promise<DividendDeclarationUpdated>;
  /** DELETE /dividends/:id (OWNER) — 409 DIVIDEND_LOCKED once paid. */
  deleteDeclaration(id: string): Promise<DividendDeclarationDeleted>;
  /** GET /portfolios/:id/dividend-entitlements */
  entitlements(portfolioId: string): Promise<DividendEntitlementList>;
  /** POST /portfolios/:id/dividend-entitlements/compute (OWNER) — idempotent; paid rows untouched. */
  compute(portfolioId: string): Promise<DividendComputeResult>;
  /** POST /dividend-entitlements/:id/mark-paid (OWNER) — WHT from the payment advice is required. */
  markPaid(entitlementId: string, input: DividendMarkPaidInput): Promise<DividendMarkPaidResult>;
  /** POST /dividend-entitlements/:id/reconcile (OWNER) — PAID → RECONCILED (BROKER_CONFIRMED). */
  reconcile(entitlementId: string, input?: DividendReconcileInput): Promise<DividendEntitlement>;
}

/** docs/10, ADR-034. Everything here is owner-entered (USER_REPORTED) until a licensed source is connected. */
export interface ResearchApi {
  /** GET /research/news-feed — only items inside the freshness window, with lastUpdated and a coverage note. */
  newsFeed(query?: NewsFeedQuery): Promise<NewsFeed>;
  /** POST /research/announcements (OWNER) — 409 DUPLICATE_ANNOUNCEMENT when already recorded. */
  addAnnouncement(input: AnnouncementInput): Promise<NewsItem>;
  /** POST /research/announcements/import (OWNER) — 422 with row-level errors when any row is invalid. */
  importAnnouncements(csv: string): Promise<AnnouncementsImportResult>;
  /** GET /research/financials?symbol= — periods on file, newest first. */
  financials(symbol: string): Promise<FinancialsList>;
  /** POST /research/financials (OWNER) — re-entering a period corrects it in place. */
  saveFinancial(input: FinancialInput): Promise<FinancialSaved>;
  /** POST /research/financials/import (OWNER) — all-or-nothing, 422 with row-level errors. */
  importFinancials(csv: string): Promise<FinancialsImportResult>;
  macro(query?: { series?: MacroObservation['series'] }): Promise<MacroList>;
  addMacro(input: MacroInput): Promise<MacroObservation>;
  /** GET /research/providers */
  providers(): Promise<ResearchProviderStatus[]>;
}

/** AI Investment Advisor (ADR-036). Advisory only: nothing here places or approves an order. */
export interface AdvisorApi {
  /** GET /advisor/daily-report */
  dailyReport(q: { portfolioId: string; horizon: AdvisorHorizon }): Promise<DailyReport>;
  /** GET /advisor/holdings */
  holdings(q: { portfolioId: string; horizon: AdvisorHorizon }): Promise<HoldingsAdviceReport>;
  /** GET /advisor/scanner — may legitimately be empty. */
  scanner(q: {
    filter: ScannerFilter;
    horizon: AdvisorHorizon;
    portfolioId?: string;
  }): Promise<ScannerReport>;
  /** GET /advisor/stocks/:symbol */
  stock(symbol: string, portfolioId?: string): Promise<StockReport>;
  /** POST /advisor/run (OWNER) — evaluates and stores results; idempotent per bar. */
  run(input: { portfolioId: string; horizons?: AdvisorHorizon[] }): Promise<AdvisorRunSummary>;
  /** GET /advisor/settings */
  settings(): Promise<AdvisorSettings>;
  /** PUT /advisor/settings (OWNER, 0 < risk <= 5) */
  updateSettings(riskPerTradePct: string): Promise<AdvisorSettings>;
}

/** Immutable recommendation history and outcome tracking (ADR-034). Never hides failed recommendations. */
export interface RecommendationsApi {
  list(query?: RecommendationQuery): Promise<RecommendationPage>;
  get(id: string): Promise<RecommendationDetail>;
  performance(query?: PerformanceQuery): Promise<RecommendationPerformance>;
  /** POST /recommendations/evaluate-outcomes (OWNER) — appends outcome rows from stored daily bars. */
  evaluateOutcomes(): Promise<EvaluationSummary>;
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

/** The in-app inbox (EMAIL / TELEGRAM delivery is not configured yet). */
export interface NotificationsApi {
  list(query?: NotificationQuery): Promise<NotificationPage>;
  markRead(id: string): Promise<Notification>;
  markAllRead(): Promise<{ updated: number }>;
}

export interface AlertsApi {
  list(): Promise<Alert[]>;
  create(input: AlertInput): Promise<Alert>;
  update(id: string, patch: AlertUpdate): Promise<Alert>;
  remove(id: string): Promise<void>;
  /** POST /alerts/evaluate (OWNER) — evaluate your active alerts now; idempotent per cooldown window. */
  evaluate(): Promise<AlertEvaluation>;
}

export interface AssistantApi {
  history(): Promise<AssistantMessage[]>;
  send(text: string): Promise<AssistantMessage[]>;
}

export interface BrokerApi {
  connections(): Promise<BrokerConnection[]>;
  /**
   * POST /broker/accounts — registers the KTrade account anchor + its LIVE portfolio. Never takes
   * credentials; only the last 4 characters of the client code, optionally.
   */
  registerAccount(input: {
    displayName: string;
    clientCodeLast4?: string;
    portfolioName?: string;
  }): Promise<void>;
  imports(): Promise<ImportBatch[]>;
  importRows(importId: string): Promise<ImportRow[]>;
  /** POST /imports — `content` is the file text (UTF-8, ≤ 2 MB). Target must be a LIVE broker portfolio. */
  upload(input: {
    portfolioId: string;
    fileName: string;
    content: string;
    kind?: ImportKind;
  }): Promise<ImportBatch>;
  /** PATCH /imports/:id/rows/:rowId — skip any row; include only rows flagged DUPLICATE (never INVALID). */
  updateImportRow(importId: string, rowId: string, action: ImportRowAction): Promise<ImportBatch>;
  /** POST /imports/:id/commit — all-or-nothing; blocked while INVALID rows remain. */
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
  research: ResearchApi;
  recommendations: RecommendationsApi;
  advisor: AdvisorApi;
  analytics: AnalyticsApi;
  reports: ReportsApi;
  notifications: NotificationsApi;
  alerts: AlertsApi;
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
