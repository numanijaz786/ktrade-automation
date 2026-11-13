'use client';

/**
 * TanStack Query hooks over `useApiClient()`. Components never import a concrete client.
 * Query keys are namespaced per endpoint group so mutations can invalidate precisely.
 */
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useApiClient } from './client';
import type {
  BacktestRequest,
  ChannelConfig,
  ChartRange,
  FillRequest,
  MoverType,
  OrderFilters,
  OrderPreviewRequest,
  PerformancePeriod,
  Quote,
  QuoteTick,
  RiskLimits,
  StrategyInput,
  TransactionFilters,
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
  holdings: (pf: string) => ['portfolio', pf, 'holdings'] as const,
  holding: (pf: string, s: string) => ['portfolio', pf, 'holding', s] as const,
  transactions: (pf: string, f: TransactionFilters) => ['portfolio', pf, 'transactions', f] as const,
  cash: (pf: string) => ['portfolio', pf, 'cash'] as const,
  orders: (f: OrderFilters) => ['orders', 'list', f] as const,
  order: (id: string) => ['orders', 'one', id] as const,
  riskLimits: (pf: string) => ['orders', 'riskLimits', pf] as const,
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
  dividends: (pf: string) => ['dividends', pf] as const,
  performance: (pf: string, p: PerformancePeriod) => ['analytics', 'performance', pf, p] as const,
  realized: (pf: string) => ['analytics', 'realized', pf] as const,
  feesTaxes: (pf: string) => ['analytics', 'feesTaxes', pf] as const,
  reports: ['reports'] as const,
  notifications: (unread: boolean) => ['notifications', unread] as const,
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
  return useMutation({ mutationFn: (code: string) => api.auth.stepUp(code) });
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

export function useTransactions(pf: string | undefined, filters: TransactionFilters = {}) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.transactions(pf ?? '', filters),
    queryFn: () => api.portfolios.transactions(pf!, filters),
    enabled: !!pf,
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

export function useOrders(filters: OrderFilters = {}) {
  const api = useApiClient();
  return useQuery({ queryKey: qk.orders(filters), queryFn: () => api.orders.list(filters) });
}

export function useOrder(id: string | null) {
  const api = useApiClient();
  return useQuery({ queryKey: qk.order(id ?? ''), queryFn: () => api.orders.get(id!), enabled: !!id });
}

function useOrderMutation<V>(fn: (v: V) => ReturnType<ReturnType<typeof useApiClient>['orders']['get']>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (order) => {
      qc.setQueryData(qk.order(order.id), order);
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

export function useStocks(q: { search?: string; sector?: string } = {}) {
  const api = useApiClient();
  return useQuery({ queryKey: qk.stocks(q), queryFn: () => api.market.stocks(q), staleTime: 5 * 60_000 });
}

export function useStock(symbol: string) {
  const api = useApiClient();
  return useQuery({ queryKey: qk.stock(symbol), queryFn: () => api.market.stock(symbol) });
}

export function useQuotes(symbols?: readonly string[]) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.quotes(symbols ?? 'all'),
    queryFn: () => api.market.quotes(symbols ? [...symbols] : undefined),
  });
}

export function useCandles(symbol: string) {
  const api = useApiClient();
  return useQuery({ queryKey: qk.candles(symbol), queryFn: () => api.market.candles(symbol) });
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
  return useQuery({ queryKey: qk.watchlists, queryFn: () => api.market.watchlists() });
}

export function useWatchlistMutations() {
  const api = useApiClient();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: qk.watchlists });
  return {
    create: useMutation({ mutationFn: (name: string) => api.market.createWatchlist(name), onSuccess: done }),
    add: useMutation({
      mutationFn: (v: { id: string; symbol: string }) => api.market.addToWatchlist(v.id, v.symbol),
      onSuccess: done,
    }),
    remove: useMutation({
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
    setActive: useMutation({
      mutationFn: (v: { id: string; active: boolean }) => api.strategies.setActive(v.id, v.active),
      onSuccess: done,
    }),
    dismiss: useMutation({ mutationFn: (id: string) => api.strategies.dismissSignal(id), onSuccess: done }),
  };
}

export function useBacktests() {
  const api = useApiClient();
  return useQuery({ queryKey: qk.backtests, queryFn: () => api.backtests.list() });
}

export function useRunBacktest() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: BacktestRequest) => api.backtests.run(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.backtests }),
  });
}

// ─── dividends, analytics, reports ─────────────────────────────────────────

export function useDividends(pf: string | undefined) {
  const api = useApiClient();
  return useQuery({
    queryKey: qk.dividends(pf ?? ''),
    queryFn: () => api.dividends.list(pf!),
    enabled: !!pf,
  });
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

export function useNotifications(unread = false) {
  const api = useApiClient();
  return useQuery({ queryKey: qk.notifications(unread), queryFn: () => api.notifications.list({ unread }) });
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
  return useQuery({ queryKey: qk.alerts, queryFn: () => api.notifications.alerts() });
}

export function useSetAlertActive() {
  const api = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; active: boolean }) => api.notifications.setAlertActive(v.id, v.active),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.alerts }),
  });
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
