/**
 * Fundamental ratios computed ONLY from supplied inputs (docs/10 §3 "no data, no claim").
 * A ratio is either `OK` (value + formula + every input with provenance) or `UNAVAILABLE` (the missing input
 * names and the reason). Nothing is ever estimated: missing inputs, zero/negative denominators, incompatible
 * currencies or periods, statements older than the staleness limit, and statements published after the
 * decision date all refuse. Annualising a quarterly figure is explicit (`annualiseQuarterly`) and flagged.
 */
import { d, type Decimal, fromInt, HUNDRED, ONE, sum } from '../decimal.js';
import { type ResearchDataSource } from './types.js';
import { daysBetween, fmt, parseTs, tryParseTs } from './util.js';

export type StatementPeriodType = 'ANNUAL' | 'QUARTERLY' | 'TTM';

export interface FinancialStatement {
  /** Label, e.g. "FY2025" or "2025-Q3". */
  readonly period: string;
  readonly periodType: StatementPeriodType;
  /** ISO date the period ended (YYYY-MM-DD). */
  readonly periodEnd: string;
  /** ISO date/timestamp the figures were published. */
  readonly publishedAt: string;
  /** ISO 4217, e.g. "PKR". */
  readonly currency: string;
  readonly source: ResearchDataSource;
  /** Document / page citation for USER_REPORTED figures. */
  readonly document?: string | null;
  readonly revenue?: Decimal | null;
  readonly grossProfit?: Decimal | null;
  readonly operatingIncome?: Decimal | null;
  readonly netIncome?: Decimal | null;
  /** Period EPS as reported (for a quarter: that quarter's EPS). */
  readonly eps?: Decimal | null;
  readonly totalAssets?: Decimal | null;
  readonly totalEquity?: Decimal | null;
  readonly totalDebt?: Decimal | null;
  readonly operatingCashFlow?: Decimal | null;
  /** Capital expenditure as a POSITIVE outflow. */
  readonly capitalExpenditure?: Decimal | null;
  readonly dividendsPerShare?: Decimal | null;
  readonly sharesOutstanding?: Decimal | null;
}

export interface PriceInput {
  readonly value: Decimal;
  readonly currency: string;
  readonly source: ResearchDataSource;
  readonly asOf: string;
}

export interface DividendRecord {
  /** Ex-dividend date (ISO). */
  readonly exDate: string;
  readonly amountPerShare: Decimal;
  readonly currency: string;
  readonly source: ResearchDataSource;
}

export interface FundamentalsContext {
  /** Decision date/time (ISO). Supplied by the caller; this module never reads a clock. */
  readonly asOf: string;
  /** Statements published more than this many days before `asOf` are refused. */
  readonly maxAgeDays: number;
  /** Quarterly flows may be multiplied by 4 only when this is true (flagged in the result). Default false. */
  readonly annualiseQuarterly?: boolean;
  /** Price older than this many days (vs asOf) is refused for price ratios. Default 7. */
  readonly maxPriceAgeDays?: number;
}

export interface RatioInputRef {
  readonly name: string;
  readonly value: Decimal;
  readonly period: string;
  readonly publishedAt: string;
  readonly currency: string;
  readonly source: ResearchDataSource;
}

export type RatioUnit = 'PERCENT' | 'RATIO' | 'CURRENCY';
export interface RatioOk {
  readonly status: 'OK';
  readonly value: Decimal;
  readonly unit: RatioUnit;
  readonly formula: string;
  readonly inputs: readonly RatioInputRef[];
  /** e.g. ANNUALISED_FROM_QUARTERLY. */
  readonly flags: readonly string[];
}
export interface RatioUnavailable {
  readonly status: 'UNAVAILABLE';
  readonly missing: readonly string[];
  readonly reason: string;
}
export type RatioResult = RatioOk | RatioUnavailable;

const unavailable = (missing: readonly string[], reason: string): RatioUnavailable => ({
  status: 'UNAVAILABLE',
  missing,
  reason,
});

type Field = Exclude<
  keyof FinancialStatement,
  'period' | 'periodType' | 'periodEnd' | 'publishedAt' | 'currency' | 'source' | 'document'
>;

const ref = (st: FinancialStatement, name: string, value: Decimal): RatioInputRef => ({
  name,
  value,
  period: st.period,
  publishedAt: st.publishedAt,
  currency: st.currency,
  source: st.source,
});

/** Freshness + look-ahead check for a statement. Returns a refusal reason or null. */
export function statementProblem(st: FinancialStatement, ctx: FundamentalsContext): string | null {
  const pub = tryParseTs(st.publishedAt);
  const asOf = tryParseTs(ctx.asOf);
  if (pub === null) return `${st.period}: publishedAt is not a valid date`;
  if (asOf === null) return 'asOf is not a valid date';
  if (tryParseTs(st.periodEnd) === null) return `${st.period}: periodEnd is not a valid date`;
  if (pub > asOf) return `${st.period}: published after the decision date (${st.publishedAt} > ${ctx.asOf})`;
  const age = daysBetween(st.publishedAt, ctx.asOf);
  if (age.gt(ctx.maxAgeDays)) {
    return `${st.period}: stale, published ${fmt(age, 0)} days ago (limit ${ctx.maxAgeDays})`;
  }
  return null;
}

/** Reads required fields; returns the values or the missing names. */
function need(
  st: FinancialStatement,
  fields: readonly Field[],
): { ok: true; v: Record<string, Decimal> } | { ok: false; missing: string[] } {
  const v: Record<string, Decimal> = {};
  const missing: string[] = [];
  for (const f of fields) {
    const x = st[f];
    if (x === undefined || x === null) missing.push(f);
    else v[f] = x;
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, v };
}

function monthIndex(isoDate: string): number {
  const dt = new Date(parseTs(isoDate));
  return dt.getUTCFullYear() * 12 + dt.getUTCMonth();
}

/** Annualisation factor for a flow, or a refusal. ANNUAL/TTM => 1; QUARTERLY => 4 only when explicitly enabled. */
function annualFactor(
  st: FinancialStatement,
  ctx: FundamentalsContext,
): { factor: Decimal; flags: string[] } | RatioUnavailable {
  if (st.periodType !== 'QUARTERLY') return { factor: ONE, flags: [] };
  if (!ctx.annualiseQuarterly) {
    return unavailable(
      [],
      `${st.period} is a quarterly figure; an annual basis is required and annualiseQuarterly was not enabled`,
    );
  }
  return {
    factor: d('4'),
    flags: [
      `ANNUALISED_FROM_QUARTERLY: ${st.period} x4 (assumes no seasonality; not a reported annual figure)`,
    ],
  };
}

// ───────────────────────────── growth ─────────────────────────────

function growth(
  name: string,
  field: 'revenue' | 'eps',
  current: FinancialStatement | null | undefined,
  comparison: FinancialStatement | null | undefined,
  kind: 'YOY' | 'QOQ',
  ctx: FundamentalsContext,
): RatioResult {
  const label = `${name}${kind === 'YOY' ? 'YoY' : 'QoQ'}`;
  if (!current || !comparison) {
    return unavailable(
      [!current ? 'current statement' : '', !comparison ? 'comparison statement' : ''].filter(Boolean),
      `${label}: statements missing`,
    );
  }
  const problem = statementProblem(current, ctx);
  if (problem) return unavailable([], `${label}: ${problem}`);
  const pub = tryParseTs(comparison.publishedAt);
  if (pub === null || pub > parseTs(ctx.asOf)) {
    return unavailable(
      [],
      `${label}: comparison ${comparison.period} publishedAt invalid or after the decision date`,
    );
  }
  if (current.currency !== comparison.currency) {
    return unavailable([], `${label}: incompatible currencies ${current.currency} vs ${comparison.currency}`);
  }
  if (current.periodType !== comparison.periodType) {
    return unavailable(
      [],
      `${label}: incompatible period types ${current.periodType} vs ${comparison.periodType}`,
    );
  }
  const gap = monthIndex(current.periodEnd) - monthIndex(comparison.periodEnd);
  const expected = kind === 'YOY' ? 12 : 3;
  if (gap !== expected || (kind === 'QOQ' && current.periodType !== 'QUARTERLY')) {
    return unavailable(
      [],
      `${label}: periods ${comparison.period} -> ${current.period} are ${gap} months apart; expected ${expected}${kind === 'QOQ' ? ' (quarterly statements)' : ''}`,
    );
  }
  const a = need(current, [field]);
  const b = need(comparison, [field]);
  if (!a.ok || !b.ok) {
    return unavailable(
      [
        ...(a.ok ? [] : a.missing.map((m) => `${m}@${current.period}`)),
        ...(b.ok ? [] : b.missing.map((m) => `${m}@${comparison.period}`)),
      ],
      `${label}: input missing`,
    );
  }
  const now = a.v[field] as Decimal;
  const before = b.v[field] as Decimal;
  if (!before.gt(0)) {
    return unavailable(
      [],
      `${label}: comparison ${field} is ${before.toString()} (must be > 0; growth is not meaningful)`,
    );
  }
  return {
    status: 'OK',
    value: now.minus(before).div(before).times(HUNDRED),
    unit: 'PERCENT',
    formula: `(${field}[${current.period}] - ${field}[${comparison.period}]) / ${field}[${comparison.period}] x 100`,
    inputs: [ref(current, field, now), ref(comparison, field, before)],
    flags: [],
  };
}

export const revenueGrowthYoY = (
  c: FinancialStatement | null | undefined,
  prior: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult => growth('revenueGrowth', 'revenue', c, prior, 'YOY', ctx);
export const revenueGrowthQoQ = (
  c: FinancialStatement | null | undefined,
  prior: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult => growth('revenueGrowth', 'revenue', c, prior, 'QOQ', ctx);
export const epsGrowthYoY = (
  c: FinancialStatement | null | undefined,
  prior: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult => growth('epsGrowth', 'eps', c, prior, 'YOY', ctx);

// ───────────────────────────── single-statement ratios ─────────────────────────────

function simple(
  st: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
  label: string,
  fields: readonly Field[],
  compute: (v: Record<string, Decimal>) => { value: Decimal | null; why?: string },
  meta: { unit: RatioUnit; formula: string },
): RatioResult {
  if (!st) return unavailable(['statement'], `${label}: no statement supplied`);
  const problem = statementProblem(st, ctx);
  if (problem) return unavailable([], `${label}: ${problem}`);
  const got = need(st, fields);
  if (!got.ok) return unavailable(got.missing, `${label}: missing input ${got.missing.join(', ')}`);
  const r = compute(got.v);
  if (r.value === null) return unavailable([], `${label}: ${r.why ?? 'not computable'}`);
  return {
    status: 'OK',
    value: r.value,
    unit: meta.unit,
    formula: meta.formula,
    inputs: fields.map((f) => ref(st, f, got.v[f] as Decimal)),
    flags: st.periodType === 'QUARTERLY' ? [`PERIOD_VALUE: ${st.period} is a quarterly period`] : [],
  };
}

const margin = (
  label: string,
  num: Field,
  st: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult =>
  simple(
    st,
    ctx,
    label,
    [num, 'revenue'],
    (v) =>
      (v['revenue'] as Decimal).isZero()
        ? { value: null, why: 'revenue is zero' }
        : { value: (v[num] as Decimal).div(v['revenue'] as Decimal).times(HUNDRED) },
    { unit: 'PERCENT', formula: `${num} / revenue x 100` },
  );

export const grossMargin = (
  st: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult => margin('grossMargin', 'grossProfit', st, ctx);
export const operatingMargin = (
  st: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult => margin('operatingMargin', 'operatingIncome', st, ctx);
export const netMargin = (st: FinancialStatement | null | undefined, ctx: FundamentalsContext): RatioResult =>
  margin('netMargin', 'netIncome', st, ctx);

/** Reported EPS for the statement period (no annualisation; quarterly EPS is flagged as a period value). */
export const reportedEps = (
  st: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult =>
  simple(st, ctx, 'eps', ['eps'], (v) => ({ value: v['eps'] as Decimal }), {
    unit: 'CURRENCY',
    formula: 'reported EPS',
  });

/** Annual EPS: reported for ANNUAL/TTM; x4 for QUARTERLY only when annualiseQuarterly. */
export function annualEps(st: FinancialStatement | null | undefined, ctx: FundamentalsContext): RatioResult {
  const base = reportedEps(st, ctx);
  if (base.status === 'UNAVAILABLE' || !st) return base;
  const f = annualFactor(st, ctx);
  if ('status' in f) return unavailable(['annual EPS basis'], `annualEps: ${f.reason}`);
  return {
    ...base,
    value: base.value.times(f.factor),
    formula: f.factor.eq(1) ? 'reported annual/TTM EPS' : 'quarterly EPS x 4',
    flags: f.flags,
  };
}

export function peRatio(
  st: FinancialStatement | null | undefined,
  price: PriceInput | null | undefined,
  ctx: FundamentalsContext,
): RatioResult {
  const eps = annualEps(st, ctx);
  if (eps.status === 'UNAVAILABLE') return unavailable(eps.missing, `pe: ${eps.reason}`);
  const pp = priceProblem(st as FinancialStatement, price, ctx, 'pe');
  if (pp) return pp;
  const p = price as PriceInput;
  if (!eps.value.gt(0)) {
    return unavailable(
      [],
      `pe: annual EPS is ${eps.value.toString()}; P/E is not meaningful for non-positive earnings`,
    );
  }
  return {
    status: 'OK',
    value: p.value.div(eps.value),
    unit: 'RATIO',
    formula: 'price / annual EPS',
    inputs: [
      {
        name: 'price',
        value: p.value,
        period: p.asOf,
        publishedAt: p.asOf,
        currency: p.currency,
        source: p.source,
      },
      ...eps.inputs,
    ],
    flags: eps.flags,
  };
}

function priceProblem(
  st: FinancialStatement,
  price: PriceInput | null | undefined,
  ctx: FundamentalsContext,
  label: string,
): RatioUnavailable | null {
  if (!price) return unavailable(['price'], `${label}: no price supplied`);
  if (!price.value.gt(0)) return unavailable([], `${label}: price must be > 0`);
  if (price.currency !== st.currency) {
    return unavailable(
      [],
      `${label}: incompatible currencies price ${price.currency} vs statement ${st.currency}`,
    );
  }
  const pAsOf = tryParseTs(price.asOf);
  if (pAsOf === null || pAsOf > parseTs(ctx.asOf))
    return unavailable([], `${label}: price asOf invalid or after the decision date`);
  const age = daysBetween(price.asOf, ctx.asOf);
  if (age.gt(ctx.maxPriceAgeDays ?? 7)) {
    return unavailable([], `${label}: price is ${fmt(age, 0)} days old (limit ${ctx.maxPriceAgeDays ?? 7})`);
  }
  return null;
}

export function pbRatio(
  st: FinancialStatement | null | undefined,
  price: PriceInput | null | undefined,
  ctx: FundamentalsContext,
): RatioResult {
  const bv = simple(
    st,
    ctx,
    'pb',
    ['totalEquity', 'sharesOutstanding'],
    (v) =>
      !(v['totalEquity'] as Decimal).gt(0)
        ? { value: null, why: 'total equity is not positive' }
        : !(v['sharesOutstanding'] as Decimal).gt(0)
          ? { value: null, why: 'shares outstanding is not positive' }
          : { value: (v['totalEquity'] as Decimal).div(v['sharesOutstanding'] as Decimal) },
    { unit: 'CURRENCY', formula: 'book value per share = totalEquity / sharesOutstanding' },
  );
  if (bv.status === 'UNAVAILABLE' || !st) return bv;
  const pp = priceProblem(st, price, ctx, 'pb');
  if (pp) return pp;
  const p = price as PriceInput;
  return {
    status: 'OK',
    value: p.value.div(bv.value),
    unit: 'RATIO',
    formula: 'price / (totalEquity / sharesOutstanding)',
    inputs: [
      {
        name: 'price',
        value: p.value,
        period: p.asOf,
        publishedAt: p.asOf,
        currency: p.currency,
        source: p.source,
      },
      ...bv.inputs,
    ],
    flags: bv.flags,
  };
}

function returnOn(
  label: string,
  denom: 'totalEquity' | 'totalAssets',
  st: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult {
  if (!st) return unavailable(['statement'], `${label}: no statement supplied`);
  const f = annualFactor(st, ctx);
  if ('status' in f) return unavailable([], `${label}: ${f.reason}`);
  const r = simple(
    st,
    ctx,
    label,
    ['netIncome', denom],
    (v) =>
      !(v[denom] as Decimal).gt(0)
        ? { value: null, why: `${denom} is not positive` }
        : {
            value: (v['netIncome'] as Decimal)
              .times(f.factor)
              .div(v[denom] as Decimal)
              .times(HUNDRED),
          },
    {
      unit: 'PERCENT',
      formula: `annual netIncome / period-end ${denom} x 100 (period-end, not average, balance)`,
    },
  );
  return r.status === 'OK' ? { ...r, flags: f.flags } : r;
}

export const roe = (st: FinancialStatement | null | undefined, ctx: FundamentalsContext): RatioResult =>
  returnOn('roe', 'totalEquity', st, ctx);
export const roa = (st: FinancialStatement | null | undefined, ctx: FundamentalsContext): RatioResult =>
  returnOn('roa', 'totalAssets', st, ctx);

export const debtToEquity = (
  st: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult =>
  simple(
    st,
    ctx,
    'debtToEquity',
    ['totalDebt', 'totalEquity'],
    (v) =>
      !(v['totalEquity'] as Decimal).gt(0)
        ? { value: null, why: 'total equity is not positive' }
        : { value: (v['totalDebt'] as Decimal).div(v['totalEquity'] as Decimal) },
    { unit: 'RATIO', formula: 'totalDebt / totalEquity' },
  );

export const operatingCashFlowValue = (
  st: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult =>
  simple(
    st,
    ctx,
    'operatingCashFlow',
    ['operatingCashFlow'],
    (v) => ({ value: v['operatingCashFlow'] as Decimal }),
    {
      unit: 'CURRENCY',
      formula: 'reported operating cash flow',
    },
  );

export const freeCashFlow = (
  st: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult =>
  simple(
    st,
    ctx,
    'freeCashFlow',
    ['operatingCashFlow', 'capitalExpenditure'],
    (v) => ({ value: (v['operatingCashFlow'] as Decimal).minus((v['capitalExpenditure'] as Decimal).abs()) }),
    { unit: 'CURRENCY', formula: 'operatingCashFlow - capitalExpenditure' },
  );

export const payoutRatio = (
  st: FinancialStatement | null | undefined,
  ctx: FundamentalsContext,
): RatioResult =>
  simple(
    st,
    ctx,
    'payoutRatio',
    ['dividendsPerShare', 'eps'],
    (v) =>
      !(v['eps'] as Decimal).gt(0)
        ? { value: null, why: 'EPS is not positive; payout ratio not meaningful' }
        : (v['dividendsPerShare'] as Decimal).isNeg()
          ? { value: null, why: 'dividendsPerShare is negative' }
          : { value: (v['dividendsPerShare'] as Decimal).div(v['eps'] as Decimal).times(HUNDRED) },
    { unit: 'PERCENT', formula: 'dividendsPerShare / eps x 100 (same period)' },
  );

/** Trailing-12-month dividends per share: sum of records with exDate in (asOf - 365d, asOf]. */
export function trailingDividendPerShare(
  history: readonly DividendRecord[] | null | undefined,
  currency: string,
  ctx: FundamentalsContext,
): { dps: Decimal; count: number } | RatioUnavailable {
  if (!history) return unavailable(['dividend history'], 'dividend history not supplied');
  const asOf = parseTs(ctx.asOf);
  const inWindow = history.filter((r) => {
    const ex = tryParseTs(r.exDate);
    return ex !== null && ex <= asOf && daysBetween(r.exDate, ctx.asOf).lt(365);
  });
  const bad = inWindow.find((r) => r.currency !== currency);
  if (bad) return unavailable([], `dividend currency ${bad.currency} differs from ${currency}`);
  return { dps: sum(inWindow.map((r) => r.amountPerShare)), count: inWindow.length };
}

export function dividendYield(
  history: readonly DividendRecord[] | null | undefined,
  price: PriceInput | null | undefined,
  ctx: FundamentalsContext,
): RatioResult {
  if (!price) return unavailable(['price'], 'dividendYield: no price supplied');
  if (!price.value.gt(0)) return unavailable([], 'dividendYield: price must be > 0');
  const t = trailingDividendPerShare(history, price.currency, ctx);
  if ('status' in t) return unavailable(t.missing, `dividendYield: ${t.reason}`);
  return {
    status: 'OK',
    value: t.dps.div(price.value).times(HUNDRED),
    unit: 'PERCENT',
    formula: 'trailing-12-month dividends per share / price x 100',
    inputs: [
      {
        name: 'price',
        value: price.value,
        period: price.asOf,
        publishedAt: price.asOf,
        currency: price.currency,
        source: price.source,
      },
      ...(history ?? []).map((r) => ({
        name: 'dividendPerShare',
        value: r.amountPerShare,
        period: r.exDate,
        publishedAt: r.exDate,
        currency: r.currency,
        source: r.source,
      })),
    ],
    flags: t.count === 0 ? ['NO_DIVIDENDS_IN_SUPPLIED_HISTORY'] : [],
  };
}

// ───────────────────────────── aggregate ─────────────────────────────

export const RATIO_KEYS = [
  'revenueGrowthYoY',
  'revenueGrowthQoQ',
  'epsGrowthYoY',
  'grossMargin',
  'operatingMargin',
  'netMargin',
  'eps',
  'pe',
  'pb',
  'roe',
  'roa',
  'debtToEquity',
  'operatingCashFlow',
  'freeCashFlow',
  'dividendYield',
  'payoutRatio',
] as const;
export type RatioKey = (typeof RATIO_KEYS)[number];

export interface FundamentalsInput {
  /** Latest statement. */
  readonly current: FinancialStatement;
  /** Statement for the same period one year earlier (YoY growth). */
  readonly priorYear?: FinancialStatement | null;
  /** Immediately preceding quarter (QoQ growth). */
  readonly priorQuarter?: FinancialStatement | null;
  readonly price?: PriceInput | null;
  readonly dividendHistory?: readonly DividendRecord[] | null;
}

export interface FundamentalsReport {
  readonly ratios: Readonly<Record<RatioKey, RatioResult>>;
  readonly available: readonly RatioKey[];
  readonly unavailable: readonly { key: RatioKey; missing: readonly string[]; reason: string }[];
  /** available / total, 0..1. */
  readonly coverage: Decimal;
  readonly statement: { period: string; publishedAt: string; currency: string; source: ResearchDataSource };
}

export function computeFundamentalRatios(
  input: FundamentalsInput,
  ctx: FundamentalsContext,
): FundamentalsReport {
  const c = input.current;
  const ratios: Record<RatioKey, RatioResult> = {
    revenueGrowthYoY: revenueGrowthYoY(c, input.priorYear, ctx),
    revenueGrowthQoQ: revenueGrowthQoQ(c, input.priorQuarter, ctx),
    epsGrowthYoY: epsGrowthYoY(c, input.priorYear, ctx),
    grossMargin: grossMargin(c, ctx),
    operatingMargin: operatingMargin(c, ctx),
    netMargin: netMargin(c, ctx),
    eps: reportedEps(c, ctx),
    pe: peRatio(c, input.price, ctx),
    pb: pbRatio(c, input.price, ctx),
    roe: roe(c, ctx),
    roa: roa(c, ctx),
    debtToEquity: debtToEquity(c, ctx),
    operatingCashFlow: operatingCashFlowValue(c, ctx),
    freeCashFlow: freeCashFlow(c, ctx),
    dividendYield: dividendYield(input.dividendHistory, input.price, ctx),
    payoutRatio: payoutRatio(c, ctx),
  };
  const available = RATIO_KEYS.filter((k) => ratios[k].status === 'OK');
  const unavail = RATIO_KEYS.flatMap((k) => {
    const r = ratios[k];
    return r.status === 'UNAVAILABLE' ? [{ key: k, missing: r.missing, reason: r.reason }] : [];
  });
  return {
    ratios,
    available,
    unavailable: unavail,
    coverage: fromInt(available.length).div(RATIO_KEYS.length),
    statement: { period: c.period, publishedAt: c.publishedAt, currency: c.currency, source: c.source },
  };
}

/** Convenience: the numeric value of an OK ratio, else null. */
export function ratioValue(report: FundamentalsReport, key: RatioKey): Decimal | null {
  const r = report.ratios[key];
  return r.status === 'OK' ? r.value : null;
}
