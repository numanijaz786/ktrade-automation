import { z } from 'zod';
import {
  ANNOUNCEMENT_CATEGORIES,
  DECIMAL_STRING_RE,
  decimalString,
  FINANCIAL_PERIOD_TYPES,
  MACRO_SERIES,
  SENTIMENT_LABELS,
} from '@ktrade/shared';
import { isIsoDate, pktInstant } from '../market-data/calendar.js';
import { SYMBOL_RE } from '../market-data/decimal-format.js';

// ADR-024: Zod 4 runs refinements even after the regex failed, so every decimal refinement tests the regex first
// and never calls d() on unvalidated text.
const fits = (intDigits: number, dp: number) => {
  const re = new RegExp(`^-?\\d{1,${intDigits}}(\\.\\d{1,${dp}})?$`);
  return (v: string) => !DECIMAL_STRING_RE.test(v) || re.test(v);
};
const notNegative = (v: string) => !DECIMAL_STRING_RE.test(v) || !v.startsWith('-');

/** NUMERIC(24,4) money in full currency units; may be negative (losses, outflows). */
export const moneyItem = decimalString.refine(fits(16, 4), 'at most 4 decimal places');
export const nonNegMoneyItem = moneyItem.refine(notNegative, 'must not be negative');
/** NUMERIC(20,6) per-share figure. */
export const perShareItem = decimalString.refine(fits(14, 6), 'at most 6 decimal places');
export const nonNegPerShareItem = perShareItem.refine(notNegative, 'must not be negative');

export const symbolSchema = z.string().trim().toUpperCase().regex(SYMBOL_RE, 'invalid symbol');
export const isoDateSchema = z.string().trim().refine(isIsoDate, 'must be a calendar date YYYY-MM-DD');

const WHEN_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2}))?$/;
/** A date (YYYY-MM-DD, read as 00:00 PKT) or a full ISO timestamp with offset. */
export const whenSchema = z
  .string()
  .trim()
  .refine(
    (v) =>
      WHEN_RE.test(v) &&
      isIsoDate(v.slice(0, 10)) &&
      !Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)),
    'must be YYYY-MM-DD or an ISO timestamp with timezone',
  );
export function parseWhen(v: string): Date {
  return v.length === 10 ? pktInstant(v, 0) : new Date(v);
}

const httpUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => /^https?:\/\/\S+$/i.test(v), 'must be an http(s) URL');

// ───────────── financials ─────────────

export const FINANCIAL_ITEM_KEYS = [
  'revenue',
  'grossProfit',
  'operatingProfit',
  'netProfit',
  'eps',
  'totalAssets',
  'totalEquity',
  'totalDebt',
  'operatingCashFlow',
  'capex',
  'sharesOutstanding',
  'dividendPerShare',
] as const;
export type FinancialItemKey = (typeof FINANCIAL_ITEM_KEYS)[number];

export const financialInputSchema = z
  .strictObject({
    symbol: symbolSchema,
    periodType: z.enum(FINANCIAL_PERIOD_TYPES),
    periodEnd: isoDateSchema,
    publishedAt: whenSchema,
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'must be a 3-letter currency code')
      .default('PKR'),
    sourceRef: z.string().trim().min(3, 'cite the document and page').max(500),
    sourceUrl: httpUrl.optional(),
    revenue: moneyItem.optional(),
    grossProfit: moneyItem.optional(),
    operatingProfit: moneyItem.optional(),
    netProfit: moneyItem.optional(),
    eps: perShareItem.optional(),
    totalAssets: nonNegMoneyItem.optional(),
    totalEquity: moneyItem.optional(),
    totalDebt: nonNegMoneyItem.optional(),
    operatingCashFlow: moneyItem.optional(),
    capex: moneyItem.optional(),
    sharesOutstanding: nonNegMoneyItem.optional(),
    dividendPerShare: nonNegPerShareItem.optional(),
  })
  .superRefine((v, ctx) => {
    if (!FINANCIAL_ITEM_KEYS.some((k) => v[k] !== undefined))
      ctx.addIssue({ code: 'custom', path: ['revenue'], message: 'provide at least one financial item' });
    if (isIsoDate(v.periodEnd) && whenSchema.safeParse(v.publishedAt).success) {
      const published = parseWhen(v.publishedAt);
      if (published < pktInstant(v.periodEnd, 0))
        ctx.addIssue({ code: 'custom', path: ['publishedAt'], message: 'must not be before periodEnd' });
    }
  });
export type FinancialInput = z.infer<typeof financialInputSchema>;

export const FINANCIAL_CSV_REQUIRED = [
  'symbol',
  'periodType',
  'periodEnd',
  'publishedAt',
  'sourceRef',
] as const;
export const FINANCIAL_CSV_OPTIONAL = ['currency', 'sourceUrl', ...FINANCIAL_ITEM_KEYS] as const;
export const MAX_FINANCIAL_CSV_ROWS = 5_000;

export const csvBodySchema = z.object({
  csv: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024),
});

export const financialsQuerySchema = z.object({
  symbol: symbolSchema,
  periodType: z.enum(FINANCIAL_PERIOD_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(40),
});

// ───────────── announcements ─────────────

export const announcementInputSchema = z.strictObject({
  title: z.string().trim().min(3).max(300),
  summary: z.string().trim().min(1).max(2000).optional(),
  url: httpUrl.optional(),
  category: z.enum(ANNOUNCEMENT_CATEGORIES).default('OTHER'),
  publishedAt: whenSchema,
  symbol: symbolSchema.optional(),
  symbols: z.array(symbolSchema).max(20).default([]),
  sourceName: z.string().trim().min(1).max(120).default('Owner-entered'),
  sentiment: z.enum(SENTIMENT_LABELS).optional(),
  relevance: z.number().int().min(0).max(100).optional(),
});
export type AnnouncementInput = z.infer<typeof announcementInputSchema>;

export const ANNOUNCEMENT_CSV_REQUIRED = ['publishedAt', 'title'] as const;
export const ANNOUNCEMENT_CSV_OPTIONAL = [
  'category',
  'symbol',
  'symbols',
  'url',
  'summary',
  'sourceName',
  'sentiment',
  'relevance',
] as const;
export const MAX_ANNOUNCEMENT_CSV_ROWS = 5_000;

/** CSV cells are all text: `symbols` is `;`-separated, `relevance` a whole number. */
export function announcementFromCsv(values: Record<string, string>): unknown {
  const { symbols, relevance, category, sentiment, symbol, ...rest } = values;
  return {
    ...rest,
    ...(symbol ? { symbol } : {}),
    ...(category ? { category: category.toUpperCase() } : {}),
    ...(sentiment ? { sentiment: sentiment.toUpperCase() } : {}),
    ...(symbols
      ? {
          symbols: symbols
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
    ...(relevance !== undefined
      ? { relevance: /^\d{1,3}$/.test(relevance) ? Number(relevance) : relevance }
      : {}),
  };
}

export const announcementsQuerySchema = z.object({
  symbol: symbolSchema.optional(),
  since: whenSchema.optional(),
  category: z.enum(ANNOUNCEMENT_CATEGORIES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const DEFAULT_NEWS_WINDOW_HOURS = 72;
export const newsFeedQuerySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(720).default(DEFAULT_NEWS_WINDOW_HOURS),
  symbol: symbolSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ───────────── macro ─────────────

export const macroInputSchema = z
  .strictObject({
    series: z.enum(MACRO_SERIES),
    date: isoDateSchema,
    value: perShareItem,
    sourceRef: z.string().trim().min(3, 'cite where the figure comes from').max(500),
  })
  .superRefine((v, ctx) => {
    // Levels (FX, index) are strictly positive; rates (policy, CPI, KIBOR) may legitimately be zero or negative.
    if ((v.series === 'USD_PKR' || v.series === 'KSE100_INDEX') && DECIMAL_STRING_RE.test(v.value)) {
      if (v.value.startsWith('-') || !/[1-9]/.test(v.value))
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'must be greater than zero for this series',
        });
    }
  });
export type MacroInput = z.infer<typeof macroInputSchema>;

export const macroQuerySchema = z.object({
  series: z.enum(MACRO_SERIES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
