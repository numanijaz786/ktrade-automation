/**
 * Demo research data and recommendation history, used by `DemoApiClient`. Seeded items are labelled
 * SIMULATED (demo) and say so in their text; items the user adds are USER_REPORTED, as in the real API.
 * Recommendations: the demo has NO actionable calls. Like the real engine on simulated prices, every seeded
 * row is NOT_ACTIONABLE ("simulated data — not for investment decisions"), so nothing here can be mistaken
 * for advice, and the performance panel honestly shows an empty sample.
 */
import {
  FINANCIAL_PERIOD_TYPES,
  MACRO_SERIES,
  RECOMMENDATION_HORIZONS,
  type DataSource,
} from '@ktrade/shared';
import { Dec } from '../decimal';
import { ApiError, type FieldError } from './errors';
import { isIsoDate, SYMBOL_RE } from './dividends-rules';
import type { ApiClient } from './client';
import {
  FINANCIAL_ITEM_KEYS,
  type AnnouncementInput,
  type FinancialPeriod,
  type MacroObservation,
  type NewsItem,
  type PerformanceStats,
  type Recommendation,
  type ResearchProviderStatus,
} from './types';

export const DEMO_COVERAGE_NOTE = 'sources: owner-entered only';
const HOUR = 3_600_000;
const DEMO_SYMBOLS = new Set(['OGDC', 'PPL', 'HBL', 'LUCK', 'ENGRO', 'MCB', 'UBL', 'FFC', 'PSO', 'MARI']);

const fieldFail = (path: string, message: string): ApiError =>
  new ApiError('VALIDATION_FAILED', 422, 'Validation failed', undefined, { errors: [{ path, message }] });

/** Minimal RFC 4180-ish reader: quoted fields, doubled quotes, header-driven. Mirrors the API's row-error shape. */
function readCsv(
  text: string,
  required: string[],
  optional: string[],
): { rows: { line: number; v: Record<string, string> }[] } {
  const fail = (errors: FieldError[]) =>
    new ApiError('VALIDATION_FAILED', 422, 'Validation failed', undefined, { errors });
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((raw, i) => ({ raw, line: i + 1 }))
    .filter((l) => l.raw.trim() !== '');
  if (lines.length === 0) throw fail([{ path: 'rows.1', message: 'file is empty' }]);
  const split = (s: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"' && s[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') {
        out.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const header = split(lines[0].raw).map((h) => h.toLowerCase());
  const canon = new Map([...required, ...optional].map((c) => [c.toLowerCase(), c]));
  const errors: FieldError[] = [];
  for (const h of header)
    if (!canon.has(h)) errors.push({ path: `rows.${lines[0].line}`, message: `unknown column "${h}"` });
  for (const c of required)
    if (!header.includes(c.toLowerCase()))
      errors.push({ path: `rows.${lines[0].line}`, message: `missing column "${c}"` });
  if (errors.length) throw fail(errors);
  if (lines.length === 1) throw fail([{ path: `rows.${lines[0].line + 1}`, message: 'no data rows' }]);
  const rows = lines.slice(1).map((l) => {
    const cells = split(l.raw);
    const v: Record<string, string> = {};
    header.forEach((h, i) => {
      if (cells[i]) v[canon.get(h)!] = cells[i];
    });
    return { line: l.line, v };
  });
  return { rows };
}

const whenOk = (v: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v) || !isIsoDate(v.slice(0, 10))) return false;
  return !Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v));
};

export interface DemoResearchOptions {
  latencyMs: number;
  now: () => number;
}

export function createDemoResearch(
  opts: DemoResearchOptions,
): Pick<ApiClient, 'research' | 'recommendations'> {
  const iso = (offsetMs = 0) => new Date(opts.now() + offsetMs).toISOString();
  let seq = 0;
  const id = (p: string) => `${p}-demo-${++seq}`;
  const wait = async () => {
    if (opts.latencyMs > 0) await new Promise((r) => setTimeout(r, opts.latencyMs));
  };

  const news: NewsItem[] = [
    {
      id: 'news-demo-a',
      symbol: 'OGDC',
      symbols: ['OGDC'],
      title: 'DEMO sample: board meeting scheduled to consider results',
      summary: 'Sample item for the demo. It is not a real announcement.',
      url: null,
      category: 'BOARD_MEETING',
      source: 'SIMULATED',
      sourceName: 'Demo sample',
      publishedAt: iso(-5 * HOUR),
      retrievedAt: iso(-4 * HOUR),
      sentiment: null,
      sentimentSource: 'NONE',
      relevance: null,
      affectsHoldings: true,
      affectedSymbols: ['OGDC'],
    },
    {
      id: 'news-demo-b',
      symbol: null,
      symbols: [],
      title: 'DEMO sample: central bank policy rate review expected this month',
      summary: 'Sample item for the demo. It is not a real announcement.',
      url: null,
      category: 'MACRO',
      source: 'SIMULATED',
      sourceName: 'Demo sample',
      publishedAt: iso(-30 * HOUR),
      retrievedAt: iso(-29 * HOUR),
      sentiment: null,
      sentimentSource: 'NONE',
      relevance: null,
      affectsHoldings: false,
      affectedSymbols: [],
    },
  ];
  let financials: FinancialPeriod[] = [
    {
      id: 'fin-demo-a',
      symbol: 'OGDC',
      periodType: 'ANNUAL',
      periodEnd: '2025-06-30',
      publishedAt: '2025-09-05T00:00:00.000Z',
      currency: 'PKR',
      source: 'SIMULATED',
      sourceRef: 'DEMO sample figures (not from a real report)',
      sourceUrl: null,
      items: { revenue: '100000000000', netProfit: '40000000000', eps: '9.3000', dividendPerShare: '3.5000' },
    },
  ];
  const macro: MacroObservation[] = [
    {
      id: 'macro-demo-a',
      series: 'POLICY_RATE',
      date: '2026-11-01',
      value: '11.000000',
      source: 'SIMULATED',
      sourceRef: 'DEMO sample (not an official figure)',
    },
  ];
  let lastAdded: string | null = iso(-4 * HOUR);

  const mkProvider = (
    p: Partial<ResearchProviderStatus> &
      Pick<ResearchProviderStatus, 'providerKey' | 'displayName' | 'dataType'>,
  ): ResearchProviderStatus => ({
    enabled: false,
    source: 'USER_REPORTED',
    status: 'NOT_CONFIGURED',
    lastAttemptAt: iso(),
    lastSuccessAt: null,
    freshnessMinutes: null,
    message: null,
    freshness: [],
    delayMinutes: 0,
    licenseNote: '',
    commercialUseAllowed: false,
    missing: [],
    ...p,
  });
  const manual = (key: string, name: string, dataType: ResearchProviderStatus['dataType']) =>
    mkProvider({
      providerKey: key,
      displayName: name,
      dataType,
      enabled: true,
      status: 'OK',
      lastSuccessAt: lastAdded,
      freshnessMinutes: 240,
      message: 'Demo: owner-entered sample data only.',
      freshness: ['historical'],
      licenseNote: 'Your own entries. Respect the terms of the documents you copy from.',
    });

  const recs: Recommendation[] = ['SHORT_TERM', 'MEDIUM_TERM'].map((h, i) => ({
    id: `rec-demo-${i + 1}`,
    symbol: i === 0 ? 'OGDC' : 'HBL',
    horizon: h as Recommendation['horizon'],
    action: 'HOLD',
    status: 'NOT_ACTIONABLE',
    generatedAt: iso(-(i + 1) * 24 * HOUR),
    asOfBar: new Date(opts.now() - (i + 1) * 24 * HOUR).toISOString().slice(0, 10),
    price: null,
    priceSource: 'SIMULATED' as DataSource,
    simulated: true,
    entryLow: null,
    entryHigh: null,
    stop: null,
    target1: null,
    target2: null,
    target3: null,
    riskReward: null,
    holdingPeriod: null,
    holdingDaysMax: null,
    confidence: null,
    confidenceLevel: 'LOW',
    reasons: ['simulated data — not for investment decisions'],
    invalidations: [],
    dataQuality: {
      latestBarSource: 'SIMULATED',
      latestBarTs: null,
      barsUsed: null,
      missingInputs: [],
      warnings: ['Demo mode: prices are simulated, so no recommendation is actionable.'],
    },
    engineVersion: 'demo',
    latestOutcome: null,
  }));

  const emptyStats = (): PerformanceStats => ({
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
  });

  const toNews = (i: AnnouncementInput): NewsItem => {
    const symbols = [...new Set(i.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const held = symbols.filter((s) => s === 'OGDC');
    return {
      id: id('news'),
      symbol: symbols[0] ?? null,
      symbols,
      title: i.title.trim(),
      summary: i.summary?.trim() || null,
      url: i.url?.trim() || null,
      category: i.category,
      source: 'USER_REPORTED',
      sourceName: i.sourceName?.trim() || 'Owner-entered',
      publishedAt: i.publishedAt.length === 10 ? `${i.publishedAt}T00:00:00.000Z` : i.publishedAt,
      retrievedAt: iso(),
      sentiment: i.sentiment ?? null,
      sentimentSource: i.sentiment ? 'MANUAL' : 'NONE',
      relevance: null,
      affectsHoldings: held.length > 0,
      affectedSymbols: held,
    };
  };

  const research: ApiClient['research'] = {
    newsFeed: async (q = {}) => {
      await wait();
      const hours = q.windowHours ?? 72;
      const now = opts.now();
      const items = news
        .filter((n) => Date.parse(n.publishedAt) >= now - hours * HOUR && Date.parse(n.publishedAt) <= now)
        .filter((n) => !q.symbol || n.symbols.includes(q.symbol.trim().toUpperCase()))
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
      return structuredClone({
        generatedAt: iso(),
        windowHours: hours,
        lastUpdated: lastAdded,
        coverage: DEMO_COVERAGE_NOTE,
        count: items.length,
        items,
        note:
          items.length === 0
            ? `No announcements published in the last ${hours} hours. Nothing is fetched automatically; items appear only when the owner enters them.`
            : null,
      });
    },
    addAnnouncement: async (input) => {
      await wait();
      if (input.title.trim().length < 3) throw fieldFail('title', 'must be at least 3 characters');
      if (!whenOk(input.publishedAt))
        throw fieldFail('publishedAt', 'must be YYYY-MM-DD or an ISO timestamp');
      if (Date.parse(input.publishedAt) > opts.now())
        throw fieldFail('publishedAt', 'must not be in the future');
      const item = toNews(input);
      if (
        news.some(
          (n) =>
            n.title.toLowerCase() === item.title.toLowerCase() &&
            n.url === item.url &&
            n.publishedAt === item.publishedAt,
        )
      )
        throw new ApiError(
          'DUPLICATE_ANNOUNCEMENT',
          409,
          'Conflict',
          'This announcement (same title, url and publish time) is already recorded',
        );
      news.push(item);
      lastAdded = iso();
      return structuredClone(item);
    },
    importAnnouncements: async (csv) => {
      await wait();
      const { rows } = readCsv(
        csv,
        ['publishedAt', 'title'],
        ['category', 'symbol', 'symbols', 'url', 'summary', 'sourceName', 'sentiment', 'relevance'],
      );
      const errors: FieldError[] = [];
      for (const r of rows) {
        if (!r.v.title || r.v.title.length < 3)
          errors.push({ path: `rows.${r.line}.title`, message: 'must be at least 3 characters' });
        if (!r.v.publishedAt || !whenOk(r.v.publishedAt))
          errors.push({
            path: `rows.${r.line}.publishedAt`,
            message: 'must be YYYY-MM-DD or an ISO timestamp with timezone',
          });
        else if (Date.parse(r.v.publishedAt) > opts.now())
          errors.push({ path: `rows.${r.line}.publishedAt`, message: 'must not be in the future' });
        if (r.v.symbol && !SYMBOL_RE.test(r.v.symbol.toUpperCase()))
          errors.push({ path: `rows.${r.line}.symbol`, message: 'invalid symbol' });
      }
      if (errors.length)
        throw new ApiError('VALIDATION_FAILED', 422, 'Validation failed', undefined, { errors });
      let inserted = 0;
      for (const r of rows) {
        const item = toNews({
          title: r.v.title,
          publishedAt: r.v.publishedAt,
          category: (r.v.category?.toUpperCase() as NewsItem['category']) ?? 'OTHER',
          symbols: [r.v.symbol, ...(r.v.symbols?.split(';') ?? [])].filter((s): s is string => !!s),
          url: r.v.url,
          summary: r.v.summary,
          sourceName: r.v.sourceName,
        });
        if (
          news.some(
            (n) =>
              n.title.toLowerCase() === item.title.toLowerCase() &&
              n.url === item.url &&
              n.publishedAt === item.publishedAt,
          )
        )
          continue;
        news.push(item);
        inserted++;
      }
      if (inserted) lastAdded = iso();
      return { rows: rows.length, inserted, skipped: rows.length - inserted, source: 'USER_REPORTED' };
    },
    financials: async (symbol) => {
      await wait();
      const s = symbol.trim().toUpperCase();
      if (!DEMO_SYMBOLS.has(s))
        throw new ApiError('UNKNOWN_SYMBOL', 404, 'Not Found', `Unknown symbol: ${s}`);
      const data = financials
        .filter((f) => f.symbol === s)
        .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
      return structuredClone({
        symbol: s,
        data,
        note:
          data.length === 0
            ? 'No fundamentals on file for this symbol. Nothing is estimated; enter figures from the company report.'
            : 'Owner-entered figures (USER_REPORTED), in full currency units.',
      });
    },
    saveFinancial: async (input) => {
      await wait();
      const symbol = input.symbol.trim().toUpperCase();
      if (!DEMO_SYMBOLS.has(symbol))
        throw new ApiError('UNKNOWN_SYMBOL', 404, 'Not Found', `Unknown symbol: ${symbol}`);
      if (!isIsoDate(input.periodEnd)) throw fieldFail('periodEnd', 'must be a calendar date YYYY-MM-DD');
      if (!whenOk(input.publishedAt))
        throw fieldFail('publishedAt', 'must be YYYY-MM-DD or an ISO timestamp');
      if (input.publishedAt.slice(0, 10) < input.periodEnd)
        throw fieldFail('publishedAt', 'must not be before periodEnd');
      if (input.sourceRef.trim().length < 3) throw fieldFail('sourceRef', 'cite the document and page');
      const items: FinancialPeriod['items'] = {};
      for (const k of FINANCIAL_ITEM_KEYS) {
        const v = input.items[k]?.trim();
        if (!v) continue;
        try {
          Dec.of(v);
        } catch {
          throw fieldFail(k, 'must be a decimal number');
        }
        items[k] = v;
      }
      if (Object.keys(items).length === 0) throw fieldFail('revenue', 'provide at least one financial item');
      const row: FinancialPeriod = {
        id: id('fin'),
        symbol,
        periodType: input.periodType,
        periodEnd: input.periodEnd,
        publishedAt:
          input.publishedAt.length === 10 ? `${input.publishedAt}T00:00:00.000Z` : input.publishedAt,
        currency: input.currency.trim().toUpperCase() || 'PKR',
        source: 'USER_REPORTED',
        sourceRef: input.sourceRef.trim(),
        sourceUrl: input.sourceUrl?.trim() || null,
        items,
      };
      const i = financials.findIndex(
        (f) => f.symbol === symbol && f.periodType === row.periodType && f.periodEnd === row.periodEnd,
      );
      if (i >= 0) {
        row.id = financials[i].id;
        financials[i] = row;
      } else financials = [...financials, row];
      return structuredClone({ ...row, created: i < 0 });
    },
    importFinancials: async (csv) => {
      await wait();
      const { rows } = readCsv(
        csv,
        ['symbol', 'periodType', 'periodEnd', 'publishedAt', 'sourceRef'],
        ['currency', 'sourceUrl', ...FINANCIAL_ITEM_KEYS],
      );
      const errors: FieldError[] = [];
      for (const r of rows) {
        const sym = (r.v.symbol ?? '').toUpperCase();
        if (!SYMBOL_RE.test(sym)) errors.push({ path: `rows.${r.line}.symbol`, message: 'invalid symbol' });
        else if (!DEMO_SYMBOLS.has(sym))
          errors.push({ path: `rows.${r.line}.symbol`, message: `unknown symbol ${sym}` });
        if (!(FINANCIAL_PERIOD_TYPES as readonly string[]).includes((r.v.periodType ?? '').toUpperCase()))
          errors.push({ path: `rows.${r.line}.periodType`, message: 'must be QUARTERLY or ANNUAL' });
        if (!r.v.periodEnd || !isIsoDate(r.v.periodEnd))
          errors.push({ path: `rows.${r.line}.periodEnd`, message: 'must be a calendar date YYYY-MM-DD' });
        if (!r.v.publishedAt || !whenOk(r.v.publishedAt))
          errors.push({
            path: `rows.${r.line}.publishedAt`,
            message: 'must be YYYY-MM-DD or an ISO timestamp with timezone',
          });
        if (!FINANCIAL_ITEM_KEYS.some((k) => r.v[k]))
          errors.push({ path: `rows.${r.line}.revenue`, message: 'provide at least one financial item' });
      }
      if (errors.length)
        throw new ApiError('VALIDATION_FAILED', 422, 'Validation failed', undefined, { errors });
      let inserted = 0;
      let updated = 0;
      for (const r of rows) {
        const items: FinancialPeriod['items'] = {};
        for (const k of FINANCIAL_ITEM_KEYS) if (r.v[k]) items[k] = r.v[k];
        const row: FinancialPeriod = {
          id: id('fin'),
          symbol: r.v.symbol.toUpperCase(),
          periodType: r.v.periodType.toUpperCase() as FinancialPeriod['periodType'],
          periodEnd: r.v.periodEnd,
          publishedAt: r.v.publishedAt.length === 10 ? `${r.v.publishedAt}T00:00:00.000Z` : r.v.publishedAt,
          currency: (r.v.currency ?? 'PKR').toUpperCase(),
          source: 'USER_REPORTED',
          sourceRef: r.v.sourceRef,
          sourceUrl: r.v.sourceUrl ?? null,
          items,
        };
        const i = financials.findIndex(
          (f) => f.symbol === row.symbol && f.periodType === row.periodType && f.periodEnd === row.periodEnd,
        );
        if (i >= 0) {
          row.id = financials[i].id;
          financials[i] = row;
          updated++;
        } else {
          financials = [...financials, row];
          inserted++;
        }
      }
      return {
        rows: rows.length,
        inserted,
        updated,
        unchanged: rows.length - inserted - updated,
        symbols: [...new Set(rows.map((r) => r.v.symbol.toUpperCase()))],
        source: 'USER_REPORTED',
      };
    },
    macro: async (q = {}) => {
      await wait();
      const data = macro
        .filter((m) => !q.series || m.series === q.series)
        .sort((a, b) => b.date.localeCompare(a.date));
      return structuredClone({
        data,
        note:
          data.length === 0
            ? 'No macro observations on file. Nothing is estimated.'
            : 'Owner-entered (USER_REPORTED).',
      });
    },
    addMacro: async (input) => {
      await wait();
      if (!(MACRO_SERIES as readonly string[]).includes(input.series))
        throw fieldFail('series', 'unknown series');
      if (!isIsoDate(input.date)) throw fieldFail('date', 'must be a calendar date YYYY-MM-DD');
      try {
        Dec.of(input.value);
      } catch {
        throw fieldFail('value', 'must be a decimal number');
      }
      if (input.sourceRef.trim().length < 3) throw fieldFail('sourceRef', 'cite where the figure comes from');
      const row: MacroObservation = {
        id: id('macro'),
        series: input.series,
        date: input.date,
        value: input.value.trim(),
        source: 'USER_REPORTED',
        sourceRef: input.sourceRef.trim(),
      };
      const i = macro.findIndex(
        (m) => m.series === row.series && m.date === row.date && m.source === 'USER_REPORTED',
      );
      if (i >= 0) macro[i] = { ...row, id: macro[i].id };
      else macro.push(row);
      return structuredClone(row);
    },
    providers: async () => {
      await wait();
      return structuredClone([
        manual('manual-fundamentals', 'Owner-entered fundamentals', 'FUNDAMENTALS'),
        mkProvider({
          providerKey: 'capitalstake-fundamentals',
          displayName: 'Capital Stake fundamentals',
          dataType: 'FUNDAMENTALS',
          source: 'PROVIDER',
          licenseNote: 'Paid licence from Capital Stake; terms not yet obtained.',
          missing: [
            'Capital Stake data licence (paid subscription)',
            'API key entered by the owner in Settings',
          ],
        }),
        manual('manual-announcements', 'Owner-entered announcements', 'ANNOUNCEMENTS'),
        mkProvider({
          providerKey: 'psx-announcements',
          displayName: 'PSX announcements',
          dataType: 'ANNOUNCEMENTS',
          source: 'PROVIDER',
          licenseNote:
            'PSX terms forbid commercial or derived use of portal data without approval. Scraping is prohibited.',
          missing: ['Written PSX approval for the intended use, or a licensed vendor feed'],
        }),
        manual('manual-macro', 'Owner-entered macro data', 'MACRO'),
        mkProvider({
          providerKey: 'sbp-easydata',
          displayName: 'SBP EasyData',
          dataType: 'MACRO',
          source: 'PROVIDER',
          licenseNote: 'Official State Bank of Pakistan datasets; the API needs a free account key.',
          missing: ['Free SBP EasyData account (USER_ACTION_REQUIRED)', 'API key issued to that account'],
        }),
      ]);
    },
  };

  const recommendations: ApiClient['recommendations'] = {
    list: async (q = {}) => {
      await wait();
      const rows = recs
        .filter((r) => !q.action || r.action === q.action)
        .filter((r) => !q.horizon || r.horizon === q.horizon)
        .filter((r) => !q.status || r.status === q.status)
        .filter((r) => !q.symbol || r.symbol === q.symbol.trim().toUpperCase())
        .filter((r) => !q.from || r.generatedAt.slice(0, 10) >= q.from)
        .filter((r) => !q.to || r.generatedAt.slice(0, 10) <= q.to);
      const offset = q.offset ?? 0;
      return structuredClone({ total: rows.length, data: rows.slice(offset, offset + (q.limit ?? 25)) });
    },
    get: async (rid) => {
      await wait();
      const r = recs.find((x) => x.id === rid);
      if (!r) throw new ApiError('NOT_FOUND', 404, 'Not Found', 'Recommendation not found');
      return structuredClone({ ...r, outcomes: [] });
    },
    performance: async (q = {}) => {
      await wait();
      return {
        ...emptyStats(),
        scope: { onlyActionable: true, includesSimulated: !!q.includeSimulated },
        perHorizon: Object.fromEntries(RECOMMENDATION_HORIZONS.map((h) => [h, emptyStats()])) as Record<
          (typeof RECOMMENDATION_HORIZONS)[number],
          PerformanceStats
        >,
        benchmark: null,
        benchmarkNote:
          'No KSE-100 series (macro series KSE100_INDEX) covers these recommendations, so no benchmark comparison is shown.',
        note: 'Past recommendation outcomes are not a prediction or a guarantee of future returns.',
      };
    },
    evaluateOutcomes: async () => {
      await wait();
      return { considered: 0, appended: 0, closed: 0, noNewData: 0, evaluatedAt: iso() };
    },
  };

  return { research, recommendations };
}
