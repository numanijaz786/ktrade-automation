/**
 * Rule DSL (docs/08 §3): JSON types, hand-rolled validator and the resolved AST.
 * The DSL is pure data: it is validated here and compiled to closures in ./engine.ts — never eval'd.
 */
import { d, type Decimal } from '../decimal.js';
import { type PriceSource } from '../indicators/types.js';

// ───────────────────────────── JSON surface ─────────────────────────────

/** `$name` references a strategy parameter. */
export type DslParamRef = `$${string}`;
/** Integers (periods, bar counts): a JS safe integer, an integer string, or a `$param`. */
export type DslInt = number | string;
/** Decimals: a decimal string ("1.5"), a JS safe integer, or a `$param`. JS fractional numbers are rejected. */
export type DslDecimal = string | number;

export const DSL_INDICATORS = [
  'SMA',
  'EMA',
  'WMA',
  'RSI',
  'MACD',
  'ATR',
  'BB',
  'ROC',
  'HIGHEST',
  'LOWEST',
  'VOLUME_SMA',
] as const;
export type DslIndicatorName = (typeof DSL_INDICATORS)[number];

export const DSL_FIELDS = ['open', 'high', 'low', 'close', 'volume', 'changePct'] as const;
export type DslField = (typeof DSL_FIELDS)[number];

export const DSL_POSITION_FIELDS = ['qty', 'avgCost', 'unrealizedPct', 'barsHeld', 'highSinceEntry'] as const;
export type DslPositionField = (typeof DSL_POSITION_FIELDS)[number];

export interface DslIndicatorOperand {
  ind: DslIndicatorName;
  period?: DslInt;
  /** MACD */
  fast?: DslInt;
  slow?: DslInt;
  signal?: DslInt;
  /** BB standard-deviation multiplier (default "2"). */
  stdDev?: DslDecimal;
  /** MACD: line|signal|histogram (default line). BB: upper|middle|lower (default middle). */
  output?: string;
  source?: PriceSource;
  /** Value `offset` bars ago (0 = current bar). */
  offset?: DslInt;
}
export interface DslFieldOperand {
  field: DslField;
  offset?: DslInt;
}
export interface DslPositionOperand {
  position: DslPositionField;
}
export interface DslConstOperand {
  const: DslDecimal;
}
export type DslArithOperand =
  | { add: DslOperand[] }
  | { mul: DslOperand[] }
  | { sub: [DslOperand, DslOperand] }
  | { div: [DslOperand, DslOperand] };
export type DslOperand =
  DslIndicatorOperand | DslFieldOperand | DslPositionOperand | DslConstOperand | DslArithOperand;

export type DslComparisonOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
export type DslRule =
  | { all: DslRule[] }
  | { any: DslRule[] }
  | { not: DslRule }
  | { gt: [DslOperand, DslOperand] }
  | { gte: [DslOperand, DslOperand] }
  | { lt: [DslOperand, DslOperand] }
  | { lte: [DslOperand, DslOperand] }
  | { eq: [DslOperand, DslOperand] }
  /** lo <= x <= hi (inclusive). */
  | { between: [DslOperand, DslOperand, DslOperand] }
  /** a[t-1] <= b[t-1] and a[t] > b[t]. */
  | { crossesAbove: [DslOperand, DslOperand] }
  /** a[t-1] >= b[t-1] and a[t] < b[t]. */
  | { crossesBelow: [DslOperand, DslOperand] }
  /** Strictly increasing over the last n bars: a[t-n] < ... < a[t-1] < a[t]. */
  | { rising: [DslOperand, DslInt] }
  | { falling: [DslOperand, DslInt] };

/** Values of strategy parameters referenced as `$name`. */
export type StrategyParams = Readonly<Record<string, string | number | boolean>>;

// ───────────────────────────── errors ─────────────────────────────

export type DslErrorCode =
  | 'INVALID_TYPE'
  | 'UNKNOWN_OPERATOR'
  | 'UNKNOWN_KEY'
  | 'MISSING_FIELD'
  | 'ARITY'
  | 'UNKNOWN_INDICATOR'
  | 'INVALID_VALUE'
  | 'OUT_OF_RANGE'
  | 'UNKNOWN_PARAM'
  | 'TOO_COMPLEX';

export interface DslError {
  /** JSON path, e.g. `$.all[0].crossesAbove[1].period`. */
  readonly path: string;
  readonly code: DslErrorCode;
  readonly message: string;
}

export class RuleValidationError extends Error {
  constructor(readonly errors: readonly DslError[]) {
    super(`Invalid rule: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'RuleValidationError';
  }
}

// ───────────────────────────── resolved AST ─────────────────────────────

export interface IndicatorSpecResolved {
  readonly name: DslIndicatorName;
  readonly period: number;
  readonly fast: number;
  readonly slow: number;
  readonly signal: number;
  readonly stdDev: Decimal;
  readonly output: string;
  readonly source: PriceSource | null;
}

export type OperandAst =
  | { readonly k: 'ind'; readonly spec: IndicatorSpecResolved; readonly offset: number }
  | { readonly k: 'field'; readonly field: DslField; readonly offset: number }
  | { readonly k: 'pos'; readonly field: DslPositionField }
  | { readonly k: 'const'; readonly value: Decimal }
  | { readonly k: 'arith'; readonly op: 'add' | 'sub' | 'mul' | 'div'; readonly args: readonly OperandAst[] };

export type RuleAst =
  | { readonly k: 'all' | 'any'; readonly path: string; readonly rules: readonly RuleAst[] }
  | { readonly k: 'not'; readonly path: string; readonly rule: RuleAst }
  | {
      readonly k: 'cmp';
      readonly path: string;
      readonly op: DslComparisonOp;
      readonly a: OperandAst;
      readonly b: OperandAst;
    }
  | {
      readonly k: 'between';
      readonly path: string;
      readonly x: OperandAst;
      readonly lo: OperandAst;
      readonly hi: OperandAst;
    }
  | {
      readonly k: 'cross';
      readonly path: string;
      readonly dir: 'above' | 'below';
      readonly a: OperandAst;
      readonly b: OperandAst;
    }
  | {
      readonly k: 'trend';
      readonly path: string;
      readonly dir: 'rising' | 'falling';
      readonly a: OperandAst;
      readonly n: number;
    };

// ───────────────────────────── limits ─────────────────────────────

export const DSL_LIMITS = {
  maxDepth: 24,
  maxNodes: 500,
  maxPeriod: 1000,
  maxOffset: 500,
  maxLookbackBars: 500,
} as const;

// ───────────────────────────── validator ─────────────────────────────

interface IndicatorTemplate {
  readonly ints: readonly {
    readonly key: 'period' | 'fast' | 'slow' | 'signal';
    readonly dflt: number | null;
  }[];
  readonly hasStdDev?: boolean;
  readonly outputs?: readonly string[];
  readonly defaultSource: PriceSource | null;
}

const IND_TEMPLATES: Record<DslIndicatorName, IndicatorTemplate> = {
  SMA: { ints: [{ key: 'period', dflt: null }], defaultSource: 'close' },
  EMA: { ints: [{ key: 'period', dflt: null }], defaultSource: 'close' },
  WMA: { ints: [{ key: 'period', dflt: null }], defaultSource: 'close' },
  ROC: { ints: [{ key: 'period', dflt: null }], defaultSource: 'close' },
  RSI: { ints: [{ key: 'period', dflt: 14 }], defaultSource: 'close' },
  MACD: {
    ints: [
      { key: 'fast', dflt: 12 },
      { key: 'slow', dflt: 26 },
      { key: 'signal', dflt: 9 },
    ],
    outputs: ['line', 'signal', 'histogram'],
    defaultSource: 'close',
  },
  ATR: { ints: [{ key: 'period', dflt: 14 }], defaultSource: null },
  BB: {
    ints: [{ key: 'period', dflt: 20 }],
    hasStdDev: true,
    outputs: ['middle', 'upper', 'lower'],
    defaultSource: 'close',
  },
  HIGHEST: { ints: [{ key: 'period', dflt: null }], defaultSource: 'high' },
  LOWEST: { ints: [{ key: 'period', dflt: null }], defaultSource: 'low' },
  VOLUME_SMA: { ints: [{ key: 'period', dflt: null }], defaultSource: null },
};

const SOURCES: readonly string[] = ['open', 'high', 'low', 'close', 'volume'];
const PARAM_REF = /^\$[A-Za-z_][A-Za-z0-9_]*$/;
const INT_STR = /^-?\d+$/;
const DEC_STR = /^-?\d+(\.\d+)?$/;
const COMPARISONS: readonly string[] = ['gt', 'gte', 'lt', 'lte', 'eq'];
const RULE_OPS: readonly string[] = [
  'all',
  'any',
  'not',
  ...COMPARISONS,
  'between',
  'crossesAbove',
  'crossesBelow',
  'rising',
  'falling',
];

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const keyPath = (path: string, key: string): string => `${path}.${key}`;
const idxPath = (path: string, i: number): string => `${path}[${i}]`;

class Validator {
  readonly errors: DslError[] = [];
  private nodes = 0;
  constructor(private readonly params: StrategyParams) {}

  err(path: string, code: DslErrorCode, message: string): null {
    this.errors.push({ path, code, message });
    return null;
  }

  private count(path: string, depth: number): boolean {
    this.nodes++;
    if (depth > DSL_LIMITS.maxDepth) {
      this.err(path, 'TOO_COMPLEX', `nesting deeper than ${DSL_LIMITS.maxDepth}`);
      return false;
    }
    if (this.nodes === DSL_LIMITS.maxNodes + 1)
      this.err(path, 'TOO_COMPLEX', `more than ${DSL_LIMITS.maxNodes} nodes`);
    return this.nodes <= DSL_LIMITS.maxNodes;
  }

  /** Resolve a `$param` reference (returns the raw value) or pass through literals. */
  private deref(raw: unknown, path: string): unknown {
    if (typeof raw === 'string' && raw.startsWith('$')) {
      if (!PARAM_REF.test(raw))
        return this.err(path, 'INVALID_VALUE', `malformed parameter reference "${raw}"`);
      const name = raw.slice(1);
      if (!Object.prototype.hasOwnProperty.call(this.params, name)) {
        return this.err(path, 'UNKNOWN_PARAM', `unknown parameter "${raw}"`);
      }
      return this.params[name];
    }
    return raw;
  }

  int(raw: unknown, path: string, minimum: number, maximum: number): number | null {
    const v = this.deref(raw, path);
    if (v === null) return null;
    let n: number | null = null;
    if (typeof v === 'number' && Number.isSafeInteger(v)) n = v;
    else if (typeof v === 'string' && INT_STR.test(v) && v.length <= 15) n = Number.parseInt(v, 10);
    if (n === null) return this.err(path, 'INVALID_VALUE', `expected an integer, got ${JSON.stringify(v)}`);
    if (n < minimum || n > maximum)
      return this.err(path, 'OUT_OF_RANGE', `must be between ${minimum} and ${maximum}, got ${n}`);
    return n;
  }

  decimal(raw: unknown, path: string): Decimal | null {
    const v = this.deref(raw, path);
    if (v === null) return null;
    if (typeof v === 'number') {
      if (Number.isSafeInteger(v)) return d(String(v));
      return this.err(
        path,
        'INVALID_VALUE',
        `fractional JS numbers are not allowed; use a decimal string (got ${String(v)})`,
      );
    }
    if (typeof v === 'string' && DEC_STR.test(v.trim())) return d(v.trim());
    return this.err(path, 'INVALID_VALUE', `expected a decimal string, got ${JSON.stringify(v)}`);
  }

  private unknownKeys(o: Record<string, unknown>, allowed: readonly string[], path: string): void {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) this.err(keyPath(path, k), 'UNKNOWN_KEY', `unexpected key "${k}"`);
    }
  }

  private tuple(raw: unknown, n: number, path: string): unknown[] | null {
    if (!Array.isArray(raw)) return this.err(path, 'INVALID_TYPE', `expected an array of ${n} items`);
    if (raw.length !== n) return this.err(path, 'ARITY', `expected exactly ${n} items, got ${raw.length}`);
    return raw;
  }

  operand(raw: unknown, path: string, depth: number): OperandAst | null {
    if (!this.count(path, depth)) return null;
    if (!isObj(raw)) return this.err(path, 'INVALID_TYPE', 'operand must be an object');
    if ('ind' in raw) return this.indicator(raw, path);
    if ('field' in raw) {
      this.unknownKeys(raw, ['field', 'offset'], path);
      const f = raw.field;
      if (typeof f !== 'string' || !(DSL_FIELDS as readonly string[]).includes(f)) {
        return this.err(
          keyPath(path, 'field'),
          'INVALID_VALUE',
          `field must be one of ${DSL_FIELDS.join(', ')}`,
        );
      }
      const offset =
        raw.offset === undefined ? 0 : this.int(raw.offset, keyPath(path, 'offset'), 0, DSL_LIMITS.maxOffset);
      return offset === null ? null : { k: 'field', field: f as DslField, offset };
    }
    if ('position' in raw) {
      this.unknownKeys(raw, ['position'], path);
      const f = raw.position;
      if (typeof f !== 'string' || !(DSL_POSITION_FIELDS as readonly string[]).includes(f)) {
        return this.err(
          keyPath(path, 'position'),
          'INVALID_VALUE',
          `position must be one of ${DSL_POSITION_FIELDS.join(', ')}`,
        );
      }
      return { k: 'pos', field: f as DslPositionField };
    }
    if ('const' in raw) {
      this.unknownKeys(raw, ['const'], path);
      const v = this.decimal(raw.const, keyPath(path, 'const'));
      return v === null ? null : { k: 'const', value: v };
    }
    for (const op of ['add', 'sub', 'mul', 'div'] as const) {
      if (op in raw) {
        this.unknownKeys(raw, [op], path);
        const p = keyPath(path, op);
        const list = raw[op];
        if (!Array.isArray(list)) return this.err(p, 'INVALID_TYPE', `${op} expects an array of operands`);
        const binary = op === 'sub' || op === 'div';
        if (binary ? list.length !== 2 : list.length < 2) {
          return this.err(
            p,
            'ARITY',
            binary ? `${op} expects exactly 2 operands` : `${op} expects at least 2 operands`,
          );
        }
        const args = list.map((a, i) => this.operand(a, idxPath(p, i), depth + 1));
        if (args.some((a) => a === null)) return null;
        return { k: 'arith', op, args: args as OperandAst[] };
      }
    }
    return this.err(
      path,
      'UNKNOWN_OPERATOR',
      `unknown operand; expected one of ind, field, position, const, add, sub, mul, div`,
    );
  }

  private indicator(raw: Record<string, unknown>, path: string): OperandAst | null {
    const name = this.deref(raw.ind, keyPath(path, 'ind'));
    if (typeof name !== 'string' || !(DSL_INDICATORS as readonly string[]).includes(name)) {
      return this.err(
        keyPath(path, 'ind'),
        'UNKNOWN_INDICATOR',
        `unknown indicator ${JSON.stringify(name)}; expected one of ${DSL_INDICATORS.join(', ')}`,
      );
    }
    const tpl = IND_TEMPLATES[name as DslIndicatorName];
    const allowed = ['ind', 'offset', ...tpl.ints.map((i) => i.key)];
    if (tpl.hasStdDev) allowed.push('stdDev');
    if (tpl.outputs) allowed.push('output');
    if (tpl.defaultSource !== null) allowed.push('source');
    this.unknownKeys(raw, allowed, path);
    const before = this.errors.length;
    const ints: Record<string, number> = { period: 0, fast: 0, slow: 0, signal: 0 };
    for (const { key, dflt } of tpl.ints) {
      const v = raw[key];
      if (v === undefined) {
        if (dflt === null) this.err(keyPath(path, key), 'MISSING_FIELD', `${name} requires "${key}"`);
        else ints[key] = dflt;
      } else {
        const n = this.int(v, keyPath(path, key), 1, DSL_LIMITS.maxPeriod);
        if (n !== null) ints[key] = n;
      }
    }
    let stdDev = d('2');
    if (tpl.hasStdDev && raw.stdDev !== undefined) {
      const sd = this.decimal(raw.stdDev, keyPath(path, 'stdDev'));
      if (sd !== null && sd.isNeg()) this.err(keyPath(path, 'stdDev'), 'OUT_OF_RANGE', 'stdDev must be >= 0');
      else if (sd !== null) stdDev = sd;
    }
    let output = tpl.outputs?.[0] ?? 'value';
    if (tpl.outputs && raw.output !== undefined) {
      const o = this.deref(raw.output, keyPath(path, 'output'));
      if (typeof o !== 'string' || !tpl.outputs.includes(o)) {
        this.err(keyPath(path, 'output'), 'INVALID_VALUE', `output must be one of ${tpl.outputs.join(', ')}`);
      } else output = o;
    }
    let source = tpl.defaultSource;
    if (source !== null && raw.source !== undefined) {
      const s = this.deref(raw.source, keyPath(path, 'source'));
      if (typeof s !== 'string' || !SOURCES.includes(s)) {
        this.err(keyPath(path, 'source'), 'INVALID_VALUE', `source must be one of ${SOURCES.join(', ')}`);
      } else source = s as PriceSource;
    }
    if (
      name === 'MACD' &&
      ints.fast !== undefined &&
      ints.slow !== undefined &&
      ints.fast > 0 &&
      ints.slow > 0 &&
      ints.fast >= ints.slow
    ) {
      this.err(
        keyPath(path, 'fast'),
        'OUT_OF_RANGE',
        `MACD fast (${ints.fast}) must be < slow (${ints.slow})`,
      );
    }
    const offset =
      raw.offset === undefined ? 0 : this.int(raw.offset, keyPath(path, 'offset'), 0, DSL_LIMITS.maxOffset);
    if (this.errors.length > before || offset === null) return null;
    return {
      k: 'ind',
      offset,
      spec: {
        name: name as DslIndicatorName,
        period: ints.period ?? 0,
        fast: ints.fast ?? 0,
        slow: ints.slow ?? 0,
        signal: ints.signal ?? 0,
        stdDev,
        output,
        source,
      },
    };
  }

  rule(raw: unknown, path: string, depth: number): RuleAst | null {
    if (!this.count(path, depth)) return null;
    if (!isObj(raw)) return this.err(path, 'INVALID_TYPE', 'rule must be an object');
    const keys = Object.keys(raw);
    if (keys.length !== 1) {
      return this.err(
        path,
        keys.length === 0 ? 'MISSING_FIELD' : 'UNKNOWN_KEY',
        `rule must have exactly one operator key, got [${keys.join(', ')}]`,
      );
    }
    const op = keys[0] as string;
    const p = keyPath(path, op);
    const body = raw[op];
    if (!RULE_OPS.includes(op))
      return this.err(
        p,
        'UNKNOWN_OPERATOR',
        `unknown operator "${op}"; expected one of ${RULE_OPS.join(', ')}`,
      );
    if (op === 'all' || op === 'any') {
      if (!Array.isArray(body)) return this.err(p, 'INVALID_TYPE', `${op} expects an array of rules`);
      if (body.length === 0) return this.err(p, 'ARITY', `${op} needs at least one rule`);
      const rules = body.map((r, i) => this.rule(r, idxPath(p, i), depth + 1));
      return rules.some((r) => r === null) ? null : { k: op, path, rules: rules as RuleAst[] };
    }
    if (op === 'not') {
      const r = this.rule(body, p, depth + 1);
      return r === null ? null : { k: 'not', path, rule: r };
    }
    if (COMPARISONS.includes(op)) {
      const t = this.tuple(body, 2, p);
      if (!t) return null;
      const a = this.operand(t[0], idxPath(p, 0), depth + 1);
      const b = this.operand(t[1], idxPath(p, 1), depth + 1);
      return a && b ? { k: 'cmp', path, op: op as DslComparisonOp, a, b } : null;
    }
    if (op === 'between') {
      const t = this.tuple(body, 3, p);
      if (!t) return null;
      const [x, lo, hi] = [0, 1, 2].map((i) => this.operand(t[i], idxPath(p, i), depth + 1));
      return x && lo && hi ? { k: 'between', path, x, lo, hi } : null;
    }
    if (op === 'crossesAbove' || op === 'crossesBelow') {
      const t = this.tuple(body, 2, p);
      if (!t) return null;
      const a = this.operand(t[0], idxPath(p, 0), depth + 1);
      const b = this.operand(t[1], idxPath(p, 1), depth + 1);
      return a && b ? { k: 'cross', path, dir: op === 'crossesAbove' ? 'above' : 'below', a, b } : null;
    }
    // rising / falling
    const t = this.tuple(body, 2, p);
    if (!t) return null;
    const a = this.operand(t[0], idxPath(p, 0), depth + 1);
    const n = this.int(t[1], idxPath(p, 1), 1, DSL_LIMITS.maxLookbackBars);
    return a && n !== null ? { k: 'trend', path, dir: op === 'rising' ? 'rising' : 'falling', a, n } : null;
  }
}

export type RuleParseResult = { ok: true; ast: RuleAst } | { ok: false; errors: DslError[] };

/** Validate a rule JSON (and resolve `$param` references) into the internal AST. Never throws. */
export function parseRule(json: unknown, params: StrategyParams = {}, rootPath = '$'): RuleParseResult {
  const v = new Validator(params);
  const ast = v.rule(json, rootPath, 0);
  if (ast === null || v.errors.length > 0) {
    return {
      ok: false,
      errors:
        v.errors.length > 0 ? v.errors : [{ path: rootPath, code: 'INVALID_TYPE', message: 'invalid rule' }],
    };
  }
  return { ok: true, ast };
}

/** Validate a rule; returns all errors with JSON paths (empty array = valid). */
export function validateRule(json: unknown, params: StrategyParams = {}, rootPath = '$'): DslError[] {
  const r = parseRule(json, params, rootPath);
  return r.ok ? [] : r.errors;
}
