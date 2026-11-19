/**
 * `ApiClient` over the Next.js BFF (`/bff/*`). The browser never sees an access or refresh token:
 * both live in httpOnly cookies that only the BFF reads. Every non-GET call carries the double-submit
 * CSRF header. Groups without a backend yet reject with `NOT_AVAILABLE` and never fall back to demo data.
 */
import type { ApiClient } from './client';
import { ApiError, notAvailable } from './errors';
import {
  type ApiDividend,
  type ApiDividendComputeResult,
  type ApiDividendEntitlement,
  type ApiDividendEntitlementList,
  type ApiMarkPaidResult,
  mapDividendComputeResult,
  mapDividendDeclaration,
  mapDividendDeclarationDeleted,
  mapDividendDeclarationUpdated,
  mapDividendEntitlement,
  mapDividendEntitlementList,
  mapMarkPaidResult,
  toApiDividendInput,
  toApiDividendUpdate,
  toApiMarkPaid,
  type ApiAlert,
  type ApiAlertEvaluation,
  type ApiBackfillResult,
  type ApiNotification,
  type ApiNotificationPage,
  type ApiPerformance,
  mapAlert,
  mapAlertEvaluation,
  mapBackfill,
  mapNotification,
  mapNotificationPage,
  mapPerformance,
  toApiAlertInput,
  toApiAlertUpdate,
  type ApiBacktest,
  type ApiBacktestTrades,
  type ApiComparison,
  type ApiEvaluation,
  type ApiSignal,
  type ApiStrategy,
  type ApiTemplate,
  type ApiValidation,
  type ApiBrokerAccount,
  type ApiCandles,
  type ApiHolding,
  type ApiOrder,
  type ApiOverview,
  type ApiPortfolio,
  type ApiQuote,
  type ApiRiskLimits,
  type ApiSession,
  type ApiStockDetail,
  type ApiStockPage,
  type ApiSummary,
  type ApiTransaction,
  type ApiUser,
  type ApiWatchlist,
  ledgerSourceOf,
  mapBacktest,
  mapBacktestTrades,
  mapComparison,
  mapEvaluation,
  mapSignal,
  mapStrategy,
  mapTemplate,
  mapValidation,
  toApiDefinition,
  toApiStrategyInput,
  toApiStrategyUpdate,
  mapCandles,
  mapConnections,
  mapHolding,
  mapImportRow,
  mapOrder,
  mapOverview,
  mapPortfolio,
  mapQuote,
  mapRiskLimits,
  mapSession,
  mapStepUp,
  mapStockDetail,
  mapStockPage,
  mapSummary,
  mapTransaction,
  mapUser,
  mapWatchlist,
  problemToApiError,
  toApiRiskLimits,
} from './http/mappers';
import {
  type ApiFinancial,
  type ApiMacro,
  type ApiNewsFeed,
  type ApiNewsItem,
  type ApiRecPerformance,
  type ApiRecommendation,
  type ApiResearchProvider,
  mapAnnouncementsImport,
  mapEvaluationSummary,
  mapFinancialSaved,
  mapFinancialsImport,
  mapFinancialsList,
  mapMacro,
  mapMacroList,
  mapNewsFeed,
  mapNewsItem,
  mapPerformanceReport,
  mapRecommendationDetail,
  mapRecommendationPage,
  mapResearchProvider,
  toApiAnnouncement,
  toApiFinancial,
  toPerformanceQuery,
  toRecommendationQuery,
} from './http/mappers-research';
import {
  mapAdvisorSettings,
  mapDailyReport,
  mapHoldingsReport,
  mapRunSummary,
  mapScannerReport,
  mapStockReport,
} from './http/mappers-advisor';
import type {
  AnnouncementsImportResult,
  DataMode,
  EvaluationSummary,
  FinancialsImportResult,
  ImportBatch,
  ImportRow,
  MarketProvider,
  QuoteTick,
} from './types';

export const CSRF_COOKIE = 'ktrade_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const STEP_UP_HEADER = 'X-Step-Up-Token';
/** The API has no realtime gateway yet, so quote "streaming" polls at the server's refresh cadence. */
export const QUOTE_POLL_MS = 15_000;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Query = Record<string, string | number | undefined>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  stepUpToken?: string;
  idempotencyKey?: string;
}

export interface HttpApiClientOptions {
  /** BFF mount point. Default `/bff`. */
  basePath?: string;
  fetch?: typeof fetch;
  /** Reads `document.cookie` by default (only the non-httpOnly CSRF cookie is visible there). */
  readCookie?: (name: string) => string | undefined;
  now?: () => number;
  /** Called when the BFF reports the session is gone (refresh failed). */
  onUnauthenticated?: () => void;
  pollMs?: number;
}

function documentCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const seg = (v: string) => encodeURIComponent(v);
const rejectNA = <T>(): Promise<T> => Promise.reject(notAvailable());

export class HttpApiClient implements ApiClient {
  readonly kind = 'http' as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readCookie: (name: string) => string | undefined;
  private readonly now: () => number;
  private readonly onUnauthenticated?: () => void;
  private readonly pollMs: number;

  constructor(opts: HttpApiClientOptions = {}) {
    this.base = (opts.basePath ?? '/bff').replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? ((...args) => globalThis.fetch(...args));
    this.readCookie = opts.readCookie ?? documentCookie;
    this.now = opts.now ?? Date.now;
    this.onUnauthenticated = opts.onUnauthenticated;
    this.pollMs = opts.pollMs ?? QUOTE_POLL_MS;
  }

  // ─── transport ───────────────────────────────────────────────────────────

  /** The CSRF cookie is issued by `GET /bff/auth/me`; fetch it once if this tab has none yet. */
  private async csrfToken(): Promise<string> {
    let token = this.readCookie(CSRF_COOKIE);
    if (!token) {
      await this.fetchImpl(`${this.base}/auth/me`, { credentials: 'same-origin', cache: 'no-store' }).catch(
        () => undefined,
      );
      token = this.readCookie(CSRF_COOKIE);
    }
    if (!token)
      throw new ApiError('CSRF_FAILED', 403, 'Security check failed', 'Reload the page and try again.');
    return token;
  }

  async request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined && v !== '') qs.set(k, String(v));
    const search = qs.toString();
    const url = `${this.base}/${path}${search ? `?${search}` : ''}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers[CSRF_HEADER] = await this.csrfToken();
    if (opts.stepUpToken) headers[STEP_UP_HEADER] = opts.stepUpToken;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError('NETWORK_ERROR', 0, 'Network error', 'Could not reach the server.');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (res.ok) throw new ApiError('BAD_RESPONSE', res.status, 'Unexpected response', 'Invalid JSON');
      }
    }
    if (!res.ok) {
      const err = problemToApiError(res.status, body);
      if (res.status === 401 && !path.startsWith('auth/')) this.onUnauthenticated?.();
      throw err;
    }
    return body as T;
  }

  private get<T>(path: string, query?: Query) {
    return this.request<T>('GET', path, { query });
  }

  // ─── groups ──────────────────────────────────────────────────────────────

  auth: ApiClient['auth'] = {
    login: async (req) => {
      try {
        const r = await this.request<{ user: ApiUser }>('POST', 'auth/login', {
          body: {
            email: req.email,
            password: req.password,
            ...(req.totpCode ? { totpCode: req.totpCode } : {}),
          },
        });
        return { user: mapUser(r.user), totpRequired: false as const };
      } catch (e) {
        if (e instanceof ApiError && e.code === 'TOTP_REQUIRED') return { totpRequired: true as const };
        throw e;
      }
    },
    register: async (req) => {
      const r = await this.request<{ user: ApiUser }>('POST', 'auth/register', {
        body: { email: req.email, password: req.password, displayName: req.displayName },
      });
      return mapUser(r.user);
    },
    logout: async () => {
      await this.request<void>('POST', 'auth/logout');
    },
    me: async () => {
      try {
        return mapUser(await this.get<ApiUser>('auth/me'));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    // The API accepts a TOTP code, or the password when TOTP is not enabled. The token stays in memory.
    stepUp: async (proof) => {
      const body = 'totpCode' in proof ? { totpCode: proof.totpCode } : { password: proof.password };
      const r = await this.request<{ stepUpToken: string; expiresIn: number }>('POST', 'auth/step-up', {
        body,
      });
      return mapStepUp(r, this.now());
    },
  };

  system: ApiClient['system'] = {
    dataMode: async (): Promise<DataMode> => {
      const providers = await this.market.providers();
      const active = providers.find((p) => p.active);
      if (!active) throw new ApiError('BAD_RESPONSE', 502, 'No active market-data provider');
      return {
        priceSource: active.source,
        providerKey: active.key,
        delayMinutes: active.capabilities.delayMinutes,
        liveExecution: 'MANUAL',
        demo: false,
      };
    },
    killSwitch: () => this.get<{ liveTradingEnabled: boolean }>('admin/kill-switch'),
    setKillSwitch: ({ liveTradingEnabled, reason, stepUpToken }) =>
      this.request('PUT', 'admin/kill-switch', { body: { liveTradingEnabled, reason }, stepUpToken }),
  };

  dashboard: ApiClient['dashboard'] = {
    summary: async (pf) => mapSummary(await this.get<ApiSummary>('dashboard/summary', { portfolioId: pf })),
    charts: () => rejectNA(),
    performance: async (pf, range) =>
      mapPerformance(await this.get<ApiPerformance>(`portfolios/${seg(pf)}/performance`, { range })),
    backfillSnapshots: async (pf) =>
      mapBackfill(
        await this.request<ApiBackfillResult>('POST', `portfolios/${seg(pf)}/snapshots/backfill`, {
          body: {},
        }),
      ),
  };

  portfolios: ApiClient['portfolios'] = {
    list: async () => (await this.get<ApiPortfolio[]>('portfolios')).map(mapPortfolio),
    holdings: async (pf) => {
      const [portfolios, rows] = await Promise.all([
        this.get<ApiPortfolio[]>('portfolios'),
        this.get<ApiHolding[]>(`portfolios/${seg(pf)}/holdings`),
      ]);
      const source = ledgerSourceOf(portfolios.find((p) => p.id === pf)?.kind);
      return rows.map((h) => mapHolding(h, source));
    },
    holding: () => rejectNA(),
    createPaper: async ({ name, initialCash }) => {
      const r = await this.request<{ id: string }>('POST', 'portfolios', { body: { name, initialCash } });
      // The create response is minimal; read the full row back rather than guessing its defaults.
      const created = (await this.get<ApiPortfolio[]>('portfolios')).find((p) => p.id === r.id);
      if (!created) throw new ApiError('BAD_RESPONSE', 502, 'Created portfolio not found');
      return mapPortfolio(created);
    },
    transactions: async (pf, q = {}) => {
      const page = await this.get<{ data: ApiTransaction[]; nextCursor: string | null }>(
        `portfolios/${seg(pf)}/transactions`,
        { limit: q.limit ?? 50, cursor: q.cursor },
      );
      return { data: page.data.map((t) => mapTransaction(t, pf)), nextCursor: page.nextCursor };
    },
    cashMovements: () => rejectNA(),
    resetPaper: () => rejectNA(),
  };

  orders: ApiClient['orders'] = {
    preview: async (req) =>
      mapOrder(
        await this.request<ApiOrder>('POST', 'orders/preview', {
          idempotencyKey: req.idempotencyKey ?? crypto.randomUUID(),
          body: {
            portfolioId: req.portfolioId,
            symbol: req.symbol,
            side: req.side,
            type: req.type,
            quantity: req.quantity,
            ...(req.limitPrice ? { limitPrice: req.limitPrice } : {}),
            ...(req.stopPrice ? { stopPrice: req.stopPrice } : {}),
            origin: req.origin,
          },
        }),
      ),
    approve: async (id, { previewHash, stepUpToken }) =>
      mapOrder(
        await this.request<ApiOrder>('POST', `orders/${seg(id)}/approve`, {
          body: { previewHash },
          stepUpToken,
        }),
      ),
    markPlaced: async (id, { brokerOrderRef }) =>
      mapOrder(
        await this.request<ApiOrder>('POST', `orders/${seg(id)}/mark-placed`, {
          body: brokerOrderRef ? { brokerOrderRef } : {},
        }),
      ),
    recordFill: async (id, fill) =>
      mapOrder(await this.request<ApiOrder>('POST', `orders/${seg(id)}/fills`, { body: fill })),
    cancel: async (id) => mapOrder(await this.request<ApiOrder>('POST', `orders/${seg(id)}/cancel`)),
    list: async (f = {}) => {
      const page = await this.get<{ data: ApiOrder[]; nextCursor: string | null }>('orders', {
        status: f.status,
        portfolioId: f.portfolioId,
        cursor: f.cursor,
        limit: f.limit ?? 50,
      });
      return { data: page.data.map(mapOrder), nextCursor: page.nextCursor };
    },
    get: async (id) => mapOrder(await this.get<ApiOrder>(`orders/${seg(id)}`)),
    feeEstimate: () => rejectNA(),
    riskLimits: async (pf) => {
      const r = await this.get<ApiRiskLimits | null>(`portfolios/${seg(pf)}/risk-limits`);
      return r ? mapRiskLimits(r, pf) : null;
    },
    updateRiskLimits: async (limits, stepUpToken) =>
      mapRiskLimits(
        await this.request<ApiRiskLimits>('PUT', `portfolios/${seg(limits.portfolioId)}/risk-limits`, {
          body: toApiRiskLimits(limits),
          stepUpToken,
        }),
        limits.portfolioId,
      ),
  };

  market: ApiClient['market'] = {
    overview: async () => mapOverview(await this.get<ApiOverview>('market/overview')),
    stocks: async (q = {}) =>
      mapStockPage(
        await this.get<ApiStockPage>('market/stocks', {
          search: q.search?.trim() || undefined,
          sector: q.sector || undefined,
          limit: q.limit,
          offset: q.offset,
        }),
      ),
    stock: async (symbol) => mapStockDetail(await this.get<ApiStockDetail>(`market/stocks/${seg(symbol)}`)),
    sectors: () => this.get('market/sectors'),
    quotes: async (symbols) =>
      (
        await this.get<ApiQuote[]>('market/quotes', {
          symbols: symbols?.length ? symbols.join(',') : undefined,
        })
      ).map(mapQuote),
    candles: async (symbol, q = {}) =>
      mapCandles(await this.get<ApiCandles>(`market/candles/${seg(symbol)}`, { interval: 'D1', ...q })),
    movers: async (type, limit = 10) =>
      (await this.get<ApiQuote[]>('market/movers', { type, limit })).map(mapQuote),
    providers: () => this.get<MarketProvider[]>('market/providers'),
    watchlists: async () => (await this.get<ApiWatchlist[]>('watchlists')).map(mapWatchlist),
    createWatchlist: async (name, symbols = []) =>
      mapWatchlist(await this.request<ApiWatchlist>('POST', 'watchlists', { body: { name, symbols } })),
    renameWatchlist: async (id, name) =>
      mapWatchlist(await this.request<ApiWatchlist>('PATCH', `watchlists/${seg(id)}`, { body: { name } })),
    deleteWatchlist: async (id) => {
      await this.request<void>('DELETE', `watchlists/${seg(id)}`);
    },
    addToWatchlist: async (id, symbol) =>
      mapWatchlist(
        await this.request<ApiWatchlist>('POST', `watchlists/${seg(id)}/stocks`, { body: { symbol } }),
      ),
    removeFromWatchlist: async (id, symbol) =>
      mapWatchlist(await this.request<ApiWatchlist>('DELETE', `watchlists/${seg(id)}/stocks/${seg(symbol)}`)),
    subscribeQuotes: (symbols, onTick) => {
      const wanted = [...new Set(symbols)].slice(0, 200);
      if (!wanted.length) return () => undefined;
      let stopped = false;
      const poll = async () => {
        try {
          const quotes = await this.market.quotes(wanted);
          if (stopped) return;
          for (const q of quotes) {
            const tick: QuoteTick = {
              symbol: q.symbol,
              last: q.last,
              change: q.change,
              changePct: q.changePct,
              volume: q.volume,
              asOf: q.asOf,
              source: q.source,
              delayMinutes: q.delayMinutes,
              high: q.high,
              low: q.low,
              stale: q.stale,
            };
            onTick(tick);
          }
        } catch {
          // A failed poll keeps the last known (timestamped) quote on screen; the next poll retries.
        }
      };
      const timer = setInterval(() => void poll(), this.pollMs);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };

  broker: ApiClient['broker'] = {
    connections: async () => mapConnections(await this.get<ApiBrokerAccount[]>('broker/accounts')),
    registerAccount: async ({ displayName, clientCodeLast4, portfolioName }) => {
      await this.request<ApiBrokerAccount>('POST', 'broker/accounts', {
        body: {
          displayName,
          ...(clientCodeLast4 ? { clientCodeLast4 } : {}),
          ...(portfolioName ? { portfolioName } : {}),
        },
      });
    },
    imports: () => this.get<ImportBatch[]>('imports'),
    importRows: async (id) => (await this.get<ImportRow[]>(`imports/${seg(id)}/rows`)).map(mapImportRow),
    upload: ({ portfolioId, fileName, content, kind }) =>
      this.request<ImportBatch>('POST', 'imports', {
        body: { portfolioId, fileName, content, ...(kind ? { kind } : {}) },
      }),
    updateImportRow: (importId, rowId, action) =>
      this.request<ImportBatch>('PATCH', `imports/${seg(importId)}/rows/${seg(rowId)}`, { body: { action } }),
    commitImport: (id) => this.request<ImportBatch>('POST', `imports/${seg(id)}/commit`),
    rejectImport: (id) => this.request<ImportBatch>('POST', `imports/${seg(id)}/reject`),
    mailbox: () => rejectNA(),
    discrepancies: () => rejectNA(),
  };

  security: ApiClient['security'] = {
    overview: () => rejectNA(),
    sessions: async () => (await this.get<ApiSession[]>('auth/sessions')).map(mapSession),
    revokeSession: async (id) => {
      await this.request<void>('DELETE', `auth/sessions/${seg(id)}`);
    },
    revokeAllSessions: async () => {
      await this.request<{ revoked: number }>('DELETE', 'auth/sessions');
    },
    destroyAll: () => rejectNA(),
  };

  strategies: ApiClient['strategies'] = {
    templates: async () => (await this.get<ApiTemplate[]>('strategies/templates')).map(mapTemplate),
    list: async () => (await this.get<ApiStrategy[]>('strategies')).map(mapStrategy),
    create: async (input) =>
      mapStrategy(await this.request<ApiStrategy>('POST', 'strategies', { body: toApiStrategyInput(input) })),
    update: async (id, patch) =>
      mapStrategy(
        await this.request<ApiStrategy>('PATCH', `strategies/${seg(id)}`, {
          body: toApiStrategyUpdate(patch),
        }),
      ),
    remove: async (id) => {
      await this.request<void>('DELETE', `strategies/${seg(id)}`);
    },
    setActive: async (id, active, stepUpToken) =>
      mapStrategy(
        await this.request<ApiStrategy>(
          'POST',
          `strategies/${seg(id)}/${active ? 'activate' : 'deactivate'}`,
          {
            stepUpToken: active ? stepUpToken : undefined,
          },
        ),
      ),
    validate: async ({ symbol, bars, ...def }) =>
      mapValidation(
        await this.request<ApiValidation>('POST', 'strategies/validate', {
          body: { ...toApiDefinition(def), ...(symbol ? { symbol } : {}), ...(bars ? { bars } : {}) },
        }),
      ),
    evaluate: async (id) =>
      mapEvaluation(await this.request<ApiEvaluation>('POST', `strategies/${seg(id)}/evaluate`)),
    signals: async (q = {}) =>
      (
        await this.get<ApiSignal[]>(q.strategyId ? `strategies/${seg(q.strategyId)}/signals` : 'signals', {
          status: q.status,
          limit: 100,
        })
      ).map(mapSignal),
  };

  backtests: ApiClient['backtests'] = {
    run: async (req) =>
      mapBacktest(
        await this.request<ApiBacktest>('POST', 'backtests', {
          body: {
            ...(req.strategyId ? { strategyId: req.strategyId } : {}),
            ...(req.definition ? { definition: toApiDefinition(req.definition) } : {}),
            ...(req.symbol ? { symbol: req.symbol } : {}),
            from: req.from,
            to: req.to,
            initialCapital: req.initialCapital,
            slippageBps: req.slippageBps,
          },
        }),
      ),
    list: async () =>
      (await this.get<{ data: ApiBacktest[] }>('backtests', { limit: 50 })).data.map(mapBacktest),
    get: async (id) => mapBacktest(await this.get<ApiBacktest>(`backtests/${seg(id)}`)),
    trades: async (id) => mapBacktestTrades(await this.get<ApiBacktestTrades>(`backtests/${seg(id)}/trades`)),
    compare: async (req) =>
      mapComparison(
        await this.request<ApiComparison>('POST', 'backtests/compare', {
          body: {
            strategyIds: req.strategyIds,
            definitions: req.definitions.map(({ label, ...d }) => ({
              ...toApiDefinition(d),
              ...(label ? { label } : {}),
            })),
            ...(req.symbol ? { symbol: req.symbol } : {}),
            from: req.from,
            to: req.to,
            initialCapital: req.initialCapital,
            slippageBps: req.slippageBps,
          },
        }),
      ),
  };

  notifications: ApiClient['notifications'] = {
    list: async (q = {}) =>
      mapNotificationPage(
        await this.get<ApiNotificationPage>('notifications', {
          unread: q.unread ? 'true' : undefined,
          limit: q.limit,
          cursor: q.cursor,
        }),
      ),
    markRead: async (id) =>
      mapNotification(await this.request<ApiNotification>('POST', `notifications/${seg(id)}/read`)),
    markAllRead: () => this.request<{ updated: number }>('POST', 'notifications/read-all'),
  };

  alerts: ApiClient['alerts'] = {
    list: async () => (await this.get<ApiAlert[]>('alerts')).map(mapAlert),
    create: async (input) =>
      mapAlert(await this.request<ApiAlert>('POST', 'alerts', { body: toApiAlertInput(input) })),
    update: async (id, patch) =>
      mapAlert(await this.request<ApiAlert>('PATCH', `alerts/${seg(id)}`, { body: toApiAlertUpdate(patch) })),
    remove: async (id) => {
      await this.request<void>('DELETE', `alerts/${seg(id)}`);
    },
    evaluate: async () =>
      mapAlertEvaluation(await this.request<ApiAlertEvaluation>('POST', 'alerts/evaluate')),
  };

  dividends: ApiClient['dividends'] = {
    declarations: async (q = {}) =>
      (await this.get<ApiDividend[]>('dividends', { symbol: q.symbol, limit: 500 })).map(
        mapDividendDeclaration,
      ),
    createDeclaration: async (input) =>
      mapDividendDeclaration(
        await this.request<ApiDividend>('POST', 'dividends', { body: toApiDividendInput(input) }),
      ),
    updateDeclaration: async (id, patch) =>
      mapDividendDeclarationUpdated(
        await this.request<ApiDividend & { estimatedEntitlementsCleared: number }>(
          'PATCH',
          `dividends/${seg(id)}`,
          { body: toApiDividendUpdate(patch) },
        ),
      ),
    deleteDeclaration: async (id) =>
      mapDividendDeclarationDeleted(
        await this.request<{ id: string; deleted: boolean; estimatedEntitlementsCleared: number }>(
          'DELETE',
          `dividends/${seg(id)}`,
        ),
      ),
    entitlements: async (pf) =>
      mapDividendEntitlementList(
        await this.get<ApiDividendEntitlementList>(`portfolios/${seg(pf)}/dividend-entitlements`),
      ),
    compute: async (pf) =>
      mapDividendComputeResult(
        await this.request<ApiDividendComputeResult>(
          'POST',
          `portfolios/${seg(pf)}/dividend-entitlements/compute`,
        ),
      ),
    markPaid: async (id, input) =>
      mapMarkPaidResult(
        await this.request<ApiMarkPaidResult>('POST', `dividend-entitlements/${seg(id)}/mark-paid`, {
          body: toApiMarkPaid(input),
        }),
      ),
    reconcile: async (id, input = {}) =>
      mapDividendEntitlement(
        await this.request<ApiDividendEntitlement>('POST', `dividend-entitlements/${seg(id)}/reconcile`, {
          body: input.statementRef?.trim() ? { statementRef: input.statementRef.trim() } : {},
        }),
      ),
  };

  research: ApiClient['research'] = {
    newsFeed: async (q = {}) =>
      mapNewsFeed(
        await this.get<ApiNewsFeed>('research/news-feed', {
          windowHours: q.windowHours,
          symbol: q.symbol?.trim() ? q.symbol.trim().toUpperCase() : undefined,
          limit: 200,
        }),
      ),
    addAnnouncement: async (input) =>
      mapNewsItem(
        await this.request<ApiNewsItem>('POST', 'research/announcements', {
          body: toApiAnnouncement(input),
        }),
      ),
    importAnnouncements: async (csv) =>
      mapAnnouncementsImport(
        await this.request<AnnouncementsImportResult>('POST', 'research/announcements/import', {
          body: { csv },
        }),
      ),
    financials: async (symbol) =>
      mapFinancialsList(
        await this.get<{ symbol: string; data: ApiFinancial[]; note?: string }>('research/financials', {
          symbol: symbol.trim().toUpperCase(),
          limit: 200,
        }),
      ),
    saveFinancial: async (input) =>
      mapFinancialSaved(
        await this.request<ApiFinancial & { created: boolean }>('POST', 'research/financials', {
          body: toApiFinancial(input),
        }),
      ),
    importFinancials: async (csv) =>
      mapFinancialsImport(
        await this.request<FinancialsImportResult>('POST', 'research/financials/import', { body: { csv } }),
      ),
    macro: async (q = {}) =>
      mapMacroList(
        await this.get<{ data: ApiMacro[]; note?: string }>('research/macro', {
          series: q.series,
          limit: 200,
        }),
      ),
    addMacro: async (input) =>
      mapMacro(await this.request<ApiMacro>('POST', 'research/macro', { body: input })),
    providers: async () =>
      (await this.get<{ data: ApiResearchProvider[] }>('research/providers')).data.map(mapResearchProvider),
  };

  recommendations: ApiClient['recommendations'] = {
    list: async (q = {}) =>
      mapRecommendationPage(
        await this.get<{ total: number; data: ApiRecommendation[] }>(
          'recommendations',
          toRecommendationQuery({ limit: 25, ...q }),
        ),
      ),
    get: async (id) =>
      mapRecommendationDetail(await this.get<ApiRecommendation>(`recommendations/${seg(id)}`)),
    performance: async (q = {}) =>
      mapPerformanceReport(
        await this.get<ApiRecPerformance>('recommendations/performance', toPerformanceQuery(q)),
      ),
    evaluateOutcomes: async () =>
      mapEvaluationSummary(
        await this.request<EvaluationSummary>('POST', 'recommendations/evaluate-outcomes'),
      ),
  };

  advisor: ApiClient['advisor'] = {
    dailyReport: async (q) => mapDailyReport(await this.get<unknown>('advisor/daily-report', { ...q })),
    holdings: async (q) => mapHoldingsReport(await this.get<unknown>('advisor/holdings', { ...q })),
    scanner: async (q) => mapScannerReport(await this.get<unknown>('advisor/scanner', { ...q })),
    stock: async (symbol, portfolioId) =>
      mapStockReport(
        await this.get<unknown>(`advisor/stocks/${seg(symbol.trim().toUpperCase())}`, { portfolioId }),
      ),
    run: async (input) => mapRunSummary(await this.request<unknown>('POST', 'advisor/run', { body: input })),
    settings: async () => mapAdvisorSettings(await this.get<unknown>('advisor/settings')),
    updateSettings: async (riskPerTradePct) =>
      mapAdvisorSettings(
        await this.request<unknown>('PUT', 'advisor/settings', { body: { riskPerTradePct } }),
      ),
  };

  // ─── no backend yet: NOT_AVAILABLE (never demo data) ────────────────────

  analytics: ApiClient['analytics'] = {
    performance: () => rejectNA(),
    realizedUnrealized: () => rejectNA(),
    feesTaxes: () => rejectNA(),
  };

  reports: ApiClient['reports'] = { create: () => rejectNA(), list: () => rejectNA() };

  assistant: ApiClient['assistant'] = { history: () => rejectNA(), send: () => rejectNA() };

  settings: ApiClient['settings'] = {
    feeSchedules: () => rejectNA(),
    taxRates: () => rejectNA(),
    channels: () => rejectNA(),
    updateChannel: () => rejectNA(),
    testChannel: () => rejectNA(),
    user: () => rejectNA(),
    updateUser: () => rejectNA(),
  };
}
