import { z } from 'zod';
import { d } from '@ktrade/finance-core';
import { DECIMAL_STRING_RE, SIGNAL_STATUSES, STRATEGY_TYPES } from '@ktrade/shared';

/**
 * Request schemas for strategies, signals and backtests (docs/07 "Strategies, signals, backtests").
 * Decimal refinements never call d(): they only use regexes, so malformed input is a 422, never a 500 (ADR-024).
 */

/** Percentage stored as NUMERIC(8,4): > 0, at most 4 integer and 4 fraction digits. */
const pctString = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,4})?$/, 'must be a positive percentage like "5" or "7.5" (max 4 decimals)')
  .refine((v) => /[1-9]/.test(v), 'must be greater than zero');

/** Money / quantity stored as NUMERIC(20,4). */
const money4 = z
  .string()
  .trim()
  .regex(/^\d{1,16}(\.\d{1,4})?$/, 'must be a positive decimal string with at most 4 decimals')
  .refine((v) => DECIMAL_STRING_RE.test(v) && /[1-9]/.test(v), 'must be greater than zero');

const wholeQty = z
  .string()
  .trim()
  .regex(/^\d{1,16}$/, 'must be a whole number of shares')
  .refine((v) => /[1-9]/.test(v), 'must be greater than zero');

const symbol = z
  .string()
  .trim()
  .min(1)
  .max(12)
  .regex(/^[A-Za-z0-9]+$/, 'must be a PSX symbol')
  .transform((s) => s.toUpperCase());

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

/** `$param` values: numbers (INT), decimal strings, enum strings or booleans. */
const paramValue = z.union([z.number().int().safe(), z.string().trim().min(1).max(64), z.boolean()]);
const parameters = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'invalid parameter name'), paramValue)
  .refine((r) => Object.keys(r).length <= 32, 'at most 32 parameters');

/** Rule DSL documents are validated structurally by finance-core (JSON paths in the errors). */
const ruleJson = z.unknown();

/** The trading definition shared by persisted strategies, inline backtests and dry runs. */
export const definitionFields = {
  type: z.enum(STRATEGY_TYPES),
  parameters: parameters.optional(),
  entryRules: ruleJson.optional(),
  exitRules: ruleJson.optional(),
  stopLossPct: pctString.nullish(),
  takeProfitPct: pctString.nullish(),
  trailingStopPct: pctString.nullish(),
  cooldownBars: z.number().int().min(0).max(1000).optional(),
};
export const definitionSchema = z.object(definitionFields).strict();
export type DefinitionInput = z.infer<typeof definitionSchema>;

const sizingFields = {
  maxInvestment: money4,
  maxPositionQty: wholeQty.nullish(),
  riskPerTradePct: pctString
    .refine((v) => /^\d+(\.\d+)?$/.test(v) && d(v).lte(100), 'must be at most 100')
    .nullish(),
};

export const createStrategySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    portfolioId: z.string().uuid(),
    symbol,
    interval: z.literal('D1').default('D1'),
    autoExecute: z.boolean().default(false),
    ...definitionFields,
    cooldownBars: z.number().int().min(0).max(1000).default(1),
    ...sizingFields,
  })
  .strict();
export type CreateStrategyInput = z.infer<typeof createStrategySchema>;

export const updateStrategySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    autoExecute: z.boolean().optional(),
    type: z.enum(STRATEGY_TYPES).optional(),
    parameters: parameters.optional(),
    entryRules: ruleJson.optional(),
    exitRules: ruleJson.optional(),
    stopLossPct: pctString.nullish(),
    takeProfitPct: pctString.nullish(),
    trailingStopPct: pctString.nullish(),
    cooldownBars: z.number().int().min(0).max(1000).optional(),
    maxInvestment: money4.optional(),
    maxPositionQty: wholeQty.nullish(),
    riskPerTradePct: sizingFields.riskPerTradePct,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateStrategyInput = z.infer<typeof updateStrategySchema>;

export const validateStrategySchema = z
  .object({
    ...definitionFields,
    symbol: symbol.optional(),
    bars: z.number().int().min(1).max(2000).default(250),
  })
  .strict();
export type ValidateStrategyInput = z.infer<typeof validateStrategySchema>;

/** Basis points of adverse slippage: 0–1000 with at most 4 decimals. */
const slippageBps = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,4})?$/, 'must be a non-negative decimal string (basis points)')
  .refine((v) => /^\d+(\.\d+)?$/.test(v) && d(v).lte(1000), 'must be at most 1000 bps');

const rangeFields = {
  from: isoDate,
  to: isoDate,
  initialCapital: money4,
  slippageBps: slippageBps.default('0'),
  interval: z.literal('D1').default('D1'),
};
const checkRange = (v: { from: string; to: string }, ctx: z.RefinementCtx) => {
  if (!(v.from < v.to)) ctx.addIssue({ code: 'custom', path: ['to'], message: 'must be after `from`' });
};

export const runBacktestSchema = z
  .object({
    strategyId: z.string().uuid().optional(),
    definition: definitionSchema.optional(),
    symbol: symbol.optional(),
    ...rangeFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    checkRange(v, ctx);
    if (!v.strategyId === !v.definition)
      ctx.addIssue({
        code: 'custom',
        path: ['strategyId'],
        message: 'give exactly one of strategyId or definition',
      });
    if (v.definition && !v.symbol)
      ctx.addIssue({ code: 'custom', path: ['symbol'], message: 'required with an inline definition' });
  });
export type RunBacktestInput = z.infer<typeof runBacktestSchema>;

export const compareBacktestsSchema = z
  .object({
    strategyIds: z.array(z.string().uuid()).max(5).default([]),
    definitions: z
      .array(definitionSchema.extend({ label: z.string().trim().min(1).max(60).optional() }))
      .max(5)
      .default([]),
    symbol: symbol.optional(),
    ...rangeFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    checkRange(v, ctx);
    const n = v.strategyIds.length + v.definitions.length;
    if (n < 1 || n > 5)
      ctx.addIssue({ code: 'custom', path: ['strategyIds'], message: 'compare 1 to 5 strategies' });
    if (new Set(v.strategyIds).size !== v.strategyIds.length)
      ctx.addIssue({ code: 'custom', path: ['strategyIds'], message: 'duplicate strategy id' });
    if (v.strategyIds.length === 0 && !v.symbol)
      ctx.addIssue({ code: 'custom', path: ['symbol'], message: 'required when no strategyIds are given' });
  });
export type CompareBacktestsInput = z.infer<typeof compareBacktestsSchema>;

export const listBacktestsSchema = z.object({
  strategyId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const listSignalsSchema = z.object({
  status: z.enum(SIGNAL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
