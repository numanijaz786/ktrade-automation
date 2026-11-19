/**
 * Form validation for owner-entered research data. It mirrors the API's rules (apps/api/src/research-data/
 * research-data.schemas.ts) so mistakes are caught before sending; the API stays the authority and its errors
 * are shown as-is. Numbers stay decimal STRINGS: nothing here converts to a float.
 */
import {
  ANNOUNCEMENT_CATEGORIES,
  MACRO_SERIES,
  FINANCIAL_PERIOD_TYPES,
  SENTIMENT_LABELS,
} from '@ktrade/shared';
import { isIsoDate, SYMBOL_RE } from './dividends-rules';
import {
  FINANCIAL_ITEM_KEYS,
  type AnnouncementInput,
  type FinancialInput,
  type FinancialItemKey,
  type FinancialPeriod,
  type MacroInput,
} from './types';

export type FormErrors<T> = Partial<Record<keyof T, string>>;
export type Validated<I, V> = { ok: true; input: I } | { ok: false; errors: FormErrors<V> };

const HTTP_URL = /^https?:\/\/\S+$/i;
const MONEY = /^-?\d{1,16}(\.\d{1,4})?$/;
const PER_SHARE = /^-?\d{1,14}(\.\d{1,6})?$/;
const isNeg = (v: string) => v.startsWith('-');
const hasDigit = (v: string) => /[1-9]/.test(v);

/** Pakistan time is a fixed UTC+5 offset (no daylight saving). */
const PKT_OFFSET = '+05:00';

// ─── announcements ─────────────────────────────────────────────────────────

export interface AnnouncementFormValues {
  title: string;
  category: string;
  date: string;
  /** HH:MM in Pakistan time, optional. */
  time: string;
  symbols: string;
  url: string;
  summary: string;
  sourceName: string;
  sentiment: string;
}

export const EMPTY_ANNOUNCEMENT: AnnouncementFormValues = {
  title: '',
  category: 'OTHER',
  date: '',
  time: '',
  symbols: '',
  url: '',
  summary: '',
  sourceName: '',
  sentiment: '',
};

export function validateAnnouncementForm(
  v: AnnouncementFormValues,
  nowMs: number,
): Validated<AnnouncementInput, AnnouncementFormValues> {
  const errors: FormErrors<AnnouncementFormValues> = {};
  const title = v.title.trim();
  if (title.length < 3) errors.title = 'Enter the headline (at least 3 characters).';
  else if (title.length > 300) errors.title = 'Keep the headline under 300 characters.';
  if (!(ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(v.category))
    errors.category = 'Pick a category.';
  let publishedAt = '';
  if (!isIsoDate(v.date)) errors.date = 'Enter the publication date.';
  else if (v.time.trim() && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time.trim()))
    errors.time = 'Use 24-hour time, like 14:30.';
  else {
    publishedAt = v.time.trim() ? `${v.date}T${v.time.trim()}:00${PKT_OFFSET}` : v.date;
    const at = Date.parse(v.time.trim() ? publishedAt : `${v.date}T00:00:00${PKT_OFFSET}`);
    if (at > nowMs) errors.date = 'The publication time cannot be in the future.';
  }
  const symbols = v.symbols
    .split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.some((s) => !SYMBOL_RE.test(s)))
    errors.symbols = 'Use stock symbols separated by commas, like OGDC, PPL.';
  else if (symbols.length > 20) errors.symbols = 'At most 20 symbols.';
  if (v.url.trim() && !HTTP_URL.test(v.url.trim()))
    errors.url = 'The link must start with http:// or https://.';
  if (v.summary.trim().length > 2000) errors.summary = 'Keep the summary under 2000 characters.';
  if (v.sentiment && !(SENTIMENT_LABELS as readonly string[]).includes(v.sentiment))
    errors.sentiment = 'Pick positive, negative or neutral, or leave it blank.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      title,
      category: v.category as AnnouncementInput['category'],
      publishedAt,
      symbols: [...new Set(symbols)],
      ...(v.url.trim() ? { url: v.url.trim() } : {}),
      ...(v.summary.trim() ? { summary: v.summary.trim() } : {}),
      ...(v.sourceName.trim() ? { sourceName: v.sourceName.trim() } : {}),
      ...(v.sentiment ? { sentiment: v.sentiment as AnnouncementInput['sentiment'] } : {}),
    },
  };
}

// ─── financials ────────────────────────────────────────────────────────────

export const FINANCIAL_ITEM_LABELS: Record<FinancialItemKey, string> = {
  revenue: 'Revenue',
  grossProfit: 'Gross profit',
  operatingProfit: 'Operating profit',
  netProfit: 'Net profit',
  eps: 'Earnings per share (EPS)',
  totalAssets: 'Total assets',
  totalEquity: 'Total equity',
  totalDebt: 'Total debt',
  operatingCashFlow: 'Operating cash flow',
  capex: 'Capital spending (capex)',
  sharesOutstanding: 'Shares outstanding',
  dividendPerShare: 'Dividend per share',
};

const PER_SHARE_ITEMS: ReadonlySet<FinancialItemKey> = new Set(['eps', 'dividendPerShare']);
const NON_NEGATIVE_ITEMS: ReadonlySet<FinancialItemKey> = new Set([
  'totalAssets',
  'totalDebt',
  'sharesOutstanding',
  'dividendPerShare',
]);
export const isPerShareItem = (k: FinancialItemKey) => PER_SHARE_ITEMS.has(k);

export interface FinancialFormValues {
  symbol: string;
  periodType: string;
  periodEnd: string;
  publishedAt: string;
  currency: string;
  sourceRef: string;
  sourceUrl: string;
  items: Record<FinancialItemKey, string>;
}

export const emptyItems = (): Record<FinancialItemKey, string> =>
  Object.fromEntries(FINANCIAL_ITEM_KEYS.map((k) => [k, ''])) as Record<FinancialItemKey, string>;

export const EMPTY_FINANCIAL: FinancialFormValues = {
  symbol: '',
  periodType: 'ANNUAL',
  periodEnd: '',
  publishedAt: '',
  currency: 'PKR',
  sourceRef: '',
  sourceUrl: '',
  items: emptyItems(),
};

export const financialFormValues = (p: FinancialPeriod): FinancialFormValues => ({
  symbol: p.symbol,
  periodType: p.periodType,
  periodEnd: p.periodEnd,
  publishedAt: p.publishedAt.slice(0, 10),
  currency: p.currency,
  sourceRef: p.sourceRef,
  sourceUrl: p.sourceUrl ?? '',
  items: { ...emptyItems(), ...p.items },
});

export type FinancialFormErrors = {
  [K in Exclude<keyof FinancialFormValues, 'items'>]?: string;
} & { items?: Partial<Record<FinancialItemKey, string>>; form?: string };

export function validateFinancialForm(
  v: FinancialFormValues,
  nowMs: number,
): { ok: true; input: FinancialInput } | { ok: false; errors: FinancialFormErrors } {
  const errors: FinancialFormErrors = {};
  const symbol = v.symbol.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) errors.symbol = 'Enter a valid stock symbol, like OGDC.';
  if (!(FINANCIAL_PERIOD_TYPES as readonly string[]).includes(v.periodType))
    errors.periodType = 'Pick quarterly or annual.';
  if (!isIsoDate(v.periodEnd)) errors.periodEnd = 'Enter the period end date.';
  if (!isIsoDate(v.publishedAt)) errors.publishedAt = 'Enter the date the report was published.';
  else {
    if (isIsoDate(v.periodEnd) && v.publishedAt < v.periodEnd)
      errors.publishedAt = 'A report cannot be published before its period ends.';
    if (Date.parse(`${v.publishedAt}T00:00:00${PKT_OFFSET}`) > nowMs)
      errors.publishedAt = 'The publication date cannot be in the future.';
  }
  const currency = v.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'Use a 3-letter currency code, like PKR.';
  if (v.sourceRef.trim().length < 3) errors.sourceRef = 'Say which document and page the figures come from.';
  if (v.sourceUrl.trim() && !HTTP_URL.test(v.sourceUrl.trim()))
    errors.sourceUrl = 'The link must start with http:// or https://.';
  const itemErrors: Partial<Record<FinancialItemKey, string>> = {};
  const items: FinancialInput['items'] = {};
  for (const k of FINANCIAL_ITEM_KEYS) {
    const raw = v.items[k].trim();
    if (!raw) continue;
    if (!(isPerShareItem(k) ? PER_SHARE : MONEY).test(raw))
      itemErrors[k] = isPerShareItem(k)
        ? 'Enter a number with at most 6 decimals.'
        : 'Enter a plain number with at most 4 decimals (no commas).';
    else if (NON_NEGATIVE_ITEMS.has(k) && isNeg(raw) && hasDigit(raw))
      itemErrors[k] = 'This cannot be negative.';
    else items[k] = raw;
  }
  if (Object.keys(itemErrors).length) errors.items = itemErrors;
  else if (Object.keys(items).length === 0) errors.form = 'Enter at least one figure.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      symbol,
      periodType: v.periodType as FinancialInput['periodType'],
      periodEnd: v.periodEnd,
      publishedAt: v.publishedAt,
      currency,
      sourceRef: v.sourceRef.trim(),
      ...(v.sourceUrl.trim() ? { sourceUrl: v.sourceUrl.trim() } : {}),
      items,
    },
  };
}

// ─── macro ─────────────────────────────────────────────────────────────────

export interface MacroFormValues {
  series: string;
  date: string;
  value: string;
  sourceRef: string;
}

export const EMPTY_MACRO: MacroFormValues = { series: 'POLICY_RATE', date: '', value: '', sourceRef: '' };

export const MACRO_LABELS: Record<(typeof MACRO_SERIES)[number], string> = {
  POLICY_RATE: 'Policy rate (%)',
  CPI_YOY: 'Inflation, year on year (%)',
  USD_PKR: 'US dollar in rupees (PKR per USD)',
  KIBOR_6M: '6-month KIBOR (%)',
  KSE100_INDEX: 'KSE-100 index level',
};

export function validateMacroForm(
  v: MacroFormValues,
  todayPkt: string,
): Validated<MacroInput, MacroFormValues> {
  const errors: FormErrors<MacroFormValues> = {};
  if (!(MACRO_SERIES as readonly string[]).includes(v.series)) errors.series = 'Pick a series.';
  if (!isIsoDate(v.date)) errors.date = 'Enter the observation date.';
  else if (v.date > todayPkt) errors.date = 'The date cannot be in the future.';
  const value = v.value.trim();
  if (!PER_SHARE.test(value)) errors.value = 'Enter a plain number with at most 6 decimals.';
  else if ((v.series === 'USD_PKR' || v.series === 'KSE100_INDEX') && (isNeg(value) || !hasDigit(value)))
    errors.value = 'This series must be greater than zero.';
  if (v.sourceRef.trim().length < 3) errors.sourceRef = 'Say where the figure comes from.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: { series: v.series as MacroInput['series'], date: v.date, value, sourceRef: v.sourceRef.trim() },
  };
}
