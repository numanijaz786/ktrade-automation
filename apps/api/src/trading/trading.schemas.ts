import { z } from 'zod';
import { ORDER_ORIGINS, ORDER_SIDES, ORDER_STATUSES, ORDER_TYPES, positiveDecimalString } from '@ktrade/shared';

const wholeShares = positiveDecimalString.refine((v) => /^\d+$/.test(v), 'must be a whole number of shares');

export const previewOrderSchema = z
  .object({
    portfolioId: z.string().uuid(),
    symbol: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9.-]+$/),
    side: z.enum(ORDER_SIDES),
    type: z.enum(ORDER_TYPES),
    quantity: wholeShares,
    limitPrice: positiveDecimalString.optional(),
    stopPrice: positiveDecimalString.optional(),
    // AI suggestions are allowed to PREFILL a preview, never to approve it (approval always needs a human + step-up).
    origin: z.enum(ORDER_ORIGINS).default('MANUAL'),
    strategyId: z.string().uuid().optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.type === 'LIMIT' || v.type === 'STOP_LIMIT') && !v.limitPrice) ctx.addIssue({ code: 'custom', path: ['limitPrice'], message: 'required for LIMIT orders' });
    if ((v.type === 'STOP_LOSS' || v.type === 'STOP_LIMIT') && !v.stopPrice) ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'required for stop orders' });
    if (v.type === 'MARKET' && v.limitPrice) ctx.addIssue({ code: 'custom', path: ['limitPrice'], message: 'not allowed for MARKET orders' });
  });
export type PreviewOrderInput = z.infer<typeof previewOrderSchema>;

export const approveOrderSchema = z.object({ previewHash: z.string().regex(/^[0-9a-f]{64}$/) });
export const markPlacedSchema = z.object({ brokerOrderRef: z.string().trim().max(64).optional() });

export const recordFillSchema = z.object({
  quantity: wholeShares,
  price: positiveDecimalString,
  executedAt: z.string().datetime({ offset: true }),
});
export type RecordFillInput = z.infer<typeof recordFillSchema>;

export const listOrdersSchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  portfolioId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

export const killSwitchSchema = z.object({ liveTradingEnabled: z.boolean(), reason: z.string().trim().min(3).max(500) });

/** Idempotency-Key header (docs/07 §1): required on order creation. */
export const idempotencyKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
