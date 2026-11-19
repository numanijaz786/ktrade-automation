import { describe, expect, it } from 'vitest';
import { baseReport, fixtureBuy } from '@/test/advisor-fixtures';
import { HttpApiClient } from '../http-client';
import {
  mapAdvisorSettings,
  mapDailyReport,
  mapEvaluation,
  mapHoldingAdvice,
  mapPrice,
  mapScannerReport,
  mapSource,
  mapStockReport,
} from './mappers-advisor';

describe('advisor mappers', () => {
  it('maps a full buy evaluation and keeps decimal strings untouched', () => {
    const ev = mapEvaluation(fixtureBuy);
    expect(ev.plan?.entry).toEqual({ low: '98', high: '101', basis: 'near support' });
    expect(ev.plan?.targets.map((t) => t.price)).toEqual(['110', '118']);
    expect(ev.plan?.targets[1]?.netRiskReward).toBeNull();
    expect(ev.plan?.size.maxLossAtStop).toBe('1400');
    expect(ev.confidence?.components).toHaveLength(2);
    expect(ev.price?.verified).toBe(true);
  });

  it('never invents a plan, confidence or price that the API did not return', () => {
    const ev = mapEvaluation({
      symbol: 'X',
      horizon: 'SWING',
      status: 'NOT_ACTIONABLE',
      action: null,
      plan: { entry: { low: '1' } },
    });
    expect(ev.plan).toBeNull();
    expect(ev.confidence).toBeNull();
    expect(ev.price).toBeNull();
    expect(mapPrice({ value: 12, source: 'PROVIDER' })).toBeNull(); // numbers are not money
  });

  it('SIMULATED / ESTIMATED / unknown sources are never verified', () => {
    expect(mapPrice({ value: '1', source: 'SIMULATED', verified: true })?.verified).toBe(false);
    expect(mapPrice({ value: '1', source: 'ESTIMATED', verified: true })?.verified).toBe(false);
    expect(mapPrice({ value: '1', source: 'PROVIDER' })?.verified).toBe(false);
    expect(mapSource('WHATEVER')).toBe('ESTIMATED');
  });

  it('drops every buy/sell level when notEnoughData is set, whatever else the payload says', () => {
    const r = mapDailyReport({
      ...baseReport,
      topBuys: [fixtureBuy],
      opportunities: [fixtureBuy],
      avoidOrSell: [fixtureBuy],
    });
    expect(r.notEnoughData?.simulated).toBe(3);
    expect(r.topBuys).toEqual([]);
    expect(r.opportunities).toEqual([]);
    expect(r.avoidOrSell).toEqual([]);
  });

  it('keeps buys when there is no notEnoughData', () => {
    const r = mapDailyReport({
      ...baseReport,
      notEnoughData: null,
      headline: '1 buy candidate today',
      topBuys: [fixtureBuy],
    });
    expect(r.topBuys).toHaveLength(1);
  });

  it('maps holding advice with null fee-aware figures when absent', () => {
    const h = mapHoldingAdvice({
      symbol: 'OGDC',
      name: 'OGDC',
      quantity: '100',
      avgCost: '90',
      price: { value: '100', source: 'SIMULATED', asOfBar: '2026-11-19', barTs: 'x', verified: false },
      marketValue: '10000',
      pnl: {
        lastPrice: '100',
        costBasis: '9000',
        marketValue: '10000',
        unrealizedGross: '1000',
        priceSource: 'SIMULATED',
      },
      status: 'NOT_ACTIONABLE',
      advice: null,
      headline: 'No holding advice',
    });
    expect(h.pnl?.unrealizedNet).toBeNull();
    expect(h.pnl?.estimatedSellFees).toBeNull();
    expect(h.advice).toBeNull();
    expect(h.stop).toBeNull();
    expect(h.sellRange).toBeNull();
  });

  it('maps scanner results with matched metric/value/threshold', () => {
    const s = mapScannerReport({
      horizon: 'VALUE',
      filter: 'undervalued',
      results: [
        { rank: 1, symbol: 'A', matched: { metric: 'P/E', value: '8', threshold: '<= 12' }, price: null },
      ],
    });
    expect(s.results[0]?.matched).toEqual({ metric: 'P/E', value: '8', threshold: '<= 12' });
    expect(mapScannerReport({ results: [], note: 'No stock matches' }).results).toEqual([]);
  });

  it('maps a stock report: unavailable ratios keep their missing list; valuation splits facts and assumptions', () => {
    const r = mapStockReport({
      symbol: 'A',
      name: 'A Ltd',
      ratios: {
        pe: { status: 'OK', value: '8', unit: 'RATIO', formula: 'p/e', flags: [] },
        pb: { status: 'UNAVAILABLE', missing: ['bookValue'], reason: 'no book value' },
      },
      valuation: {
        status: 'OK',
        facts: [{ name: 'annualEps', value: '10', period: '2026', currency: 'PKR', source: 'USER_REPORTED' }],
        assumptions: [{ name: 'peerPe', value: '12', basis: 'peer median of 4' }],
        fairValueLow: '120',
        fairValueHigh: '130',
        marginOfSafetyPct: '20',
        explanation: [],
      },
      recommendations: { SWING: fixtureBuy, BOGUS: fixtureBuy },
      dataSources: {
        bars: { count: 3, sources: ['SIMULATED'] },
        quote: null,
        fundamentals: null,
        stale: false,
      },
    });
    expect(r.ratios?.pb).toEqual({ status: 'UNAVAILABLE', missing: ['bookValue'], reason: 'no book value' });
    expect(r.valuation.facts).toHaveLength(1);
    expect(r.valuation.assumptions[0]?.basis).toBe('peer median of 4');
    expect(Object.keys(r.recommendations)).toEqual(['SWING']);
    const none = mapStockReport({
      symbol: 'A',
      ratios: { status: 'UNAVAILABLE', reason: 'no statements' },
      valuation: { status: 'UNAVAILABLE', reason: 'needs peers' },
    });
    expect(none.ratios).toBeNull();
    expect(none.ratiosReason).toBe('no statements');
    expect(none.valuation.status).toBe('UNAVAILABLE');
  });

  it('maps settings', () => {
    expect(mapAdvisorSettings({ riskPerTradePct: '1.5', isDefault: false })).toEqual({
      riskPerTradePct: '1.5',
      isDefault: false,
    });
  });
});

describe('HttpApiClient advisor', () => {
  function client(fetchFn: typeof fetch) {
    return new HttpApiClient({ fetch: fetchFn, readCookie: () => 'csrf' });
  }
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

  it('calls the advisor endpoints with the right query and CSRF on writes', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const c = client(((url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve(
        json(
          url.includes('daily-report')
            ? baseReport
            : url.includes('settings')
              ? { riskPerTradePct: '2', isDefault: false }
              : {},
        ),
      );
    }) as unknown as typeof fetch);
    const r = await c.advisor.dailyReport({ portfolioId: 'p1', horizon: 'VALUE' });
    expect(r.headline).toBe('Not enough verified data to recommend anything');
    expect(calls[0]?.[0]).toBe('/bff/advisor/daily-report?portfolioId=p1&horizon=VALUE');
    await c.advisor.updateSettings('2');
    expect(calls[1]?.[0]).toBe('/bff/advisor/settings');
    expect(calls[1]?.[1]?.method).toBe('PUT');
    expect(JSON.parse(calls[1]?.[1]?.body as string)).toEqual({ riskPerTradePct: '2' });
    await c.advisor.stock(' ogdc ', 'p1');
    expect(calls[2]?.[0]).toBe('/bff/advisor/stocks/OGDC?portfolioId=p1');
  });
});
