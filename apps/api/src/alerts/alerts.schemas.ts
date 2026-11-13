import { z } from 'zod';
import { d } from '@ktrade/finance-core';
import { DECIMAL_STRING_RE, NOTIFICATION_CHANNELS, positiveDecimalString } from '@ktrade/shared';
import type { EvaluableAlertType } from './alert-rules.js';

// ADR-024: Zod 4 runs refinements even after the regex failed, so every decimal refinement checks the regex first.
const pctBelow100 = positiveDecimalString.refine(
  (v) => !DECIMAL_STRING_RE.test(v) || d(v).lt(100),
  'must be < 100',
);
const pctUpTo1000 = positiveDecimalString.refine(
  (v) => !DECIMAL_STRING_RE.test(v) || d(v).lte(1000),
  'must be ≤ 1000',
);
const multiple = positiveDecimalString.refine(
  (v) => !DECIMAL_STRING_RE.test(v) || d(v).lte(1000),
  'must be ≤ 1000',
);

const symbol = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9.-]{0,15}$/, 'invalid symbol');

/** Typed `params` per AlertType. The single numeric parameter is mirrored into `alerts.threshold`. */
export const alertParamsSchemas = {
  PRICE_ABOVE: z.object({ price: positiveDecimalString }).strict(),
  PRICE_BELOW: z.object({ price: positiveDecimalString }).strict(),
  PCT_CHANGE_ABOVE: z.object({ pct: pctUpTo1000 }).strict(),
  PCT_CHANGE_BELOW: z.object({ pct: pctBelow100 }).strict(),
  VOLUME_SPIKE: z.object({ multiple }).strict(),
  PORTFOLIO_DAILY_LOSS: z.object({ pct: pctBelow100 }).strict(),
  POSITION_STOP_LOSS: z.object({ pct: pctBelow100 }).strict(),
} satisfies Record<EvaluableAlertType, z.ZodType>;

export function thresholdOf(type: EvaluableAlertType, params: Record<string, string>): string {
  switch (type) {
    case 'PRICE_ABOVE':
    case 'PRICE_BELOW':
      return params.price!;
    case 'VOLUME_SPIKE':
      return params.multiple!;
    default:
      return params.pct!;
  }
}

const channels = z
  .array(z.enum(NOTIFICATION_CHANNELS))
  .min(1)
  .max(NOTIFICATION_CHANNELS.length)
  .transform((c) => [...new Set(c)]);

const options = {
  channels: channels.default(['IN_APP']),
  cooldownMinutes: z.number().int().min(1).max(10_080).default(60),
  triggerOnce: z.boolean().default(false),
  isActive: z.boolean().default(true),
};

export const createAlertSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('PRICE_ABOVE'), symbol, params: alertParamsSchemas.PRICE_ABOVE, ...options })
    .strict(),
  z
    .object({ type: z.literal('PRICE_BELOW'), symbol, params: alertParamsSchemas.PRICE_BELOW, ...options })
    .strict(),
  z
    .object({
      type: z.literal('PCT_CHANGE_ABOVE'),
      symbol,
      params: alertParamsSchemas.PCT_CHANGE_ABOVE,
      ...options,
    })
    .strict(),
  z
    .object({
      type: z.literal('PCT_CHANGE_BELOW'),
      symbol,
      params: alertParamsSchemas.PCT_CHANGE_BELOW,
      ...options,
    })
    .strict(),
  z
    .object({ type: z.literal('VOLUME_SPIKE'), symbol, params: alertParamsSchemas.VOLUME_SPIKE, ...options })
    .strict(),
  z
    .object({
      type: z.literal('PORTFOLIO_DAILY_LOSS'),
      portfolioId: z.string().uuid(),
      params: alertParamsSchemas.PORTFOLIO_DAILY_LOSS,
      ...options,
    })
    .strict(),
  z
    .object({
      type: z.literal('POSITION_STOP_LOSS'),
      portfolioId: z.string().uuid(),
      symbol,
      params: alertParamsSchemas.POSITION_STOP_LOSS,
      ...options,
    })
    .strict(),
]);
export type CreateAlertInput = z.infer<typeof createAlertSchema>;

/** Type, symbol and portfolio are immutable (delete and re-create instead); params are re-validated per type. */
export const updateAlertSchema = z
  .object({
    params: z.record(z.string(), z.string()).optional(),
    channels: channels.optional(),
    cooldownMinutes: z.number().int().min(1).max(10_080).optional(),
    triggerOnce: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'nothing to update');
export type UpdateAlertInput = z.infer<typeof updateAlertSchema>;
