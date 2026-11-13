/**
 * Rule DSL compiler + evaluator.
 *
 * A set of rules is compiled ONCE into a `CompiledRules` object (validated AST + shared operand graph plan).
 * `createEvaluator()` then yields an independent stateful evaluator that consumes bars strictly in time order
 * (`update(bar, position)`), keeping streaming indicator state and a bounded per-operand history, so evaluation
 * at bar t can only ever see bars 0..t (no look-ahead by construction).
 */
import { type Decimal, fromInt, pct, round, sum, ZERO } from '../decimal.js';
import { at, maxInt } from '../indicators/internal.js';
import { AtrIndicator, BollingerIndicator, type BollingerValue } from '../indicators/volatility.js';
import { EmaIndicator, SmaIndicator, VolumeSmaIndicator, WmaIndicator } from '../indicators/moving-averages.js';
import { MacdIndicator, type MacdValue, RocIndicator, RsiIndicator } from '../indicators/oscillators.js';
import { HighestIndicator, LowestIndicator } from '../indicators/rolling.js';
import { type OhlcvBar, type StreamingIndicator } from '../indicators/types.js';
import {
  type DslComparisonOp,
  type DslError,
  type IndicatorSpecResolved,
  type OperandAst,
  parseRule,
  type RuleAst,
  RuleValidationError,
  type StrategyParams,
} from './dsl.js';
import { type StrategyPosition } from './types.js';

// ───────────────────────────── trace types ─────────────────────────────

export interface RuleTraceOperand {
  readonly label: string;
  /** Value at the evaluated bar (full precision string) or null when unavailable. */
  readonly value: string | null;
  /** For crosses / rising / falling: values oldest -> newest (last element = current bar). */
  readonly history?: readonly (string | null)[];
}

export type RuleTraceKind =
  | 'all'
  | 'any'
  | 'not'
  | DslComparisonOp
  | 'between'
  | 'crossesAbove'
  | 'crossesBelow'
  | 'rising'
  | 'falling';

export interface RuleTraceEntry {
  /** JSON path of the condition inside the rule document. */
  readonly path: string;
  readonly kind: RuleTraceKind;
  readonly result: boolean;
  readonly operands: readonly RuleTraceOperand[];
  /** Human-readable explanation, e.g. "EMA(9)=251.2 crossed above EMA(21)=250.85 -> true". */
  readonly text: string;
}

export interface RuleEvaluation {
  readonly result: boolean;
  /** True once every operand of the rule has enough history (warm-up complete). */
  readonly warm: boolean;
  readonly trace: readonly RuleTraceEntry[];
}

// ───────────────────────────── operand graph ─────────────────────────────

interface StepContext {
  readonly bar: OhlcvBar;
  readonly prevClose: Decimal | null;
  readonly position: StrategyPosition | null;
}

interface SeriesNode {
  readonly key: string;
  readonly label: string;
  /** Bars needed before this node can first be non-null. */
  readonly warmup: number;
  keep: number;
  readonly hist: (Decimal | null)[];
  compute(ctx: StepContext): Decimal | null;
}

type AnyIndicator = StreamingIndicator<Decimal> | StreamingIndicator<MacdValue> | StreamingIndicator<BollingerValue>;

const ARITH_SYMBOL = { add: '+', sub: '-', mul: '*', div: '/' } as const;

function indicatorKey(s: IndicatorSpecResolved): string {
  return `${s.name}|${s.source ?? '-'}|${s.period}|${s.fast}|${s.slow}|${s.signal}|${s.name === 'BB' ? s.stdDev.toString() : '-'}`;
}

function indicatorLabel(s: IndicatorSpecResolved): string {
  const defaultSource = s.name === 'HIGHEST' ? 'high' : s.name === 'LOWEST' ? 'low' : 'close';
  const src = s.source !== null && s.source !== defaultSource ? `,${s.source}` : '';
  switch (s.name) {
    case 'MACD':
      return `MACD(${s.fast},${s.slow},${s.signal}${src})${s.output === 'line' ? '' : `.${s.output}`}`;
    case 'BB':
      return `BB(${s.period},${s.stdDev.toString()}${src}).${s.output}`;
    default:
      return `${s.name}(${s.period}${src})`;
  }
}

function makeIndicator(s: IndicatorSpecResolved): AnyIndicator {
  const src = s.source ?? 'close';
  switch (s.name) {
    case 'SMA':
      return new SmaIndicator(s.period, src);
    case 'EMA':
      return new EmaIndicator(s.period, src);
    case 'WMA':
      return new WmaIndicator(s.period, src);
    case 'RSI':
      return new RsiIndicator(s.period, src);
    case 'ROC':
      return new RocIndicator(s.period, src);
    case 'MACD':
      return new MacdIndicator(s.fast, s.slow, s.signal, src);
    case 'ATR':
      return new AtrIndicator(s.period);
    case 'BB':
      return new BollingerIndicator(s.period, s.stdDev, src);
    case 'HIGHEST':
      return new HighestIndicator(s.period, src);
    case 'LOWEST':
      return new LowestIndicator(s.period, src);
    case 'VOLUME_SMA':
      return new VolumeSmaIndicator(s.period);
  }
}

function selectOutput(s: IndicatorSpecResolved, v: unknown): Decimal | null {
  if (v === null || v === undefined) return null;
  if (s.name === 'MACD') {
    const m = v as MacdValue;
    return s.output === 'signal' ? m.signal : s.output === 'histogram' ? m.histogram : m.macd;
  }
  if (s.name === 'BB') {
    const b = v as BollingerValue;
    return s.output === 'upper' ? b.upper : s.output === 'lower' ? b.lower : b.middle;
  }
  return v as Decimal;
}

/** Plan of nodes (shared across evaluators); `instantiate` builds fresh mutable state. */
interface NodePlan {
  readonly key: string;
  readonly label: string;
  readonly warmup: number;
  keep: number;
  readonly build: (graph: SeriesGraph) => (ctx: StepContext) => Decimal | null;
}

class GraphPlan {
  readonly nodes: NodePlan[] = [];
  readonly byKey = new Map<string, NodePlan>();
  readonly indicatorSpecs = new Map<string, IndicatorSpecResolved>();

  private add(plan: Omit<NodePlan, 'keep'>): NodePlan {
    const existing = this.byKey.get(plan.key);
    if (existing) return existing;
    const p: NodePlan = { ...plan, keep: 1 };
    this.nodes.push(p);
    this.byKey.set(p.key, p);
    return p;
  }

  requireBack(node: NodePlan, back: number): void {
    node.keep = maxInt(node.keep, back + 1);
  }

  operand(o: OperandAst): NodePlan {
    switch (o.k) {
      case 'const':
        return this.add({ key: `const:${o.value.toString()}`, label: o.value.toString(), warmup: 1, build: () => () => o.value });
      case 'pos': {
        const f = o.field;
        return this.add({
          key: `pos:${f}`,
          label: `position.${f}`,
          warmup: 1,
          build: () => (ctx) => positionValue(f, ctx.position, ctx.bar.close),
        });
      }
      case 'field': {
        const f = o.field;
        const base = this.add({
          key: `field:${f}`,
          label: f,
          warmup: f === 'changePct' ? 2 : 1,
          build: () => (ctx) =>
            f === 'changePct' ? (ctx.prevClose === null ? null : pct(ctx.bar.close.minus(ctx.prevClose), ctx.prevClose)) : ctx.bar[f],
        });
        return o.offset === 0 ? base : this.offset(base, o.offset);
      }
      case 'ind': {
        const ikey = indicatorKey(o.spec);
        this.indicatorSpecs.set(ikey, o.spec);
        const spec = o.spec;
        const warm = makeIndicator(spec).warmupBars;
        const base = this.add({
          key: `ind:${ikey}:${spec.output}`,
          label: indicatorLabel(spec),
          warmup: warm,
          build: (g) => () => selectOutput(spec, g.indicatorValue(ikey)),
        });
        return o.offset === 0 ? base : this.offset(base, o.offset);
      }
      case 'arith': {
        const kids = o.args.map((a) => this.operand(a));
        const op = o.op;
        return this.add({
          key: `${op}(${kids.map((k) => k.key).join(',')})`,
          label: `(${kids.map((k) => k.label).join(` ${ARITH_SYMBOL[op]} `)})`,
          warmup: maxInt(...kids.map((k) => k.warmup)),
          build: (g) => {
            const nodes = kids.map((k) => g.node(k.key));
            return () => {
              const vals = nodes.map((n) => g.current(n));
              if (vals.some((v) => v === null)) return null;
              const xs = vals as Decimal[];
              const first = at(xs, 0);
              switch (op) {
                case 'add':
                  return sum(xs);
                case 'mul':
                  return xs.slice(1).reduce((acc, x) => acc.times(x), first);
                case 'sub':
                  return first.minus(at(xs, 1));
                case 'div': {
                  const den = at(xs, 1);
                  return den.isZero() ? null : first.div(den);
                }
              }
            };
          },
        });
      }
    }
  }

  private offset(base: NodePlan, k: number): NodePlan {
    this.requireBack(base, k);
    return this.add({
      key: `off:${k}:${base.key}`,
      label: `${base.label}[${k}]`,
      warmup: base.warmup + k,
      build: (g) => {
        const n = g.node(base.key);
        return () => g.back(n, k);
      },
    });
  }
}

function positionValue(f: string, pos: StrategyPosition | null, close: Decimal): Decimal | null {
  const open = pos !== null && pos.qty.gt(0);
  switch (f) {
    case 'qty':
      return open ? pos.qty : ZERO;
    case 'barsHeld':
      return open ? fromInt(pos.barsHeld) : ZERO;
    case 'avgCost':
      return open ? pos.avgCost : null;
    case 'highSinceEntry':
      return open ? pos.highSinceEntry : null;
    case 'unrealizedPct':
      return open ? pct(close.minus(pos.avgCost), pos.avgCost) : null;
    default:
      return null;
  }
}

/** Mutable per-evaluator state. */
class SeriesGraph {
  private readonly nodes: SeriesNode[] = [];
  private readonly nodeByKey = new Map<string, SeriesNode>();
  private readonly computes: ((ctx: StepContext) => Decimal | null)[] = [];
  private readonly indicators = new Map<string, AnyIndicator>();
  private readonly indicatorValues = new Map<string, unknown>();
  private prevClose: Decimal | null = null;
  barsSeen = 0;

  constructor(plan: GraphPlan) {
    for (const [k, spec] of plan.indicatorSpecs) this.indicators.set(k, makeIndicator(spec));
    for (const p of plan.nodes) {
      const n: SeriesNode = { key: p.key, label: p.label, warmup: p.warmup, keep: p.keep, hist: [], compute: () => null };
      this.nodes.push(n);
      this.nodeByKey.set(p.key, n);
    }
    // build closures after every node exists (children are always registered before parents)
    plan.nodes.forEach((p) => this.computes.push(p.build(this)));
  }

  node(key: string): SeriesNode {
    const n = this.nodeByKey.get(key);
    if (!n) throw new Error(`internal: unknown node ${key}`);
    return n;
  }
  indicatorValue(key: string): unknown {
    return this.indicatorValues.get(key) ?? null;
  }
  current(n: SeriesNode): Decimal | null {
    return this.back(n, 0);
  }
  back(n: SeriesNode, k: number): Decimal | null {
    const i = n.hist.length - 1 - k;
    return i >= 0 ? (n.hist[i] ?? null) : null;
  }

  step(bar: OhlcvBar, position: StrategyPosition | null): void {
    for (const [k, ind] of this.indicators) this.indicatorValues.set(k, ind.update(bar));
    const ctx: StepContext = { bar, prevClose: this.prevClose, position };
    this.nodes.forEach((n, i) => {
      const fn = at(this.computes, i);
      n.hist.push(fn(ctx));
      if (n.hist.length > n.keep) n.hist.shift();
    });
    this.prevClose = bar.close;
    this.barsSeen++;
  }
}

// ───────────────────────────── conditions ─────────────────────────────

interface CondPlan {
  readonly requiredBars: number;
  readonly build: (g: SeriesGraph) => (trace: RuleTraceEntry[]) => boolean;
}

const fmtFull = (x: Decimal | null): string | null => (x === null ? null : x.toString());
const fmtShort = (x: Decimal | null): string => (x === null ? 'n/a' : round(x, 4).toString());

function compare(op: DslComparisonOp, a: Decimal, b: Decimal): boolean {
  switch (op) {
    case 'gt':
      return a.gt(b);
    case 'gte':
      return a.gte(b);
    case 'lt':
      return a.lt(b);
    case 'lte':
      return a.lte(b);
    case 'eq':
      return a.eq(b);
  }
}
const OP_SYMBOL: Record<DslComparisonOp, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=' };

function planCondition(plan: GraphPlan, r: RuleAst): CondPlan {
  switch (r.k) {
    case 'all':
    case 'any': {
      const kids = r.rules.map((c) => planCondition(plan, c));
      const kind = r.k;
      return {
        requiredBars: maxInt(...kids.map((k) => k.requiredBars)),
        build: (g) => {
          const fns = kids.map((k) => k.build(g));
          return (trace) => {
            const idx = trace.length;
            trace.push(null as unknown as RuleTraceEntry); // placeholder, parent precedes children
            // No short-circuit: every condition is evaluated so the trace is complete.
            const results = fns.map((f) => f(trace));
            const ok = kind === 'all' ? results.every(Boolean) : results.some(Boolean);
            const nTrue = results.filter(Boolean).length;
            trace[idx] = {
              path: r.path,
              kind,
              result: ok,
              operands: [],
              text: `${kind.toUpperCase()} (${nTrue}/${results.length} true) -> ${String(ok)}`,
            };
            return ok;
          };
        },
      };
    }
    case 'not': {
      const kid = planCondition(plan, r.rule);
      return {
        requiredBars: kid.requiredBars,
        build: (g) => {
          const f = kid.build(g);
          return (trace) => {
            const idx = trace.length;
            trace.push(null as unknown as RuleTraceEntry);
            const ok = !f(trace);
            trace[idx] = { path: r.path, kind: 'not', result: ok, operands: [], text: `NOT -> ${String(ok)}` };
            return ok;
          };
        },
      };
    }
    case 'cmp': {
      const a = plan.operand(r.a);
      const b = plan.operand(r.b);
      return {
        requiredBars: maxInt(a.warmup, b.warmup),
        build: (g) => {
          const na = g.node(a.key);
          const nb = g.node(b.key);
          return (trace) => {
            const va = g.current(na);
            const vb = g.current(nb);
            const ok = va !== null && vb !== null && compare(r.op, va, vb);
            trace.push({
              path: r.path,
              kind: r.op,
              result: ok,
              operands: [
                { label: a.label, value: fmtFull(va) },
                { label: b.label, value: fmtFull(vb) },
              ],
              text: `${a.label}=${fmtShort(va)} ${OP_SYMBOL[r.op]} ${b.label}=${fmtShort(vb)} -> ${String(ok)}`,
            });
            return ok;
          };
        },
      };
    }
    case 'between': {
      const x = plan.operand(r.x);
      const lo = plan.operand(r.lo);
      const hi = plan.operand(r.hi);
      return {
        requiredBars: maxInt(x.warmup, lo.warmup, hi.warmup),
        build: (g) => {
          const [nx, nl, nh] = [x, lo, hi].map((p) => g.node(p.key)) as [SeriesNode, SeriesNode, SeriesNode];
          return (trace) => {
            const vx = g.current(nx);
            const vl = g.current(nl);
            const vh = g.current(nh);
            const ok = vx !== null && vl !== null && vh !== null && vx.gte(vl) && vx.lte(vh);
            trace.push({
              path: r.path,
              kind: 'between',
              result: ok,
              operands: [
                { label: x.label, value: fmtFull(vx) },
                { label: lo.label, value: fmtFull(vl) },
                { label: hi.label, value: fmtFull(vh) },
              ],
              text: `${lo.label}=${fmtShort(vl)} <= ${x.label}=${fmtShort(vx)} <= ${hi.label}=${fmtShort(vh)} -> ${String(ok)}`,
            });
            return ok;
          };
        },
      };
    }
    case 'cross': {
      const a = plan.operand(r.a);
      const b = plan.operand(r.b);
      plan.requireBack(a, 1);
      plan.requireBack(b, 1);
      const above = r.dir === 'above';
      return {
        requiredBars: maxInt(a.warmup, b.warmup) + 1,
        build: (g) => {
          const na = g.node(a.key);
          const nb = g.node(b.key);
          return (trace) => {
            const a0 = g.back(na, 1);
            const a1 = g.current(na);
            const b0 = g.back(nb, 1);
            const b1 = g.current(nb);
            const ok =
              a0 !== null &&
              a1 !== null &&
              b0 !== null &&
              b1 !== null &&
              (above ? a0.lte(b0) && a1.gt(b1) : a0.gte(b0) && a1.lt(b1));
            trace.push({
              path: r.path,
              kind: above ? 'crossesAbove' : 'crossesBelow',
              result: ok,
              operands: [
                { label: a.label, value: fmtFull(a1), history: [fmtFull(a0), fmtFull(a1)] },
                { label: b.label, value: fmtFull(b1), history: [fmtFull(b0), fmtFull(b1)] },
              ],
              text: `${a.label} ${fmtShort(a0)}->${fmtShort(a1)} crosses ${above ? 'above' : 'below'} ${b.label} ${fmtShort(b0)}->${fmtShort(b1)} -> ${String(ok)}`,
            });
            return ok;
          };
        },
      };
    }
    case 'trend': {
      const a = plan.operand(r.a);
      plan.requireBack(a, r.n);
      const rising = r.dir === 'rising';
      const n = r.n;
      return {
        requiredBars: a.warmup + n,
        build: (g) => {
          const na = g.node(a.key);
          return (trace) => {
            const vals: (Decimal | null)[] = [];
            for (let k = n; k >= 0; k--) vals.push(g.back(na, k));
            let ok = vals.every((v) => v !== null);
            for (let i = 1; ok && i < vals.length; i++) {
              const prev = vals[i - 1] as Decimal;
              const cur = vals[i] as Decimal;
              ok = rising ? cur.gt(prev) : cur.lt(prev);
            }
            trace.push({
              path: r.path,
              kind: rising ? 'rising' : 'falling',
              result: ok,
              operands: [{ label: a.label, value: fmtFull(g.current(na)), history: vals.map(fmtFull) }],
              text: `${a.label} ${rising ? 'rising' : 'falling'} over ${n} bar(s): ${vals.map(fmtShort).join(', ')} -> ${String(ok)}`,
            });
            return ok;
          };
        },
      };
    }
  }
}

// ───────────────────────────── public compile API ─────────────────────────────

/** Rules compiled once (immutable). Create one evaluator per independent bar stream. */
export interface CompiledRules<K extends string = string> {
  readonly names: readonly K[];
  /** Bars required before every operand of the named rule is warm. */
  readonly requiredBars: Readonly<Record<K, number>>;
  /** Max of requiredBars over all rules. */
  readonly warmupBars: number;
  createEvaluator(): RulesEvaluator<K>;
}

export interface RulesEvaluator<K extends string = string> {
  /** Advance by one bar (strictly chronological). `position` is the position as of this bar's close. */
  update(bar: OhlcvBar, position?: StrategyPosition | null): void;
  /** Evaluate the named rule at the most recent bar. */
  evaluate(name: K): RuleEvaluation;
  readonly barsSeen: number;
}

export type CompileRulesResult<K extends string> = { ok: true; compiled: CompiledRules<K> } | { ok: false; errors: DslError[] };

/**
 * Validate and compile several named rules over one shared operand graph (indicators are computed once).
 * Error paths are prefixed with `$.<name>`.
 */
export function tryCompileRules<K extends string>(rules: Readonly<Record<K, unknown>>, params: StrategyParams = {}): CompileRulesResult<K> {
  const names = Object.keys(rules) as K[];
  const errors: DslError[] = [];
  const asts = new Map<K, RuleAst>();
  for (const name of names) {
    const res = parseRule(rules[name], params, `$.${name}`);
    if (res.ok) asts.set(name, res.ast);
    else errors.push(...res.errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  const plan = new GraphPlan();
  const conds = new Map<K, CondPlan>();
  for (const name of names) conds.set(name, planCondition(plan, asts.get(name) as RuleAst));
  const requiredBars = {} as Record<K, number>;
  for (const name of names) requiredBars[name] = (conds.get(name) as CondPlan).requiredBars;
  const warmupBars = maxInt(0, ...names.map((n) => requiredBars[n]));

  const compiled: CompiledRules<K> = {
    names,
    requiredBars,
    warmupBars,
    createEvaluator(): RulesEvaluator<K> {
      const graph = new SeriesGraph(plan);
      const fns = new Map<K, (trace: RuleTraceEntry[]) => boolean>();
      for (const name of names) fns.set(name, (conds.get(name) as CondPlan).build(graph));
      return {
        get barsSeen() {
          return graph.barsSeen;
        },
        update(bar, position = null) {
          graph.step(bar, position);
        },
        evaluate(name) {
          const fn = fns.get(name);
          if (!fn) throw new Error(`unknown rule "${name}"`);
          const trace: RuleTraceEntry[] = [];
          const result = graph.barsSeen > 0 && fn(trace);
          return { result, warm: graph.barsSeen >= requiredBars[name], trace };
        },
      };
    },
  };
  return { ok: true, compiled };
}

/** Like `tryCompileRules` but throws `RuleValidationError`. */
export function compileRules<K extends string>(rules: Readonly<Record<K, unknown>>, params: StrategyParams = {}): CompiledRules<K> {
  const r = tryCompileRules(rules, params);
  if (!r.ok) throw new RuleValidationError(r.errors);
  return r.compiled;
}

/**
 * Convenience: evaluate a single rule at every bar. `positions[i]` (optional) is the position at bar i's close.
 * Result i depends only on bars[0..i].
 */
export function evaluateRuleOverBars(
  rule: unknown,
  bars: readonly OhlcvBar[],
  params: StrategyParams = {},
  positions?: readonly (StrategyPosition | null)[],
): RuleEvaluation[] {
  const ev = compileRules({ rule }, params).createEvaluator();
  return bars.map((b, i) => {
    ev.update(b, positions?.[i] ?? null);
    return ev.evaluate('rule');
  });
}
