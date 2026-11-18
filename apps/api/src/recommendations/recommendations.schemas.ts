import { z } from 'zod';
import {
  CONFIDENCE_LEVELS,
  DATA_SOURCES,
  DECIMAL_STRING_RE,
  decimalString,
  RECOMMENDATION_ACTIONS,
  RECOMMENDATION_HORIZONS,
  RECOMMENDATION_STATUSES,
} from '@ktrade/shared';
import { isIsoDate } from '../market-data/calendar.js';
import { SYMBOL_RE } from '../market-data/decimal-format.js';

// ADR-024: refinements run after failed regex checks in Zod 4, so test the regex before touching the value.
const fits = (intDigits: number, dp: number) => {
  const re = new RegExp(`^-?\\d{1,${intDigits}}(\\.\\d{1,${dp}})?$`);
  return (v: string) => !DECIMAL_STRING_RE.test(v) || re.test(v);
};
const positive = (v: string) => !DECIMAL_STRING_RE.test(v) || (!v.startsWith('-') && /[1-9]/.test(v));

/** NUMERIC(20,6) positive price/level. */
const levelString = decimalString
  .refine(fits(14, 6), 'at most 6 decimal places')
  .refine(positive, 'must be greater than zero');

const isoDate = z.string().trim().refine(isIsoDate, 'must be a calendar date YYYY-MM-DD');
const symbol = z.string().trim().toUpperCase().regex(SYMBOL_RE, 'invalid symbol');
const json = z.json();

/** What the (pure) engine hands the store. Money/levels are decimal strings. */
export const recordRecommendationSchema = z.strictObject({
  userId: z.uuid().nullable().default(null),
  symbol,
  horizon: z.enum(RECOMMENDATION_HORIZONS),
  action: z.enum(RECOMMENDATION_ACTIONS),
  status: z.enum(RECOMMENDATION_STATUSES),
  generatedAt: z.date(),
  asOfBar: isoDate,
  price: levelString,
  priceSource: z.enum(DATA_SOURCES),
  entryLow: levelString.optional(),
  entryHigh: levelString.optional(),
  stop: levelString.optional(),
  target1: levelString.optional(),
  target2: levelString.optional(),
  target3: levelString.optional(),
  riskReward: decimalString
    .refine(fits(6, 4), 'at most 4 decimal places')
    .refine(positive, 'must be greater than zero')
    .optional(),
  holdingPeriod: z.string().trim().min(1).max(80).optional(),
  holdingDaysMax: z.number().int().min(1).max(3650).optional(),
  confidence: decimalString
    .refine(fits(3, 2), 'at most 2 decimal places')
    .refine(
      (v) => !DECIMAL_STRING_RE.test(v) || (!v.startsWith('-') && Number(v) <= 100),
      'must be between 0 and 100',
    ),
  confidenceLevel: z.enum(CONFIDENCE_LEVELS),
  components: json.default({}),
  reasons: json.default([]),
  invalidations: json.default([]),
  dataQuality: json.default({}),
  engineVersion: z.string().trim().min(1).max(60),
  inputsSnapshot: json.default({}),
});
export type RecordRecommendationInput = z.input<typeof recordRecommendationSchema>;
export type ParsedRecommendation = z.output<typeof recordRecommendationSchema>;

const dateRange = {
  from: isoDate.optional(),
  to: isoDate.optional(),
};

export const listRecommendationsSchema = z.object({
  action: z.enum(RECOMMENDATION_ACTIONS).optional(),
  horizon: z.enum(RECOMMENDATION_HORIZONS).optional(),
  status: z.enum(RECOMMENDATION_STATUSES).optional(),
  symbol: symbol.optional(),
  ...dateRange,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListRecommendationsQuery = z.infer<typeof listRecommendationsSchema>;

export const performanceQuerySchema = z.object({
  action: z.enum(RECOMMENDATION_ACTIONS).optional(),
  horizon: z.enum(RECOMMENDATION_HORIZONS).optional(),
  symbol: symbol.optional(),
  ...dateRange,
  /** Recommendations priced on SIMULATED data are excluded unless explicitly requested (docs/10 §3). */
  includeSimulated: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type PerformanceQuery = z.infer<typeof performanceQuerySchema>;
