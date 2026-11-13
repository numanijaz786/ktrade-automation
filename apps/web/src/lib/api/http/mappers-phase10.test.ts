import { describe, expect, it, vi } from 'vitest';
import { HttpApiClient } from '../http-client';
import {
  mapAlert,
  mapAlertEvaluation,
  mapBackfill,
  mapNotification,
  mapNotificationPage,
  mapPerformance,
  mapSummary,
  toApiAlertInput,
  toApiAlertUpdate,
  type ApiAlert,
  type ApiNotification,
  type ApiPerformance,
  type ApiSummary,
} from './mappers';

const apiPerf: ApiPerformance = {
  portfolioId: 'p1',
  range: '3M',
  from: '2026-08-14',
  to: '2026-11-13',
  source: 'SIMULATED',
  methodology: 'Snapshots value the portfolio at each PSX close…',
  series: [
    { date: '2026-11-12', totalValue: '1000000.0000', dailyPnl: '0.0000', twrIndex: '1.0000000000' },
    { date: '2026-11-13', totalValue: '1012000.5000', dailyPnl: '12000.5000', twrIndex: '1.0120005000' },
  ],
  twr: { valuePct: '1.2001', method: 'TWR', baseDate: '2026-08-13', source: 'SIMULATED' },
  maxDrawdown: {
    valuePct: '3.5000',
    peakDate: '2026-09-01',
    troughDate: '2026-09-20',
    recoveryDate: null,
    source: 'SIMULATED',
  },
  monthly: [{ month: '2026-11', pnl: '12000.5000', days: 9, source: 'SIMULATED' }],
  simpleReturn: {
    valuePct: '1.2000',
    method: 'SIMPLE',
    since: 'INCEPTION',
    asOf: '2026-11-13',
    source: 'SIMULATED',
  },
  xirr: { valuePct: null, method: 'XIRR', since: 'INCEPTION', asOf: '2026-11-13', source: 'SIMULATED' },
};

const apiAlert: ApiAlert = {
  id: 'a1',
  type: 'POSITION_STOP_LOSS',
  symbol: 'OGDC',
  portfolio: { id: 'p1', name: 'Live' },
  params: { pct: '8.5' },
  threshold: '8.5',
  channels: ['IN_APP'],
  isActive: false,
  triggerOnce: true,
  cooldownMinutes: 60,
  lastTriggeredAt: '2026-11-13T06:00:00.000Z',
  createdAt: '2026-11-01T06:00:00.000Z',
  updatedAt: '2026-11-13T06:00:00.000Z',
};

const apiNotification: ApiNotification = {
  id: 'n1',
  type: 'PRICE_ABOVE',
  title: 'OGDC: price above',
  body: 'OGDC 271.5 (alert: ≥ 270)',
  data: { type: 'PRICE_ABOVE', symbol: 'OGDC' },
  channel: 'IN_APP',
  status: 'SENT',
  alertId: 'a1',
  createdAt: '2026-11-13T06:00:00.000Z',
  readAt: null,
};

const baseSummary: Omit<ApiSummary, 'todayPnl' | 'monthPnl' | 'twrPct'> = {
  portfolio: { id: 'p1', name: 'Live', kind: 'LIVE' },
  accountValue: { value: '100.0000', source: 'PROVIDER' },
  portfolioValue: { value: '50.0000', source: 'PROVIDER' },
  investedAmount: { value: '40.0000', source: 'USER_REPORTED' },
  cash: { ledger: { value: '50.0000', source: 'USER_REPORTED' }, broker: null },
  realizedPnl: { value: '0.0000', source: 'USER_REPORTED' },
  unrealizedPnl: { value: '10.0000', source: 'ESTIMATED' },
  totalReturnPct: { value: '1.0000', method: 'SIMPLE', source: 'PROVIDER' },
  dividendsReceived: { value: '0.0000', source: 'USER_REPORTED' },
  feesAndTaxes: { fees: '0.0000', taxes: '0.0000', source: 'ESTIMATED' },
  activeHoldings: 1,
  pendingOrders: 0,
  unpricedHoldings: 0,
};

describe('performance mappers', () => {
  it('mapPerformance keeps decimals as strings, provenance per figure and null XIRR as null', () => {
    const p = mapPerformance(apiPerf);
    expect(p.series[1]).toEqual({
      date: '2026-11-13',
      totalValue: '1012000.5000',
      dailyPnl: '12000.5000',
      twrIndex: '1.0120005000',
    });
    expect(p.twr).toEqual({ valuePct: '1.2001', baseDate: '2026-08-13', source: 'SIMULATED' });
    expect(p.maxDrawdown).toMatchObject({ valuePct: '3.5000', recoveryDate: null, source: 'SIMULATED' });
    expect(p.xirr).toEqual({ valuePct: null, asOf: '2026-11-13', source: 'SIMULATED' });
    expect(p.monthly).toEqual([{ month: '2026-11', pnl: '12000.5000', days: 9, source: 'SIMULATED' }]);
    expect(p.note).toBeNull();
    expect(p.methodology).toContain('PSX close');
  });

  it('mapPerformance passes the "no snapshots yet" shape through without inventing figures', () => {
    const p = mapPerformance({
      ...apiPerf,
      from: null,
      to: null,
      methodology: undefined,
      note: 'No snapshots yet — run POST /portfolios/:id/snapshots/backfill',
      series: [],
      twr: { valuePct: null, method: 'TWR', source: 'USER_REPORTED' },
      maxDrawdown: null,
      monthly: [],
      simpleReturn: { valuePct: null, method: 'SIMPLE', since: null, source: 'USER_REPORTED' },
      xirr: { valuePct: null, method: 'XIRR', since: null, source: 'USER_REPORTED' },
    });
    expect(p.series).toEqual([]);
    expect(p.maxDrawdown).toBeNull();
    expect(p.twr).toEqual({ valuePct: null, baseDate: null, source: 'USER_REPORTED' });
    expect(p.simpleReturn.asOf).toBeNull();
    expect(p.note).toMatch(/No snapshots yet/);
  });

  it('mapBackfill defaults unpricedSymbols', () => {
    expect(mapBackfill({ portfolioId: 'p', from: '2026-01-02', to: '2026-11-13', tradingDays: 210 })).toEqual(
      {
        portfolioId: 'p',
        from: '2026-01-02',
        to: '2026-11-13',
        tradingDays: 210,
        unpricedSymbols: [],
      },
    );
  });

  it('mapSummary carries today/month basis, dates, pct and TWR', () => {
    const s = mapSummary({
      ...baseSummary,
      todayPnl: {
        value: '-1250.5000',
        pct: '-0.4100',
        basis: 'LIVE_VS_PREVIOUS_SNAPSHOT',
        tradingDate: '2026-11-13',
        previousCloseDate: '2026-11-12',
        source: 'PROVIDER',
        note: 'Live: current quotes vs the 2026-11-12 close snapshot, net of deposits/withdrawals since',
      },
      monthPnl: {
        value: '3000.0000',
        month: '2026-11',
        basis: 'SNAPSHOTS_PLUS_LIVE_TODAY',
        sessions: 10,
        source: 'PROVIDER',
      },
      twrPct: { value: '4.2000', method: 'TWR', basis: 'SNAPSHOTS', source: 'ESTIMATED' },
    });
    expect(s.todayPnl).toMatchObject({
      value: '-1250.5000',
      basis: 'LIVE_VS_PREVIOUS_SNAPSHOT',
      tradingDate: '2026-11-13',
      previousCloseDate: '2026-11-12',
      source: 'PROVIDER',
    });
    expect(s.todayPnlPct).toEqual({ value: '-0.4100', source: 'PROVIDER' });
    expect(s.monthPnl).toMatchObject({ basis: 'SNAPSHOTS_PLUS_LIVE_TODAY', month: '2026-11', sessions: 10 });
    expect(s.twrPct).toMatchObject({ value: '4.2000', source: 'ESTIMATED' });
    expect(s.snapshotsNote).toBeNull();
  });

  it('mapSummary keeps snapshot-less figures null (never zero) and surfaces the note', () => {
    const note = 'No portfolio snapshots yet — run POST /portfolios/:id/snapshots/backfill';
    const s = mapSummary({
      ...baseSummary,
      todayPnl: { value: null, note },
      monthPnl: { value: null, note },
      twrPct: { value: null, method: 'TWR', note },
    });
    expect(s.todayPnl).toBeNull();
    expect(s.todayPnlPct).toBeNull();
    expect(s.monthPnl).toBeNull();
    expect(s.twrPct).toBeNull();
    expect(s.snapshotsNote).toBe(note);
  });
});

describe('notification mappers', () => {
  it('mapNotification derives read from readAt and links alert notifications to /alerts', () => {
    expect(mapNotification(apiNotification)).toEqual({
      id: 'n1',
      type: 'PRICE_ABOVE',
      title: 'OGDC: price above',
      body: 'OGDC 271.5 (alert: ≥ 270)',
      createdAt: '2026-11-13T06:00:00.000Z',
      readAt: null,
      read: false,
      channel: 'IN_APP',
      status: 'SENT',
      alertId: 'a1',
      link: '/alerts',
    });
    const read = mapNotification({
      ...apiNotification,
      alertId: null,
      type: null,
      readAt: '2026-11-13T07:00:00.000Z',
      status: 'READ',
    });
    expect(read.read).toBe(true);
    expect(read.link).toBeUndefined();
  });

  it('mapNotificationPage keeps the cursor and unread count', () => {
    const p = mapNotificationPage({ data: [apiNotification], nextCursor: 'n1', unreadCount: 7 });
    expect(p.unreadCount).toBe(7);
    expect(p.nextCursor).toBe('n1');
    expect(p.data).toHaveLength(1);
  });
});

describe('alert mappers', () => {
  it('mapAlert renames isActive → active and keeps decimals as strings', () => {
    expect(mapAlert(apiAlert)).toEqual({
      id: 'a1',
      type: 'POSITION_STOP_LOSS',
      symbol: 'OGDC',
      portfolio: { id: 'p1', name: 'Live' },
      params: { pct: '8.5' },
      threshold: '8.5',
      channels: ['IN_APP'],
      active: false,
      triggerOnce: true,
      cooldownMinutes: 60,
      lastTriggeredAt: '2026-11-13T06:00:00.000Z',
      createdAt: '2026-11-01T06:00:00.000Z',
      updatedAt: '2026-11-13T06:00:00.000Z',
    });
  });

  it('toApiAlertInput sends only the target fields the type allows (strict API union)', () => {
    const common = { channels: ['IN_APP' as const], cooldownMinutes: 30, triggerOnce: false, active: true };
    expect(
      toApiAlertInput({
        type: 'PRICE_BELOW',
        symbol: 'LUCK',
        portfolioId: 'p1',
        params: { price: '360' },
        ...common,
      }),
    ).toEqual({
      type: 'PRICE_BELOW',
      symbol: 'LUCK',
      params: { price: '360' },
      channels: ['IN_APP'],
      cooldownMinutes: 30,
      triggerOnce: false,
      isActive: true,
    });
    expect(
      toApiAlertInput({
        type: 'PORTFOLIO_DAILY_LOSS',
        symbol: 'X',
        portfolioId: 'p1',
        params: { pct: '2' },
        ...common,
      }),
    ).toMatchObject({ portfolioId: 'p1', params: { pct: '2' } });
    expect(
      toApiAlertInput({
        type: 'PORTFOLIO_DAILY_LOSS',
        symbol: 'X',
        portfolioId: 'p1',
        params: { pct: '2' },
        ...common,
      }),
    ).not.toHaveProperty('symbol');
    expect(
      toApiAlertInput({
        type: 'POSITION_STOP_LOSS',
        symbol: 'OGDC',
        portfolioId: 'p1',
        params: { pct: '5' },
        ...common,
      }),
    ).toMatchObject({ symbol: 'OGDC', portfolioId: 'p1' });
  });

  it('toApiAlertUpdate maps active → isActive and omits absent fields', () => {
    expect(toApiAlertUpdate({ active: false })).toEqual({ isActive: false });
    expect(toApiAlertUpdate({ params: { price: '1.5' }, cooldownMinutes: 5 })).toEqual({
      params: { price: '1.5' },
      cooldownMinutes: 5,
    });
  });

  it('mapAlertEvaluation copies the summary', () => {
    const e = mapAlertEvaluation({
      evaluatedAt: '2026-11-13T06:00:00.000Z',
      evaluated: 3,
      fired: [{ alertId: 'a1', type: 'PRICE_ABOVE', observed: 'last 271.5', notificationsCreated: 1 }],
      skipped: { COOLDOWN: 1, CONDITION_NOT_MET: 1 },
    });
    expect(e.fired[0].observed).toBe('last 271.5');
    expect(e.skipped).toEqual({ COOLDOWN: 1, CONDITION_NOT_MET: 1 });
  });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(responses: Response[]) {
  const fetchMock = vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 }));
  const c = new HttpApiClient({
    fetch: fetchMock as unknown as typeof fetch,
    readCookie: (n) => (n === 'ktrade_csrf' ? 'tok' : undefined),
  });
  return { c, fetchMock, calls: () => fetchMock.mock.calls as unknown as [string, RequestInit][] };
}

describe('HttpApiClient — performance, notifications, alerts', () => {
  it('wires performance and backfill', async () => {
    const { c, calls } = client([
      json(apiPerf),
      json({
        portfolioId: 'p1',
        from: '2026-01-02',
        to: '2026-11-13',
        tradingDays: 3,
        unpricedSymbols: ['X'],
      }),
    ]);
    expect((await c.dashboard.performance('p1', '1Y')).twr.valuePct).toBe('1.2001');
    expect((await c.dashboard.backfillSnapshots('p1')).unpricedSymbols).toEqual(['X']);
    expect(calls()[0][0]).toBe('/bff/portfolios/p1/performance?range=1Y');
    expect(calls()[1][0]).toBe('/bff/portfolios/p1/snapshots/backfill');
    expect(calls()[1][1]).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('wires the notification inbox', async () => {
    const { c, calls } = client([
      json({ data: [apiNotification], nextCursor: null, unreadCount: 1 }),
      json({ ...apiNotification, readAt: '2026-11-13T07:00:00.000Z', status: 'READ' }),
      json({ updated: 4 }),
    ]);
    const page = await c.notifications.list({ unread: true, limit: 5 });
    expect(page.unreadCount).toBe(1);
    expect((await c.notifications.markRead('n1')).read).toBe(true);
    expect(await c.notifications.markAllRead()).toEqual({ updated: 4 });
    expect(calls().map(([u, i]) => `${i.method} ${u}`)).toEqual([
      'GET /bff/notifications?unread=true&limit=5',
      'POST /bff/notifications/n1/read',
      'POST /bff/notifications/read-all',
    ]);
  });

  it('wires alert CRUD and evaluate', async () => {
    const { c, calls } = client([
      json([apiAlert]),
      json(apiAlert),
      json({ ...apiAlert, isActive: true }),
      new Response(null, { status: 204 }),
      json({ evaluatedAt: 'x', evaluated: 0, fired: [], skipped: {} }),
    ]);
    expect((await c.alerts.list())[0].active).toBe(false);
    await c.alerts.create({
      type: 'PRICE_ABOVE',
      symbol: 'OGDC',
      params: { price: '300' },
      channels: ['IN_APP'],
      cooldownMinutes: 60,
      triggerOnce: false,
      active: true,
    });
    expect((await c.alerts.update('a1', { active: true })).active).toBe(true);
    await c.alerts.remove('a1');
    expect((await c.alerts.evaluate()).evaluated).toBe(0);
    const made = calls();
    expect(made.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      'GET /bff/alerts',
      'POST /bff/alerts',
      'PATCH /bff/alerts/a1',
      'DELETE /bff/alerts/a1',
      'POST /bff/alerts/evaluate',
    ]);
    expect(JSON.parse(made[1][1].body as string)).toEqual({
      type: 'PRICE_ABOVE',
      symbol: 'OGDC',
      params: { price: '300' },
      channels: ['IN_APP'],
      cooldownMinutes: 60,
      triggerOnce: false,
      isActive: true,
    });
    expect(JSON.parse(made[2][1].body as string)).toEqual({ isActive: true });
  });
});
