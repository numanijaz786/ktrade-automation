import { describe, expect, it } from 'vitest';
import { RECOMMENDATION_HORIZONS } from '@ktrade/shared';
import type { MarketProvider } from '../types';
import { problemToApiError } from './mappers';
import {
  mapFinancial,
  mapNewsFeed,
  mapPerformanceReport,
  mapRecommendation,
  mapResearchProvider,
  marketProviderRow,
  researchProviderRow,
  textList,
  toApiAnnouncement,
  toApiFinancial,
  toPerformanceQuery,
  type ApiRecommendation,
} from './mappers-research';

describe('financial mapping', () => {
  it('keeps only the items the API returned (never zero-fills)', () => {
    const p = mapFinancial({
      id: 'f1',
      symbol: 'OGDC',
      periodType: 'ANNUAL',
      periodEnd: '2025-06-30',
      publishedAt: '2025-09-05T00:00:00.000Z',
      currency: 'PKR',
      source: 'USER_REPORTED',
      sourceRef: 'AR 2025 p.41',
      revenue: '100.5000',
      eps: '9.300000',
    });
    expect(p.items).toEqual({ revenue: '100.5000', eps: '9.300000' });
    expect(p.items.netProfit).toBeUndefined();
    expect(p.sourceUrl).toBeNull();
  });

  it('sends only filled items, as decimal strings', () => {
    const body = toApiFinancial({
      symbol: ' ogdc ',
      periodType: 'ANNUAL',
      periodEnd: '2025-06-30',
      publishedAt: '2025-09-05',
      currency: 'pkr',
      sourceRef: ' AR ',
      items: { revenue: '10.50', netProfit: '  ' },
    });
    expect(body).toMatchObject({ symbol: 'OGDC', currency: 'PKR', sourceRef: 'AR', revenue: '10.50' });
    expect(body).not.toHaveProperty('netProfit');
  });
});

describe('announcement mapping', () => {
  it('makes the first symbol primary and keeps all in symbols', () => {
    expect(
      toApiAnnouncement({
        title: ' T1 ',
        category: 'DIVIDEND',
        publishedAt: '2026-11-01',
        symbols: ['ogdc', 'PPL', 'OGDC'],
      }),
    ).toEqual({
      title: 'T1',
      category: 'DIVIDEND',
      publishedAt: '2026-11-01',
      symbol: 'OGDC',
      symbols: ['OGDC', 'PPL'],
    });
  });

  it('maps a feed and keeps null sentiment as "not assessed"', () => {
    const f = mapNewsFeed({
      generatedAt: 'x',
      windowHours: 72,
      lastUpdated: null,
      coverage: 'sources: owner-entered only',
      count: 1,
      items: [
        {
          id: '1',
          symbol: null,
          symbols: [],
          title: 'T',
          summary: null,
          url: null,
          category: 'OTHER',
          source: 'USER_REPORTED',
          sourceName: 'Owner-entered',
          publishedAt: 'p',
          retrievedAt: 'r',
          sentiment: null,
          sentimentSource: 'NONE',
          relevance: null,
          affectsHoldings: false,
          affectedSymbols: [],
        },
      ],
    });
    expect(f.lastUpdated).toBeNull();
    expect(f.note).toBeNull();
    expect(f.items[0].sentiment).toBeNull();
  });
});

describe('provider rows', () => {
  const research = (over: object) =>
    mapResearchProvider({
      providerKey: 'k',
      displayName: 'Prov',
      dataType: 'MACRO',
      enabled: false,
      source: 'PROVIDER',
      status: 'NOT_CONFIGURED',
      lastAttemptAt: 'a',
      lastSuccessAt: null,
      freshnessMinutes: null,
      message: 'disabled',
      capabilities: { freshness: [], delayMinutes: 0, licenseNote: 'L', commercialUseAllowed: false },
      licenseNote: 'L',
      commercialUseAllowed: false,
      missing: ['Free SBP account (USER_ACTION_REQUIRED #8)'],
      ...over,
    });

  it('a disabled research provider is NOT_CONFIGURED and keeps the API missing list', () => {
    const row = researchProviderRow(research({ status: 'OK' }));
    expect(row.status).toBe('NOT_CONFIGURED');
    expect(row.missing).toEqual(['Free SBP account (USER_ACTION_REQUIRED #8)']);
    expect(row.dataType).toBe('Macro');
  });

  it('maps market providers: disabled, healthy and unhealthy', () => {
    const base: MarketProvider = {
      key: 'p',
      displayName: 'P',
      source: 'PROVIDER',
      enabled: true,
      active: false,
      disabledReason: null,
      capabilities: {
        quotes: true,
        intradayBars: false,
        eodBars: true,
        corporateActions: false,
        streaming: false,
        delayMinutes: 15,
      },
      health: { ok: true, checkedAt: 'c' },
    };
    expect(marketProviderRow(base)).toMatchObject({
      status: 'OK',
      timeliness: 'Delayed (15 min)',
      lastSuccessAt: 'c',
    });
    expect(
      marketProviderRow({ ...base, health: { ok: false, checkedAt: 'c', message: 'down' } }),
    ).toMatchObject({
      status: 'DEGRADED',
      lastSuccessAt: null,
    });
    expect(
      marketProviderRow({ ...base, enabled: false, disabledReason: 'Needs a key', health: null }),
    ).toMatchObject({
      status: 'NOT_CONFIGURED',
      missing: ['Needs a key'],
    });
  });
});

describe('recommendations mapping', () => {
  it('reads reasons given as strings or objects, and ignores junk', () => {
    expect(textList(['a', { text: 'b' }, { message: 'c' }, 5, null, { x: 1 }, ' '])).toEqual(['a', 'b', 'c']);
    expect(textList('nope')).toEqual([]);
  });

  it('keeps a STOPPED outcome and flags simulated rows', () => {
    const r = mapRecommendation({
      id: 'r1',
      symbol: 'HBL',
      horizon: 'SHORT_TERM',
      action: 'BUY',
      status: 'ACTIONABLE',
      generatedAt: 'g',
      asOfBar: '2026-11-01',
      price: '100.00',
      priceSource: 'PROVIDER',
      entryLow: null,
      entryHigh: null,
      stop: '95',
      target1: '110',
      target2: null,
      target3: null,
      riskReward: null,
      holdingPeriod: null,
      holdingDaysMax: null,
      confidence: '70.00',
      confidenceLevel: 'MEDIUM',
      reasons: [{ text: 'RSI ok' }],
      invalidations: ['Close below stop'],
      dataQuality: { latestBarSource: 'PROVIDER', warnings: ['w'], missingInputs: 'bad' },
      engineVersion: 'v1',
      latestOutcome: {
        id: 'o1',
        evaluatedAt: 'e',
        lastBarDate: '2026-11-05',
        status: 'STOPPED',
        maxFavourablePct: null,
        maxAdversePct: '-5.0000',
        target1HitAt: null,
        target2HitAt: null,
        target3HitAt: null,
        stopHitAt: '2026-11-05',
        closedAt: '2026-11-05',
        exitPrice: '95.0000',
        returnPct: '-5.0000',
        holdingDays: 4,
        benchmarkReturnPct: null,
      },
    } satisfies ApiRecommendation);
    expect(r.latestOutcome?.status).toBe('STOPPED');
    expect(r.simulated).toBe(false);
    expect(r.reasons).toEqual(['RSI ok']);
    expect(r.dataQuality.missingInputs).toEqual([]);
    expect(r.dataQuality.warnings).toEqual(['w']);
  });

  it('performance: fills every horizon and keeps a null benchmark', () => {
    const p = mapPerformanceReport({
      recommendations: 0,
      evaluated: 0,
      open: 0,
      closed: 0,
      winRatePct: null,
      avgReturnPct: null,
      targetHitRatePct: null,
      stopFrequencyPct: null,
      avgHoldingDays: null,
      avgBenchmarkReturnPct: null,
      benchmarkSamples: 0,
      scope: { onlyActionable: true, includesSimulated: false },
      perHorizon: {},
      benchmark: null,
      benchmarkNote: 'No KSE-100 series',
      note: 'n',
    });
    expect(Object.keys(p.perHorizon).sort()).toEqual([...RECOMMENDATION_HORIZONS].sort());
    expect(p.benchmark).toBeNull();
  });

  it('sends includeSimulated explicitly', () => {
    expect(toPerformanceQuery({})).toMatchObject({ includeSimulated: 'false' });
    expect(toPerformanceQuery({ includeSimulated: true, symbol: ' hbl ' })).toMatchObject({
      includeSimulated: 'true',
      symbol: 'HBL',
    });
  });
});

describe('CSV problem documents', () => {
  it('carries row-level errors through', () => {
    const e = problemToApiError(422, {
      code: 'VALIDATION_FAILED',
      title: 'Validation failed',
      errors: [{ path: 'rows.3.title', message: 'bad' }],
    });
    expect(e.errors).toEqual([{ path: 'rows.3.title', message: 'bad' }]);
  });
});
