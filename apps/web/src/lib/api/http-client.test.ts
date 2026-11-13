import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors';
import { HttpApiClient } from './http-client';
import {
  mapCandles,
  mapConnections,
  mapHolding,
  mapOrder,
  mapQuote,
  mapRiskLimits,
  mapSummary,
  mapWatchlist,
  problemToApiError,
  toApiRiskLimits,
  type ApiOrder,
  type ApiSummary,
} from './http/mappers';

const apiQuote = {
  symbol: 'OGDC',
  name: 'Oil & Gas Development',
  sector: 'Oil & Gas Exploration',
  last: '271.50',
  prevClose: '268.00',
  change: '3.50',
  changePct: '1.31',
  volume: '1200000',
  asOf: '2026-11-13T07:00:00.000Z',
  delayMinutes: 0,
  source: 'SIMULATED' as const,
  providerKey: 'simulated',
  stale: false,
};

describe('mappers', () => {
  it('mapQuote keeps provenance and turns omitted decimals into null (never zero)', () => {
    const q = mapQuote(apiQuote);
    expect(q).toMatchObject({ symbol: 'OGDC', last: '271.50', source: 'SIMULATED', stale: false });
    expect(q.open).toBeNull();
    expect(q.high).toBeNull();
    expect(q.low).toBeNull();
    expect(q.prevClose).toBe('268.00');
    expect(mapQuote({ ...apiQuote, stale: true }).stale).toBe(true);
  });

  it('mapCandles keeps per-bar source', () => {
    const c = mapCandles({
      symbol: 'OGDC',
      interval: 'D1',
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-11-13T00:00:00.000Z',
      source: 'SIMULATED',
      bars: [
        {
          ts: '2026-11-12T00:00:00.000Z',
          open: '1',
          high: '2',
          low: '1',
          close: '2',
          volume: '10',
          source: 'USER_REPORTED',
        },
        {
          ts: '2026-11-13T00:00:00.000Z',
          open: '2',
          high: '3',
          low: '2',
          close: '3',
          volume: '10',
          source: 'SIMULATED',
        },
      ],
    });
    expect(c.candles.map((x) => x.source)).toEqual(['USER_REPORTED', 'SIMULATED']);
    expect(c.source).toBe('SIMULATED');
  });

  it('mapHolding converts weightPct to a fraction exactly and keeps unpriced fields null', () => {
    const base = {
      symbol: 'HUBC',
      companyName: 'Hub Power',
      sector: 'Power',
      quantity: '100',
      avgCost: '150.000000',
      totalCost: '15000.00',
      realizedPnl: '0.00',
      lastConfirmed: null,
    };
    const priced = mapHolding(
      {
        ...base,
        lastPrice: { value: '160', source: 'SIMULATED', asOf: '2026-11-13T07:00:00Z' },
        marketValue: { value: '16000.00', source: 'SIMULATED' },
        unrealizedPnl: { value: '1000.00', pct: '6.67', source: 'ESTIMATED' },
        weightPct: '12.5',
      },
      'USER_REPORTED',
    );
    expect(priced.weight).toBe('0.125');
    expect(priced.name).toBe('Hub Power');
    expect(priced.source).toBe('USER_REPORTED');
    const unpriced = mapHolding(
      { ...base, lastPrice: null, marketValue: null, unrealizedPnl: null, weightPct: null },
      'SIMULATED',
    );
    expect(unpriced).toMatchObject({ lastPrice: null, marketValue: null, unrealizedPnl: null, weight: null });
  });

  it('mapSummary leaves figures the API cannot compute as null', () => {
    const s: ApiSummary = {
      portfolio: { id: 'p1', name: 'Live', kind: 'LIVE' },
      accountValue: { value: '100.00', source: 'USER_REPORTED' },
      portfolioValue: { value: '60.00', source: 'SIMULATED' },
      investedAmount: { value: '50.00', source: 'USER_REPORTED' },
      cash: { ledger: { value: '40.00', source: 'USER_REPORTED' }, broker: null },
      realizedPnl: { value: '0.00', source: 'USER_REPORTED' },
      unrealizedPnl: { value: '10.00', source: 'ESTIMATED' },
      totalReturnPct: { value: null, source: 'USER_REPORTED', method: 'SIMPLE' },
      todayPnl: { value: null, note: 'Phase 10' },
      monthPnl: { value: null, note: 'Phase 10' },
      dividendsReceived: { value: '0.00', source: 'USER_REPORTED' },
      feesAndTaxes: { fees: '1.00', taxes: '0.50', source: 'ESTIMATED' },
      activeHoldings: 1,
      pendingOrders: 0,
      unpricedHoldings: 0,
    };
    const m = mapSummary(s);
    expect(m.todayPnl).toBeNull();
    expect(m.totalReturnPct).toBeNull();
    expect(m.marketValue).toEqual({ value: '60.00', source: 'SIMULATED' });
    expect(m.feesPaid).toEqual({ value: '1.00', source: 'ESTIMATED' });
  });

  it('mapRiskLimits / toApiRiskLimits round-trip the renamed fields', () => {
    const api = {
      maxOrderValue: '100000',
      maxOrderQty: '5000',
      maxDailyTradedValue: '300000',
      maxDailyOrders: 10,
      maxPositionPct: '25',
      priceBandPct: '5',
      maxDailyLossPct: '3',
      allowMarketOrders: false,
      liveAutoExecutionEnabled: false,
    };
    const web = mapRiskLimits(api, 'p1');
    expect(web).toMatchObject({ portfolioId: 'p1', maxDailyValue: '300000', maxDailyCount: 10 });
    const { liveAutoExecutionEnabled: _ignored, ...settable } = api;
    expect(_ignored).toBe(false);
    expect(toApiRiskLimits(web)).toEqual(settable);
  });

  it('mapOrder derives the execution path and maps events/fills', () => {
    const o: ApiOrder = {
      id: 'o1',
      portfolioId: 'p1',
      symbol: 'OGDC',
      companyName: 'OGDC',
      mode: 'PAPER',
      origin: 'MANUAL',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '10',
      limitPrice: '270',
      stopPrice: null,
      referencePrice: { value: '271.50', source: 'SIMULATED' },
      status: 'FILLED',
      filledQuantity: '10',
      avgFillPrice: '270',
      estimate: { notional: '2700.00', fees: '8.10', total: '2708.10', source: 'ESTIMATED' },
      previewHash: null,
      previewExpiresAt: null,
      rejectionReason: null,
      brokerOrderRef: null,
      createdAt: '2026-11-13T05:00:00Z',
      events: [
        { from: 'PREVIEWED', to: 'APPROVED', actorType: 'USER', reason: null, at: '2026-11-13T05:01:00Z' },
      ],
      executions: [{ quantity: '10', price: '270', executedAt: '2026-11-13T05:01:00Z', source: 'SIMULATED' }],
    };
    const m = mapOrder(o);
    expect(m.executionPath).toBe('PAPER_AUTO');
    expect(m.estimate).toMatchObject({ notional: '2700.00', totalFees: '8.10', total: '2708.10', fees: [] });
    expect(m.events[0]).toMatchObject({ status: 'APPROVED', actor: 'USER', note: '' });
    expect(m.executions[0]).toMatchObject({ orderId: 'o1', side: 'BUY', price: '270' });
    expect(mapOrder({ ...o, mode: 'LIVE', estimate: { ...o.estimate, total: null } }).estimate).toBeNull();
  });

  it('mapWatchlist maps items with quotes', () => {
    const w = mapWatchlist({
      id: 'w1',
      name: 'Banks',
      createdAt: '2026-11-01T00:00:00Z',
      items: [
        { symbol: 'OGDC', addedAt: '2026-11-01T00:00:00Z', quote: apiQuote },
        { symbol: 'XYZ', addedAt: '2026-11-01T00:00:00Z', quote: null },
      ],
    });
    expect(w.items[0].quote?.last).toBe('271.50');
    expect(w.items[1].quote).toBeNull();
  });

  it('mapConnections flattens broker accounts', () => {
    const off = {
      implemented: false,
      verified: false,
      authorized: false,
      authorizationRef: null,
      enabled: false,
    };
    const c = mapConnections([
      {
        id: 'a1',
        brokerCode: 'KTRADE',
        displayName: 'KTrade',
        clientCodeMasked: null,
        portfolios: [],
        connections: [
          {
            adapter: 'MANUAL_IMPORT',
            status: 'CONNECTED',
            authorizationRef: null,
            capabilities: { readAccount: off } as never,
          },
        ],
      },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ id: 'a1:MANUAL_IMPORT', adapterKind: 'MANUAL_IMPORT', status: 'CONNECTED' });
    expect(c[0].capabilities.readAccount).toEqual({
      implemented: false,
      verified: false,
      authorized: false,
      enabled: false,
    });
  });

  it('problemToApiError keeps code, status, detail and field errors', () => {
    const e = problemToApiError(422, {
      title: 'Validation failed',
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'email', message: 'Invalid email' }],
      requestId: 'r1',
    });
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      title: 'Validation failed',
      requestId: 'r1',
    });
    expect(e.errors).toEqual([{ path: 'email', message: 'Invalid email' }]);
    expect(problemToApiError(502, 'not json').code).toBe('BAD_RESPONSE');
    expect(problemToApiError(401, null).code).toBe('UNAUTHENTICATED');
  });
});

function client(responses: Response[], opts: { csrf?: string; onUnauthenticated?: () => void } = {}) {
  const fetchMock = vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 }));
  const c = new HttpApiClient({
    fetch: fetchMock as unknown as typeof fetch,
    readCookie: (n) => (n === 'ktrade_csrf' ? (opts.csrf ?? 'tok') : undefined),
    now: () => Date.parse('2026-11-13T05:00:00Z'),
    onUnauthenticated: opts.onUnauthenticated,
  });
  return { c, fetchMock };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

describe('HttpApiClient', () => {
  it('calls /bff with the CSRF header on mutations and none on GET', async () => {
    const { c, fetchMock } = client([json([]), json({ id: 'w', name: 'A', createdAt: 'x', items: [] })]);
    await c.market.watchlists();
    await c.market.createWatchlist('A');
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe('/bff/watchlists');
    expect((calls[0][1].headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
    expect(calls[1][0]).toBe('/bff/watchlists');
    expect(calls[1][1].method).toBe('POST');
    expect((calls[1][1].headers as Record<string, string>)['x-csrf-token']).toBe('tok');
    expect(calls[1][1].body).toBe(JSON.stringify({ name: 'A', symbols: [] }));
  });

  it('sends the step-up token as X-Step-Up-Token and builds query strings', async () => {
    const { c, fetchMock } = client([json({ liveTradingEnabled: true }), json({ total: 0, data: [] })]);
    await c.system.setKillSwitch({ liveTradingEnabled: true, reason: 'go live', stepUpToken: 'su' });
    await c.market.stocks({ search: ' og ', sector: '', limit: 25, offset: 50 });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect((calls[0][1].headers as Record<string, string>)['X-Step-Up-Token']).toBe('su');
    expect(calls[1][0]).toBe('/bff/market/stocks?search=og&limit=25&offset=50');
  });

  it('maps problem+json into ApiError', async () => {
    const { c } = client([
      json({ title: 'Conflict', status: 409, code: 'ALREADY_EXISTS', detail: 'dup' }, 409),
    ]);
    await expect(c.market.createWatchlist('A')).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      status: 409,
      message: 'dup',
    });
  });

  it('login: TOTP_REQUIRED becomes { totpRequired: true }; success returns only the user', async () => {
    const { c } = client([
      json({ title: 'Unauthorized', status: 401, code: 'TOTP_REQUIRED' }, 401),
      json({ user: { id: 'u', email: 'e', displayName: 'O', role: 'OWNER', totpEnabled: true } }),
    ]);
    expect(await c.auth.login({ email: 'e', password: 'p' })).toEqual({ totpRequired: true });
    const ok = await c.auth.login({ email: 'e', password: 'p', totpCode: '123456' });
    expect(ok).toMatchObject({ totpRequired: false, user: { role: 'OWNER', totpEnabled: true } });
  });

  it('me() returns null on 401; other 401s notify the session handler', async () => {
    const onUnauthenticated = vi.fn();
    const { c } = client(
      [
        json({ status: 401, code: 'UNAUTHENTICATED' }, 401),
        json({ status: 401, code: 'UNAUTHENTICATED' }, 401),
      ],
      { onUnauthenticated },
    );
    expect(await c.auth.me()).toBeNull();
    expect(onUnauthenticated).not.toHaveBeenCalled();
    await expect(c.market.overview()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });

  it('stepUp maps expiresIn to an absolute expiry and keeps the token in memory only', async () => {
    const { c } = client([json({ stepUpToken: 'su.jwt', expiresIn: 300 })]);
    expect(await c.auth.stepUp({ totpCode: '123456' })).toEqual({
      token: 'su.jwt',
      expiresAt: '2026-11-13T05:05:00.000Z',
    });
  });

  it('dataMode reflects the active provider', async () => {
    const { c } = client([
      json([
        {
          key: 'simulated',
          displayName: 'Simulated',
          source: 'SIMULATED',
          enabled: true,
          active: true,
          disabledReason: null,
          capabilities: {
            quotes: true,
            intradayBars: true,
            eodBars: true,
            corporateActions: false,
            streaming: true,
            delayMinutes: 0,
          },
          health: null,
        },
      ]),
    ]);
    expect(await c.system.dataMode()).toEqual({
      priceSource: 'SIMULATED',
      providerKey: 'simulated',
      delayMinutes: 0,
      liveExecution: 'MANUAL',
      demo: false,
    });
  });

  it('groups without a backend reject with NOT_AVAILABLE and never call the network', async () => {
    const { c, fetchMock } = client([]);
    const calls = [
      c.dividends.list('p'),
      c.analytics.feesTaxes('p'),
      c.assistant.history(),
      c.reports.list(),
      c.settings.feeSchedules(),
      c.dashboard.charts('p', '1M'),
      c.broker.mailbox(),
    ];
    for (const p of calls) await expect(p).rejects.toMatchObject({ code: 'NOT_AVAILABLE', status: 501 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the CSRF cookie via /bff/auth/me when the tab has none', async () => {
    let cookie: string | undefined;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/bff/auth/me') {
        cookie = 'fresh';
        return json({ status: 401, code: 'UNAUTHENTICATED' }, 401);
      }
      return json({ user: { id: 'u', email: 'e', displayName: 'O', role: 'OWNER', totpEnabled: false } });
    });
    const c = new HttpApiClient({
      fetch: fetchMock as unknown as typeof fetch,
      readCookie: () => cookie,
    });
    await c.auth.register({ email: 'e', password: 'p'.repeat(12), displayName: 'O' });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe('/bff/auth/me');
    expect((calls[1][1].headers as Record<string, string>)['x-csrf-token']).toBe('fresh');
  });
});
