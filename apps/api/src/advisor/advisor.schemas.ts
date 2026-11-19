import { z } from 'zod';
import { HORIZONS } from '@ktrade/finance-core';
import { DECIMAL_STRING_RE, decimalString } from '@ktrade/shared';
import { SYMBOL_RE } from '../market-data/decimal-format.js';

export const horizonSchema = z.enum(HORIZONS);
export const DEFAULT_HORIZON = 'SWING' as const;

/** Per-user risk per trade, % of equity. Conservative default 1; hard ceiling 5 so a typo cannot size a position wildly. */
export const DEFAULT_RISK_PER_TRADE_PCT = '1';
export const MAX_RISK_PER_TRADE_PCT = '5';

// ADR-024: refinements run after failed regex checks in Zod 4, so test the regex before touching the value.
const positive = (v: string) => !DECIMAL_STRING_RE.test(v) || (!v.startsWith('-') && /[1-9]/.test(v));
const atMost = (max: number) => (v: string) => !DECIMAL_STRING_RE.test(v) || Number(v) <= max;
const maxDp = (dp: number) => (v: string) =>
  !DECIMAL_STRING_RE.test(v) || !/\.\d+$/.test(v) || (v.split('.')[1] ?? '').length <= dp;

export const advisorSettingsSchema = z.strictObject({
  riskPerTradePct: decimalString
    .refine(positive, 'must be greater than zero')
    .refine(atMost(Number(MAX_RISK_PER_TRADE_PCT)), `must be at most ${MAX_RISK_PER_TRADE_PCT}`)
    .refine(maxDp(2), 'at most 2 decimal places'),
});
export type AdvisorSettingsInput = z.infer<typeof advisorSettingsSchema>;

export const runAdvisorSchema = z.strictObject({
  portfolioId: z.uuid(),
  horizons: z.array(horizonSchema).min(1).max(HORIZONS.length).optional(),
});
export type RunAdvisorInput = z.infer<typeof runAdvisorSchema>;

export const dailyReportQuerySchema = z.object({
  portfolioId: z.uuid(),
  horizon: horizonSchema.default(DEFAULT_HORIZON),
});
export type DailyReportQuery = z.infer<typeof dailyReportQuerySchema>;

export const holdingsQuerySchema = z.object({
  portfolioId: z.uuid(),
  horizon: horizonSchema.default(DEFAULT_HORIZON),
});
export type HoldingsQuery = z.infer<typeof holdingsQuerySchema>;

export const SCANNER_FILTERS = [
  'undervalued',
  'earningsGrowth',
  'highDividend',
  'breakout',
  'nearSupport',
  'unusualVolume',
  'momentum',
  'improvingFundamentals',
  'deteriorating',
  'illiquid',
] as const;
export type ScannerFilter = (typeof SCANNER_FILTERS)[number];

export const scannerQuerySchema = z.object({
  horizon: horizonSchema.default(DEFAULT_HORIZON),
  filter: z.enum(SCANNER_FILTERS),
  portfolioId: z.uuid().optional(),
});
export type ScannerQuery = z.infer<typeof scannerQuerySchema>;

export const stockQuerySchema = z.object({ portfolioId: z.uuid().optional() });
export type StockQuery = z.infer<typeof stockQuerySchema>;

export const symbolSchema = z.string().trim().toUpperCase().regex(SYMBOL_RE, 'invalid symbol');
