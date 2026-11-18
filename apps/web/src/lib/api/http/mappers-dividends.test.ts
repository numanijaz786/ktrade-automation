import { describe, expect, it, vi } from 'vitest';
import { HttpApiClient } from '../http-client';
import {
  mapDividendComputeResult,
  mapDividendDeclaration,
  mapDividendEntitlement,
  mapMarkPaidResult,
  notificationLink,
  toApiDividendInput,
  toApiDividendUpdate,
  toApiMarkPaid,
  type ApiDividend,
  type ApiDividendEntitlement,
  type ApiMarkPaidResult,
} from './mappers';

const apiDividend: ApiDividend = {
  id: 'd1',
  symbol: 'OGDC',
  companyName: 'Oil & Gas Development Co',
  announcementDate: '2026-10-01',
  bookClosureFrom: '2026-10-20',
  bookClosureTo: '2026-10-22',
  paymentDate: null,
  dividendPerShare: '4.250000',
  source: 'USER_REPORTED',
  locked: false,
  createdAt: '2026-10-01T05:00:00.000Z',
};

const apiEntitlement: ApiDividendEntitlement = {
  id: 'e1',
  dividendId: 'd1',
  portfolioId: 'p1',
  symbol: 'OGDC',
  bookClosureFrom: '2026-10-20',
  bookClosureTo: '2026-10-22',
  paymentDate: null,
  dividendPerShare: '4.250000',
  sharesEligible: '1000',
  grossAmount: '4250.0000',
  whtRate: null,
  whtAmount: null,
  zakatAmount: '0.0000',
  netAmount: null,
  netBeforeWht: '4250.0000',
  taxStatus: 'NOT_CONFIGURED',
  taxNote: 'No verified dividend WHT rate for FILER on 2026-10-20. Enter the confirmed rate and recompute.',
  status: 'ENTITLED',
  source: 'ESTIMATED',
  provisional: false,
  paidAt: null,
  cashMovementId: null,
  reconciledAt: null,
  updatedAt: '2026-11-13T05:00:00.000Z',
};

describe('dividend mappers', () => {
  it('maps a declaration, keeping nulls and provenance', () => {
    expect(mapDividendDeclaration(apiDividend)).toEqual({ ...apiDividend });
    const bare = mapDividendDeclaration({ ...apiDividend, companyName: undefined, locked: true });
    expect(bare.companyName).toBeNull();
    expect(bare.locked).toBe(true);
  });

  it('builds strict create/update bodies (no source, only given fields)', () => {
    expect(
      toApiDividendInput({ symbol: 'OGDC', bookClosureFrom: '2026-10-20', dividendPerShare: '4.25' }),
    ).toEqual({ symbol: 'OGDC', bookClosureFrom: '2026-10-20', dividendPerShare: '4.25' });
    expect(toApiDividendUpdate({ paymentDate: null, dividendPerShare: '5' })).toEqual({
      paymentDate: null,
      dividendPerShare: '5',
    });
  });

  it('never surfaces WHT / net for NOT_CONFIGURED or RECOMPUTE_REQUIRED, even if the payload has them', () => {
    for (const taxStatus of ['NOT_CONFIGURED', 'RECOMPUTE_REQUIRED'] as const) {
      const m = mapDividendEntitlement({
        ...apiEntitlement,
        taxStatus,
        whtRate: '0.00000000',
        whtAmount: '0.0000',
        netAmount: '4250.0000',
      });
      expect(m.whtRate).toBeNull();
      expect(m.whtAmount).toBeNull();
      expect(m.netAmount).toBeNull();
      expect(m.netBeforeWht).toBe('4250.0000');
      expect(m.source).toBe('ESTIMATED');
    }
    const configured = mapDividendEntitlement({
      ...apiEntitlement,
      taxStatus: 'CONFIGURED',
      whtRate: '0.15000000',
      whtAmount: '637.5000',
      netAmount: '3612.5000',
    });
    expect(configured).toMatchObject({
      whtAmount: '637.5000',
      netAmount: '3612.5000',
      whtRate: '0.15000000',
    });
  });

  it('maps the compute result including the settlement assumption', () => {
    const r = mapDividendComputeResult({
      portfolioId: 'p1',
      settlement: { days: 1, basis: 'DEFAULT', note: 'Default T+1 settlement… owner must confirm' },
      filerStatus: 'FILER',
      counts: { created: 1, updated: 0, unchanged: 0, removed: 0, skippedSettled: 0, notEligible: 2 },
      data: [apiEntitlement],
    });
    expect(r.settlement).toEqual({
      days: 1,
      basis: 'DEFAULT',
      note: 'Default T+1 settlement… owner must confirm',
    });
    expect(r.counts.notEligible).toBe(2);
    expect(r.data[0].taxStatus).toBe('NOT_CONFIGURED');
  });

  it('always sends whtAmount on mark-paid; omits an empty zakat', () => {
    expect(toApiMarkPaid({ paidAt: '2026-11-10', netAmount: '3612.5', whtAmount: '0' })).toEqual({
      paidAt: '2026-11-10',
      netAmount: '3612.5',
      whtAmount: '0',
    });
    expect(
      toApiMarkPaid({ paidAt: '2026-11-10', netAmount: '1', whtAmount: '2', zakatAmount: '' }),
    ).not.toHaveProperty('zakatAmount');
  });

  it('maps the mark-paid result with differences and warnings', () => {
    const raw: ApiMarkPaidResult = {
      entitlement: {
        ...apiEntitlement,
        status: 'PAID',
        source: 'USER_REPORTED',
        taxStatus: 'AS_PAID',
        whtRate: '0.14117647',
        whtAmount: '600.0000',
        netAmount: '3600.0000',
        paidAt: '2026-11-10',
        cashMovementId: 'c1',
      },
      cashMovementId: 'c1',
      whtBasis: 'REPORTED',
      unexplainedDifference: '50.0000',
      warnings: ['gross − zakat − withholding − received = 50.0000: check the share count'],
      estimate: { netAmount: null, whtAmount: null, grossAmount: '4250.0000', taxStatus: 'NOT_CONFIGURED' },
      differences: { netAmount: null, whtAmount: null, grossAmount: '-50.0000' },
    };
    const m = mapMarkPaidResult(raw);
    expect(m.unexplainedDifference).toBe('50.0000');
    expect(m.warnings).toHaveLength(1);
    expect(m.differences).toEqual({ netAmount: null, whtAmount: null, grossAmount: '-50.0000' });
    expect(m.entitlement).toMatchObject({ status: 'PAID', whtAmount: '600.0000', source: 'USER_REPORTED' });
    expect(mapMarkPaidResult({ ...raw, warnings: undefined }).warnings).toEqual([]);
  });

  it('links DIVIDEND_RECEIVED notifications to /dividends', () => {
    expect(notificationLink('DIVIDEND_RECEIVED', null)).toBe('/dividends');
  });
});

describe('HttpApiClient.dividends', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('calls the API routes with the right methods and bodies', async () => {
    const responses = [
      json([apiDividend]),
      json({ data: [apiEntitlement], filerStatus: 'FILER' }),
      json({
        portfolioId: 'p1',
        settlement: { days: 1, basis: 'DEFAULT', note: 'n' },
        filerStatus: 'FILER',
        counts: { created: 0, updated: 0, unchanged: 1, removed: 0, skippedSettled: 0, notEligible: 0 },
        data: [apiEntitlement],
      }),
      json({ ...apiDividend, estimatedEntitlementsCleared: 1 }),
      json({ id: 'd1', deleted: true, estimatedEntitlementsCleared: 0 }),
      json({ ...apiEntitlement, status: 'RECONCILED', source: 'BROKER_CONFIRMED', taxStatus: 'AS_PAID' }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const c = new HttpApiClient({ fetch: fetchMock as unknown as typeof fetch, readCookie: () => 'tok' });
    expect((await c.dividends.declarations())[0].symbol).toBe('OGDC');
    expect((await c.dividends.entitlements('p1')).filerStatus).toBe('FILER');
    expect((await c.dividends.compute('p1')).settlement.basis).toBe('DEFAULT');
    expect(
      (await c.dividends.updateDeclaration('d1', { paymentDate: '2026-11-30' })).estimatedEntitlementsCleared,
    ).toBe(1);
    expect((await c.dividends.deleteDeclaration('d1')).deleted).toBe(true);
    expect((await c.dividends.reconcile('e1', { statementRef: '  CDC-1 ' })).status).toBe('RECONCILED');
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      'GET /bff/dividends?limit=500',
      'GET /bff/portfolios/p1/dividend-entitlements',
      'POST /bff/portfolios/p1/dividend-entitlements/compute',
      'PATCH /bff/dividends/d1',
      'DELETE /bff/dividends/d1',
      'POST /bff/dividend-entitlements/e1/reconcile',
    ]);
    expect(JSON.parse(calls[3][1].body as string)).toEqual({ paymentDate: '2026-11-30' });
    expect(JSON.parse(calls[5][1].body as string)).toEqual({ statementRef: 'CDC-1' });
  });
});
