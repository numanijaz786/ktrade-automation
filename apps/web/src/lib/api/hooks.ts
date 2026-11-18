'use client';

/**
 * TanStack Query hooks over `useApiClient()`. Components never import a concrete client.
 * Query keys are namespaced per endpoint group so mutations can invalidate precisely.
 */
import { useEffect } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useApiClient } from './client';
import type {
  AlertInput,
  AlertUpdate,
  BacktestCompareRequest,
  BacktestRequest,
  ChannelConfig,
  ChartRange,
  DividendDeclarationInput,
  DividendDeclarationUpdate,
  DividendMarkPaidInput,
  DividendReconcileInput,
  FillRequest,
  MoverType,
  Order,
  OrderFilters,
  OrderPreviewRequest,
  PerformancePeriod,
  PerformanceRange,
  Quote,
  QuoteTick,
  RiskLimits,
  StockQuery,
  StepUpProof,
  StrategyInput,
  StrategyUpdate,
  StrategyValidateRequest,
  UserSettings,
} from './types';
import type { ImportKind } from '@ktrade/shared';
import type { ImportRowAction } from './types';

export const qk = {
  dataMode: ['system', 'dataMode'] as const,
  killSwitch: ['system', 'killSwitch'] as const,
  me: ['auth', 'me'] as const,
  portfolios: ['portfolios'] as const,
  summary: (pf: string) => ['dashboard', 'summary', pf] as const,
  charts: (pf: string, r: ChartRange) => ['dashboard', 'charts', pf, r] as const,
  portfolioPerformance: (pf: string, r: PerformanceRange) => ['dashboard', 'performance', pf, r] as const,
  holdings: (pf: string) => ['portfolio', pf, 'holdings'] as const,
  holding: (pf: string, s: string) => ['portfolio', pf, 'holding', s] as const,
  transactions: (pf: string, limit: number) => ['portfolio', pf, 'transactions', limit] as const,
  cash: (pf: string) => ['portfolio', pf, 'cash'] as const,
  orders: (f: OrderFilters) => ['orders', 'list', f] as const,
  order: (id: string) => ['orders', 'one', id] as const,
  riskLimits: (pf: string) => ['orders', 'riskLimits', pf] as const,
  overview: ['market', 'overview'] as const,
  sectors: ['market', 'sectors'] as const,
  stocks: (q: object) => ['market', 'stocks', q] as const,
  stock: (s: string) => ['market', 'stock', s] as const,
  quotes: (symbols: readonly string[] | 'all') => ['market', 'quotes', symbols] as const,
  candles: (s: string) => ['market', 'candles', s] as const,
  movers: (t: MoverType) => ['market', 'movers', t] as const,
  providers: ['market', 'providers'] as const,
  watchlists: ['market', 'watchlists'] as const,
  templates: ['strategies', 'templates'] as const,
  strategies: ['strategies', 'list'] as const,
  signals: (strategyId?: string) => ['strategies', 'signals', strategyId ?? 'all'] as const,
  backtests: ['backtests'] as const,
  dividendDeclarations: ['dividends', 'declarations'] as const,
  dividendEntitlements: (pf: string) => ['dividends', 'entitlements', pf] as const,
  performance: (pf: string, p: PerformancePeriod) => ['analytics', 'performance', pf, p] as const,
  realized: (pf: string) => ['analytics', 'realized', pf] as const,
  feesTaxes: (pf: string) => ['analytics', 'feesTaxes', pf] as const,
  reports: ['reports'] as const,
  notifications: (unread: boolean, limit: number) => ['notifications', 'list', unread, limit] as const,
  notificationFeed: (unread: boolean) => ['notifications', 'feed', unread] as const,
  alerts: ['alerts'] as const,
  assistant: ['assistant'] as const,
  connections: ['broker', 'connections'] as const,
  imports: ['broker', 'imports'] as const,
  importRows: (id: string) => ['broker', 'importRows', id] as const,
  mailbox: ['broker', 'mailbox'] as const,
  discrepancies: ['broker', 'discrepancies'] as const,
  security: ['security', 'overview'] as const,
  sessions: ['security', 'sessions'] as const,
  feeSchedules: ['settings', 'fees'] as const,
  taxRates: ['settings', 'tax'] as const,
  channels: ['settings', 'channels'] as const,
  userSettings: ['settings', 'user'] as const,
};

/** Portfolio-derived figures move with prices; refresh them on a modest cadence. */
const LIVE_REFRESH_MS = 15_000;
/** The API refreshes quotes at most every 10 s; polling faster only repeats the same snapshot. */
const MARKET_REFRESH_MS = 15_000;

// ─── system & auth ─────────────────────────────────────────────────────────

export function useDataMode() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.dataMode, queryFn: () => api.system.dataMode(), staleTime: Infinity });
}

export function useKillSwitch() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.killSwitch, queryFn: () => api.system.killSwitch() });
}

export function useSetKillSwitch() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { liveTradingEnabled: boolean; reason: string; stepUpToken: string }) =>
      api.system.setKillSwitch(v),
    onSuccess: (data) => qc.setQueryData(qk.killSwitch, data),
  });
}

export function useMe() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.me, queryFn: () => api.auth.me() });
}

export function useLogin() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.auth.login,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useRegister() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.auth.register,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export function useLogout() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api.auth.logout(), onSuccess: () => qc.clear() });
}

export function useStepUp() {
  const api = useApiClient();
  return useMutation({ mutationFn: (proof: StepUpProof) => api.auth.stepUp(proof) });
}

// ─── dashboard & portfolio ─────────────────────────────────────────────────

export function usePortfolios() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.portfolios, queryFn: () => api.portfolios.list() });
}

export function useDashboardSummary(pf: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.summary(pf ?? ''),
    queryFn: () => api.dashboard.summary(pf!),
    enabled: !!pf,
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useDashboardCharts(pf: string | undefined, range: ChartRange) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.charts(pf ?? '', range),
    queryFn: () => api.dashboard.charts(pf!, range),
    enabled: !!pf,
  });
}

export function usePortfolioPerformance(pf: string | undefined, range: PerformanceRange) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.portfolioPerformance(pf ?? '', range),
    queryFn: () => api.dashboard.performance(pf!, range),
    enabled: !!pf,
    placeholderData: keepPreviousData,
  });
}

export function useBackfillSnapshots() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pf: string) => api.dashboard.backfillSnapshots(pf),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard'] }),
  });
}

export function useHoldings(pf: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.holdings(pf ?? ''),
    queryFn: () => api.portfolios.holdings(pf!),
    enabled: !!pf,
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useHoldingDetail(pf: string | undefined, symbol: string | null) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.holding(pf ?? '', symbol ?? ''),
    queryFn: () => api.portfolios.holding(pf!, symbol!),
    enabled: !!pf && !!symbol,
  });
}

/** Cursor-paged, newest first; `fetchNextPage()` loads more. */
export function useTransactions(pf: string | undefined, limit = 50) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: qk.transactions(pf ?? '', limit),
    queryFn: ({ pageParam }) => api.portfolios.transactions(pf!, { cursor: pageParam, limit }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!pf,
  });
}

export function useCreatePaperPortfolio() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; initialCash: string }) => api.portfolios.createPaper(v),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.portfolios }),
  });
}

export function useCashMovements(pf: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.cash(pf ?? ''),
    queryFn: () => api.portfolios.cashMovements(pf!),
    enabled: !!pf,
  });
}

export function useResetPaper() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { portfolioId: string; stepUpToken: string }) =>
      api.portfolios.resetPaper(v.portfolioId, v.stepUpToken),
    onSuccess: () => invalidatePortfolio(qc),
  });
}

function invalidatePortfolio(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [
    ['portfolio'],
    ['dashboard'],
    ['orders'],
    ['analytics'],
    ['notifications'],
  ] as QueryKey[]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

// ─── orders ────────────────────────────────────────────────────────────────

/** Cursor-paged, newest first; `fetchNextPage()` loads more. */
export function useOrders(filters: Omit<OrderFilters, 'cursor'> = {}) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: qk.orders(filters),
    queryFn: ({ pageParam }) => api.orders.list({ ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * The fee breakdown is only returned by the preview; later reads of the same order omit it. Keep the
 * previewed lines (still ESTIMATED) instead of dropping them.
 */
export function keepFeeLines(prev: Order | undefined, next: Order): Order {
  if (!prev?.estimate?.fees.length || !next.estimate || next.estimate.fees.length) return next;
  return { ...next, estimate: { ...next.estimate, fees: prev.estimate.fees } };
}

export function useOrder(id: string | null) {
  const api = useApiClient();
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.order(id ?? ''),
    queryFn: async () => keepFeeLines(qc.getQueryData<Order>(qk.order(id!)), await api.orders.get(id!)),
    enabled: !!id,
  });
}

function useOrderMutation<V>(fn: (v: V) => ReturnType<ReturnType<typeof useApiClient>['orders']['get']>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (order) => {
      qc.setQueryData<Order>(qk.order(order.id), (prev) => keepFeeLines(prev, order));
      invalidatePortfolio(qc);
    },
  });
}

export function usePreviewOrder() {
  const api = useApiClient();
  return useOrderMutation((req: OrderPreviewRequest) => api.orders.preview(req));
}

export function useApproveOrder() {
  const api = useApiClient();
  return useOrderMutation((v: { orderId: string; previewHash: string; stepUpToken: string }) =>
    api.orders.approve(v.orderId, v),
  );
}

export function useMarkPlaced() {
  const api = useApiClient();
  return useOrderMutation((v: { orderId: string; brokerOrderRef?: string }) =>
    api.orders.markPlaced(v.orderId, v),
  );
}

export function useRecordFill() {
  const api = useApiClient();
  return useOrderMutation((v: { orderId: string } & FillRequest) => api.orders.recordFill(v.orderId, v));
}

export function useCancelOrder() {
  const api = useApiClient();
  return useOrderMutation((orderId: string) => api.orders.cancel(orderId));
}

export function useRiskLimits(pf: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.riskLimits(pf ?? ''),
    queryFn: () => api.orders.riskLimits(pf!),
    enabled: !!pf,
  });
}

export function useUpdateRiskLimits() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { limits: RiskLimits; stepUpToken: string }) =>
      api.orders.updateRiskLimits(v.limits, v.stepUpToken),
    onSuccess: (d) => qc.setQueryData(qk.riskLimits(d.portfolioId), d),
  });
}

// ─── market ────────────────────────────────────────────────────────────────

export function useMarketOverview() {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.overview,
    queryFn: () => api.market.overview(),
    refetchInterval: MARKET_REFRESH_MS,
  });
}

export function useSectors() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.sectors, queryFn: () => api.market.sectors(), staleTime: 60_000 });
}

export function useStocks(q: StockQuery = {}) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.stocks(q),
    queryFn: () => api.market.stocks(q),
    placeholderData: keepPreviousData,
    refetchInterval: MARKET_REFRESH_MS,
  });
}

export function useStock(symbol: string) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.stock(symbol),
    queryFn: () => api.market.stock(symbol),
    refetchInterval: MARKET_REFRESH_MS,
  });
}

export function useQuotes(symbols?: readonly string[]) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.quotes(symbols ?? 'all'),
    queryFn: () => api.market.quotes(symbols ? [...symbols] : undefined),
  });
}

/** Daily candles from `from` (YYYY-MM-DD) to today; the API defaults to ~6 months. */
export function useCandles(symbol: string, from?: string) {
  const api = useApiClient();
  return useQuery({
    queryKey: [...qk.candles(symbol), from ?? 'default'],
    queryFn: () => api.market.candles(symbol, from ? { from } : {}),
    staleTime: 60_000,
  });
}

export function useMovers(type: MoverType) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.movers(type),
    queryFn: () => api.market.movers(type, 8),
    refetchInterval: 5_000,
  });
}

export function useProviders() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.providers, queryFn: () => api.market.providers() });
}

export function useWatchlists() {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.watchlists,
    queryFn: () => api.market.watchlists(),
    refetchInterval: MARKET_REFRESH_MS,
  });
}

export function useWatchlistMutations() {
  const api = useApiClient();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: qk.watchlists });
  return {
    create: useMutation({
      mutationFn: (v: { name: string; symbols?: string[] }) => api.market.createWatchlist(v.name, v.symbols),
      onSuccess: done,
    }),
    rename: useMutation({
      mutationFn: (v: { id: string; name: string }) => api.market.renameWatchlist(v.id, v.name),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.market.deleteWatchlist(id),
      onSuccess: done,
    }),
    addSymbol: useMutation({
      mutationFn: (v: { id: string; symbol: string }) => api.market.addToWatchlist(v.id, v.symbol),
      onSuccess: done,
    }),
    removeSymbol: useMutation({
      mutationFn: (v: { id: string; symbol: string }) => api.market.removeFromWatchlist(v.id, v.symbol),
      onSuccess: done,
    }),
  };
}

function applyTick(q: Quote, t: QuoteTick): Quote {
  return {
    ...q,
    last: t.last,
    change: t.change,
    changePct: t.changePct,
    volume: t.volume,
    high: t.high ?? q.high,
    low: t.low ?? q.low,
    asOf: t.asOf,
    source: t.source,
    delayMinutes: t.delayMinutes,
    stale: t.stale ?? q.stale,
  };
}

/**
 * Subscribe to realtime quote ticks for `symbols` and patch every cached quote list in place
 * (the WebSocket-driven cache update described in docs/02 §7).
 */
export function useLiveQuotes(symbols: readonly string[]) {
  const api = useApiClient();
  const qc = useQueryClient();
  const key = symbols.join(',');
  useEffect(() => {
    if (!key) return;
    let pending = new Map<string, QuoteTick>();
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const ticks = pending;
      pending = new Map();
      qc.setQueriesData<Quote[]>({ queryKey: ['market', 'quotes'] }, (old) =>
        old?.map((q) => (ticks.has(q.symbol) ? applyTick(q, ticks.get(q.symbol)!) : q)),
      );
    };
    return api.market.subscribeQuotes(key.split(','), (t) => {
      pending.set(t.symbol, t);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    });
  }, [api, qc, key]);
}

// ─── strategies & backtests ────────────────────────────────────────────────

export function useStrategyTemplates() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.templates, queryFn: () => api.strategies.templates(), staleTime: Infinity });
}

export function useStrategies() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.strategies, queryFn: () => api.strategies.list() });
}

export function useSignals(strategyId?: string) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.signals(strategyId),
    queryFn: () => api.strategies.signals({ strategyId }),
  });
}

export function useStrategyMutations() {
  const api = useApiClient();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ['strategies'] });
  return {
    create: useMutation({ mutationFn: (v: StrategyInput) => api.strategies.create(v), onSuccess: done }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: StrategyUpdate }) => api.strategies.update(v.id, v.patch),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.strategies.remove(id), onSuccess: done }),
    setActive: useMutation({
      mutationFn: (v: { id: string; active: boolean; stepUpToken?: string }) =>
        api.strategies.setActive(v.id, v.active, v.stepUpToken),
      onSuccess: done,
    }),
    validate: useMutation({ mutationFn: (v: StrategyValidateRequest) => api.strategies.validate(v) }),
    evaluate: useMutation({
      mutationFn: (id: string) => api.strategies.evaluate(id),
      onSuccess: () => {
        void done();
        invalidatePortfolio(qc);
      },
    }),
  };
}

export function useBacktests() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.backtests, queryFn: () => api.backtests.list() });
}

export function useBacktest(id: string | null) {
  const api = useApiClient();
  return useQuery({
    queryKey: [...qk.backtests, 'one', id ?? ''],
    queryFn: () => api.backtests.get(id!),
    enabled: !!id,
  });
}

export function useBacktestTrades(id: string | null) {
  const api = useApiClient();
  return useQuery({
    queryKey: [...qk.backtests, 'trades', id ?? ''],
    queryFn: () => api.backtests.trades(id!),
    enabled: !!id,
  });
}

export function useRunBacktest() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: BacktestRequest) => api.backtests.run(req),
    onSuccess: (bt) => {
      qc.setQueryData([...qk.backtests, 'one', bt.id], bt);
      void qc.invalidateQueries({ queryKey: qk.backtests, exact: true });
    },
  });
}

export function useCompareBacktests() {
  const api = useApiClient();
  return useMutation({ mutationFn: (req: BacktestCompareRequest) => api.backtests.compare(req) });
}

// ─── dividends, analytics, reports ─────────────────────────────────────────

export function useDividendDeclarations() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.dividendDeclarations, queryFn: () => api.dividends.declarations() });
}

export function useDividendEntitlements(pf: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.dividendEntitlements(pf ?? ''),
    queryFn: () => api.dividends.entitlements(pf!),
    enabled: !!pf,
  });
}

/**
 * Declaration edits clear estimated entitlements, and payments move cash, so every dividend mutation
 * refreshes all dividend queries; payments also refresh the portfolio, dashboard and inbox.
 */
export function useDividendMutations() {
  const api = useApiClient();
  const qc = useQueryClient();
  const dividends = () => qc.invalidateQueries({ queryKey: ['dividends'] });
  const money = () => {
    void dividends();
    void qc.invalidateQueries({ queryKey: ['portfolio'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return {
    create: useMutation({
      mutationFn: (input: DividendDeclarationInput) => api.dividends.createDeclaration(input),
      onSuccess: dividends,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: DividendDeclarationUpdate }) =>
        api.dividends.updateDeclaration(v.id, v.patch),
      onSuccess: dividends,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.dividends.deleteDeclaration(id),
      onSuccess: dividends,
    }),
    compute: useMutation({
      mutationFn: (portfolioId: string) => api.dividends.compute(portfolioId),
      onSuccess: dividends,
    }),
    markPaid: useMutation({
      mutationFn: (v: { id: string; input: DividendMarkPaidInput }) => api.dividends.markPaid(v.id, v.input),
      onSuccess: money,
    }),
    reconcile: useMutation({
      mutationFn: (v: { id: string; input?: DividendReconcileInput }) =>
        api.dividends.reconcile(v.id, v.input),
      onSuccess: money,
    }),
  };
}

export function usePerformance(pf: string | undefined, period: PerformancePeriod) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.performance(pf ?? '', period),
    queryFn: () => api.analytics.performance(pf!, period),
    enabled: !!pf,
  });
}

export function useRealizedUnrealized(pf: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.realized(pf ?? ''),
    queryFn: () => api.analytics.realizedUnrealized(pf!),
    enabled: !!pf,
  });
}

export function useFeesTaxes(pf: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.feesTaxes(pf ?? ''),
    queryFn: () => api.analytics.feesTaxes(pf!),
    enabled: !!pf,
  });
}

export function useReports() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.reports, queryFn: () => api.reports.list() });
}

export function useCreateReport() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.reports.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.reports }),
  });
}

// ─── notifications & assistant ─────────────────────────────────────────────

/** The unread badge polls every 30 s against the real API (no push channel yet); demo data never changes. */
export const NOTIFICATION_POLL_MS = 30_000;

export function useNotifications(unread = false, limit = 20) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.notifications(unread, limit),
    queryFn: () => api.notifications.list({ unread, limit }),
    refetchInterval: api.kind === 'http' ? NOTIFICATION_POLL_MS : false,
  });
}

/** The full inbox, cursor-paged. */
export function useNotificationFeed(unread = false) {
  const api = useApiClient();
  return useInfiniteQuery({
    queryKey: qk.notificationFeed(unread),
    queryFn: ({ pageParam }) => api.notifications.list({ unread, limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useNotificationMutations() {
  const api = useApiClient();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  return {
    markRead: useMutation({ mutationFn: (id: string) => api.notifications.markRead(id), onSuccess: done }),
    markAllRead: useMutation({ mutationFn: () => api.notifications.markAllRead(), onSuccess: done }),
  };
}

export function useAlerts() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.alerts, queryFn: () => api.alerts.list() });
}

export function useAlertMutations() {
  const api = useApiClient();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: qk.alerts });
  return {
    create: useMutation({ mutationFn: (input: AlertInput) => api.alerts.create(input), onSuccess: done }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: AlertUpdate }) => api.alerts.update(v.id, v.patch),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.alerts.remove(id), onSuccess: done }),
    evaluate: useMutation({
      mutationFn: () => api.alerts.evaluate(),
      onSuccess: () => {
        void done();
        void qc.invalidateQueries({ queryKey: ['notifications'] });
      },
    }),
  };
}

export function useAssistantHistory() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.assistant, queryFn: () => api.assistant.history() });
}

export function useSendAssistant() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.assistant.send(text),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.assistant }),
  });
}

// ─── broker & sync ─────────────────────────────────────────────────────────

export function useConnections() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.connections, queryFn: () => api.broker.connections() });
}

export function useRegisterBrokerAccount() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { displayName: string; clientCodeLast4?: string; portfolioName?: string }) =>
      api.broker.registerAccount(v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['broker'] });
      void qc.invalidateQueries({ queryKey: qk.portfolios });
    },
  });
}

export function useImports() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.imports, queryFn: () => api.broker.imports() });
}

export function useImportRows(id: string | null) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.importRows(id ?? ''),
    queryFn: () => api.broker.importRows(id!),
    enabled: !!id,
  });
}

export function useImportMutations() {
  const api = useApiClient();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ['broker'] });
  return {
    upload: useMutation({
      mutationFn: (v: { portfolioId: string; fileName: string; content: string; kind?: ImportKind }) =>
        api.broker.upload(v),
      onSuccess: done,
    }),
    updateRow: useMutation({
      mutationFn: (v: { importId: string; rowId: string; action: ImportRowAction }) =>
        api.broker.updateImportRow(v.importId, v.rowId, v.action),
      onSuccess: done,
    }),
    commit: useMutation({ mutationFn: (id: string) => api.broker.commitImport(id), onSuccess: done }),
    reject: useMutation({ mutationFn: (id: string) => api.broker.rejectImport(id), onSuccess: done }),
  };
}

export function useMailbox() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.mailbox, queryFn: () => api.broker.mailbox() });
}

export function useDiscrepancies() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.discrepancies, queryFn: () => api.broker.discrepancies() });
}

// ─── security & settings ───────────────────────────────────────────────────

export function useSecurityOverview() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.security, queryFn: () => api.security.overview() });
}

export function useSessions() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.sessions, queryFn: () => api.security.sessions() });
}

export function useSessionMutations() {
  const api = useApiClient();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ['security'] });
  return {
    revoke: useMutation({ mutationFn: (id: string) => api.security.revokeSession(id), onSuccess: done }),
    revokeAll: useMutation({ mutationFn: () => api.security.revokeAllSessions(), onSuccess: done }),
    destroyAll: useMutation({
      mutationFn: (stepUpToken: string) => api.security.destroyAll(stepUpToken),
      onSuccess: () => {
        void done();
        void qc.invalidateQueries({ queryKey: ['system'] });
        void qc.invalidateQueries({ queryKey: ['broker'] });
      },
    }),
  };
}

export function useFeeSchedules() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.feeSchedules, queryFn: () => api.settings.feeSchedules() });
}

export function useTaxRates() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.taxRates, queryFn: () => api.settings.taxRates() });
}

export function useChannels() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.channels, queryFn: () => api.settings.channels() });
}

export function useChannelMutations() {
  const api = useApiClient();
  const qc = useQueryClient();
  return {
    update: useMutation({
      mutationFn: (c: ChannelConfig) => api.settings.updateChannel(c),
      onSuccess: () => qc.invalidateQueries({ queryKey: qk.channels }),
    }),
    test: useMutation({ mutationFn: (c: ChannelConfig['channel']) => api.settings.testChannel(c) }),
  };
}

export function useUserSettings() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.userSettings, queryFn: () => api.settings.user() });
}

export function useUpdateUserSettings() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (u: UserSettings) => api.settings.updateUser(u),
    onSuccess: (d) => qc.setQueryData(qk.userSettings, d),
  });
}
