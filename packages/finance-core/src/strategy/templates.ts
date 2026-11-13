/**
 * Built-in strategy templates (docs/08 §3). Each compiles to the rule DSL; numeric parameters stay as
 * `$param` references (so the stored rules are editable) while ENUM/BOOL parameters shape the rule structure.
 */
import { d } from '../decimal.js';
import { type DslError, type DslOperand, type DslRule, type StrategyParams } from './dsl.js';
import { type StrategyDefinition } from './strategy.js';
import { type StrategyTemplateType } from './types.js';

export type TemplateParamType = 'INT' | 'DECIMAL' | 'BOOL' | 'ENUM';

export interface TemplateParamSchema {
  readonly name: string;
  readonly type: TemplateParamType;
  /** Default value: INT → number, DECIMAL → decimal string, BOOL → boolean, ENUM → option; null = required. */
  readonly default: number | string | boolean | null;
  /** Inclusive bounds (INT: number, DECIMAL: decimal string). */
  readonly min?: number | string;
  readonly max?: number | string;
  readonly options?: readonly string[];
  readonly required: boolean;
  readonly description: string;
}

export type BuiltInTemplateType = Exclude<StrategyTemplateType, 'CUSTOM_RULES'>;

export interface StrategyTemplate {
  readonly type: BuiltInTemplateType;
  readonly label: string;
  readonly description: string;
  readonly params: readonly TemplateParamSchema[];
}

const INT = (
  name: string,
  dflt: number,
  min: number,
  max: number,
  description: string,
): TemplateParamSchema => ({
  name,
  type: 'INT',
  default: dflt,
  min,
  max,
  required: false,
  description,
});
const DEC = (
  name: string,
  dflt: string | null,
  min: string,
  max: string,
  description: string,
): TemplateParamSchema => ({
  name,
  type: 'DECIMAL',
  default: dflt,
  min,
  max,
  required: dflt === null,
  description,
});

export const STRATEGY_TEMPLATES: Readonly<Record<BuiltInTemplateType, StrategyTemplate>> = {
  MA_CROSSOVER: {
    type: 'MA_CROSSOVER',
    label: 'Moving-average crossover',
    description: 'Enter when the fast MA crosses above the slow MA; exit when it crosses below.',
    params: [
      INT('fastPeriod', 9, 1, 500, 'Fast moving-average period (bars)'),
      INT('slowPeriod', 21, 2, 1000, 'Slow moving-average period (bars); must exceed fastPeriod'),
      {
        name: 'maType',
        type: 'ENUM',
        default: 'EMA',
        options: ['EMA', 'SMA'],
        required: false,
        description: 'Moving-average type',
      },
    ],
  },
  RSI: {
    type: 'RSI',
    label: 'RSI reversal',
    description:
      'Enter when RSI crosses back above the oversold level; exit when it crosses below the overbought level.',
    params: [
      INT('rsiPeriod', 14, 2, 500, 'RSI period (Wilder)'),
      DEC('oversold', '30', '0', '100', 'Oversold level'),
      DEC('overbought', '70', '0', '100', 'Overbought level; must exceed oversold'),
    ],
  },
  MACD: {
    type: 'MACD',
    label: 'MACD signal-line crossover',
    description: 'Enter when the MACD line crosses above its signal line; exit when it crosses below.',
    params: [
      INT('fastPeriod', 12, 1, 500, 'Fast EMA period'),
      INT('slowPeriod', 26, 2, 1000, 'Slow EMA period; must exceed fastPeriod'),
      INT('signalPeriod', 9, 1, 500, 'Signal-line EMA period'),
      {
        name: 'requireMacdAboveZero',
        type: 'BOOL',
        default: false,
        required: false,
        description: 'Only enter when the MACD line is above zero (bullish regime)',
      },
    ],
  },
  STOP_LOSS: {
    type: 'STOP_LOSS',
    label: 'Stop-loss %',
    description: 'Exit when close <= avgCost x (1 - stopLossPct%).',
    params: [DEC('stopLossPct', '5', '0.01', '99.99', 'Loss from average cost that triggers the exit (%)')],
  },
  TAKE_PROFIT: {
    type: 'TAKE_PROFIT',
    label: 'Take-profit %',
    description: 'Exit when close >= avgCost x (1 + takeProfitPct%).',
    params: [
      DEC('takeProfitPct', '10', '0.01', '10000', 'Gain over average cost that triggers the exit (%)'),
    ],
  },
  TRAILING_STOP: {
    type: 'TRAILING_STOP',
    label: 'Trailing stop %',
    description: 'Exit when close <= highSinceEntry x (1 - trailingStopPct%).',
    params: [DEC('trailingStopPct', '7', '0.01', '99.99', 'Drop from the highest price since entry (%)')],
  },
  PRICE_ALERT: {
    type: 'PRICE_ALERT',
    label: 'Price target',
    description: 'Signal when the close reaches a target level; optional exit target.',
    params: [
      {
        name: 'direction',
        type: 'ENUM',
        default: 'ABOVE',
        options: ['ABOVE', 'BELOW'],
        required: false,
        description: 'Entry when close is at/above or at/below the target',
      },
      DEC('targetPrice', null, '0', '100000000', 'Entry target price'),
      {
        name: 'exitDirection',
        type: 'ENUM',
        default: 'ABOVE',
        options: ['ABOVE', 'BELOW'],
        required: false,
        description: 'Exit when close is at/above or at/below the exit target',
      },
      {
        name: 'exitTargetPrice',
        type: 'DECIMAL',
        default: null,
        min: '0',
        max: '100000000',
        required: false,
        description: 'Optional exit target price',
      },
    ],
  },
};

const DEC_RE = /^\d+(\.\d+)?$/;

export type ResolvedTemplateParams = Record<string, number | string | boolean>;
export type TemplateParamsResult =
  { ok: true; params: ResolvedTemplateParams } | { ok: false; errors: DslError[] };

/** Apply defaults, type-check and range-check user overrides against a template's parameter schema. */
export function resolveTemplateParams(
  type: BuiltInTemplateType,
  overrides: StrategyParams = {},
): TemplateParamsResult {
  const tpl = STRATEGY_TEMPLATES[type];
  const errors: DslError[] = [];
  const out: ResolvedTemplateParams = {};
  const err = (name: string, code: DslError['code'], message: string): void => {
    errors.push({ path: `$.parameters.${name}`, code, message });
  };
  for (const key of Object.keys(overrides)) {
    if (!tpl.params.some((p) => p.name === key)) err(key, 'UNKNOWN_KEY', `unknown parameter for ${type}`);
  }
  for (const p of tpl.params) {
    const raw = Object.prototype.hasOwnProperty.call(overrides, p.name) ? overrides[p.name] : p.default;
    if (raw === null || raw === undefined) {
      if (p.required) err(p.name, 'MISSING_FIELD', 'is required');
      continue;
    }
    switch (p.type) {
      case 'INT': {
        const n =
          typeof raw === 'number'
            ? raw
            : typeof raw === 'string' && /^-?\d+$/.test(raw)
              ? Number.parseInt(raw, 10)
              : null;
        if (n === null || !Number.isSafeInteger(n)) err(p.name, 'INVALID_VALUE', 'must be an integer');
        else if (n < (p.min as number) || n > (p.max as number))
          err(p.name, 'OUT_OF_RANGE', `must be between ${String(p.min)} and ${String(p.max)}`);
        else out[p.name] = n;
        break;
      }
      case 'DECIMAL': {
        const s =
          typeof raw === 'number' && Number.isSafeInteger(raw)
            ? String(raw)
            : typeof raw === 'string'
              ? raw.trim()
              : null;
        if (s === null || !DEC_RE.test(s)) {
          err(p.name, 'INVALID_VALUE', 'must be a non-negative decimal string');
          break;
        }
        const v = d(s);
        if (v.lt(d(String(p.min))) || v.gt(d(String(p.max))))
          err(p.name, 'OUT_OF_RANGE', `must be between ${String(p.min)} and ${String(p.max)}`);
        else out[p.name] = s;
        break;
      }
      case 'BOOL':
        if (typeof raw !== 'boolean') err(p.name, 'INVALID_VALUE', 'must be a boolean');
        else out[p.name] = raw;
        break;
      case 'ENUM':
        if (typeof raw !== 'string' || !(p.options ?? []).includes(raw))
          err(p.name, 'INVALID_VALUE', `must be one of ${(p.options ?? []).join(', ')}`);
        else out[p.name] = raw;
        break;
    }
  }
  // cross-field constraints
  const lt = (a: string, b: string, isDec: boolean): void => {
    const x = out[a];
    const y = out[b];
    if (x === undefined || y === undefined) return;
    const bad = isDec ? !d(String(x)).lt(d(String(y))) : !((x as number) < (y as number));
    if (bad) err(b, 'OUT_OF_RANGE', `${b} must be greater than ${a}`);
  };
  if (type === 'MA_CROSSOVER' || type === 'MACD') lt('fastPeriod', 'slowPeriod', false);
  if (type === 'RSI') lt('oversold', 'overbought', true);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, params: out };
}

export class TemplateParamsError extends Error {
  constructor(readonly errors: readonly DslError[]) {
    super(`Invalid template parameters: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'TemplateParamsError';
  }
}

const closeOp = { field: 'close' } as const;
const avgCost = { position: 'avgCost' } as const;
const fraction = (param: string): DslOperand => ({
  div: [{ const: `$${param}` }, { const: '100' }],
});

/** Build a StrategyDefinition (DSL rules + parameters) from a built-in template. Throws TemplateParamsError. */
export function buildTemplateStrategy(
  type: BuiltInTemplateType,
  overrides: StrategyParams = {},
): StrategyDefinition {
  const r = resolveTemplateParams(type, overrides);
  if (!r.ok) throw new TemplateParamsError(r.errors);
  const p = r.params;
  switch (type) {
    case 'MA_CROSSOVER': {
      const ma = p.maType === 'SMA' ? 'SMA' : 'EMA';
      const fast = { ind: ma, period: '$fastPeriod' } as const;
      const slow = { ind: ma, period: '$slowPeriod' } as const;
      return {
        entryRules: { crossesAbove: [fast, slow] } satisfies DslRule,
        exitRules: { crossesBelow: [fast, slow] } satisfies DslRule,
        parameters: p,
      };
    }
    case 'RSI': {
      const rsi = { ind: 'RSI', period: '$rsiPeriod' } as const;
      return {
        entryRules: { crossesAbove: [rsi, { const: '$oversold' }] } satisfies DslRule,
        exitRules: { crossesBelow: [rsi, { const: '$overbought' }] } satisfies DslRule,
        parameters: p,
      };
    }
    case 'MACD': {
      const base = {
        ind: 'MACD',
        fast: '$fastPeriod',
        slow: '$slowPeriod',
        signal: '$signalPeriod',
      } as const;
      const line = { ...base, output: 'line' };
      const signal = { ...base, output: 'signal' };
      const cross: DslRule = { crossesAbove: [line, signal] };
      return {
        entryRules:
          p.requireMacdAboveZero === true
            ? ({ all: [cross, { gt: [line, { const: '0' }] }] } satisfies DslRule)
            : cross,
        exitRules: { crossesBelow: [line, signal] } satisfies DslRule,
        parameters: p,
      };
    }
    case 'STOP_LOSS':
      return {
        exitRules: {
          lte: [closeOp, { mul: [avgCost, { sub: [{ const: '1' }, fraction('stopLossPct')] }] }],
        } satisfies DslRule,
        exitReason: 'STOP_LOSS',
        parameters: p,
      };
    case 'TAKE_PROFIT':
      return {
        exitRules: {
          gte: [closeOp, { mul: [avgCost, { add: [{ const: '1' }, fraction('takeProfitPct')] }] }],
        } satisfies DslRule,
        exitReason: 'TAKE_PROFIT',
        parameters: p,
      };
    case 'TRAILING_STOP':
      return {
        exitRules: {
          lte: [
            closeOp,
            { mul: [{ position: 'highSinceEntry' }, { sub: [{ const: '1' }, fraction('trailingStopPct')] }] },
          ],
        } satisfies DslRule,
        exitReason: 'TRAILING_STOP',
        parameters: p,
      };
    case 'PRICE_ALERT': {
      const level = (dir: unknown, param: string): DslRule =>
        dir === 'BELOW'
          ? { lte: [closeOp, { const: `$${param}` }] }
          : { gte: [closeOp, { const: `$${param}` }] };
      return {
        entryRules: level(p.direction, 'targetPrice'),
        exitRules: p.exitTargetPrice === undefined ? null : level(p.exitDirection, 'exitTargetPrice'),
        entryReason: 'PRICE_TARGET',
        exitReason: 'PRICE_TARGET',
        parameters: p,
      };
    }
  }
}

/** Parameter schema for UI forms. */
export function templateParamSchema(type: BuiltInTemplateType): readonly TemplateParamSchema[] {
  return STRATEGY_TEMPLATES[type].params;
}
