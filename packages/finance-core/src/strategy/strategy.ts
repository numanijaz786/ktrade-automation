/**
 * Strategy evaluator (docs/08 §3–4). Long-only, at most one signal per bar, evaluated at the bar CLOSE.
 *
 * Per bar t (position = the caller's position as of bar t's close):
 *  - in a position: overlays first, in priority STOP_LOSS → TRAILING_STOP → TAKE_PROFIT, then the exit rule.
 *    Overlays are protective and active as soon as a position exists (even during indicator warm-up);
 *    rule-based signals require the whole strategy to be warm.
 *  - flat: entry rule, unless within the cooldown window.
 * Cooldown: after the position goes from open to flat at bar f, entries are suppressed for bars f .. f+cooldownBars-1.
 */
import { d, type Decimal, type DecimalInput, HUNDRED, ONE, round } from '../decimal.js';
import { type OhlcvBar } from '../indicators/types.js';
import { type DslError, type StrategyParams } from './dsl.js';
import { type CompiledRules, type RuleEvaluation, type RulesEvaluator, tryCompileRules } from './engine.js';
import { type SignalScore, type SignalScoreConfig, SignalScorer } from './scoring.js';
import { type StrategyPosition, type StrategySignalReason, type StrategySignalType, type TradeSide } from './types.js';

export interface StrategyDefinition {
  /** Rule DSL document (docs/08 §3) or null/undefined for "no rule-based entries". */
  readonly entryRules?: unknown;
  readonly exitRules?: unknown;
  /** Values for `$param` references. */
  readonly parameters?: StrategyParams;
  /** Overlays, in percent (5 = 5%). */
  readonly stopLossPct?: DecimalInput | null;
  readonly takeProfitPct?: DecimalInput | null;
  readonly trailingStopPct?: DecimalInput | null;
  readonly cooldownBars?: number;
  /** Reason tagged on rule-based entries (default RULE_ENTRY; PRICE_ALERT uses PRICE_TARGET). */
  readonly entryReason?: StrategySignalReason;
  /** Reason tagged on rule-based exits (default RULE_EXIT). */
  readonly exitReason?: StrategySignalReason;
  /** Score configuration overrides. */
  readonly scoring?: Partial<SignalScoreConfig>;
}

export type OverlayKind = 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT';

export interface OverlayTraceEntry {
  readonly kind: OverlayKind;
  readonly pct: string;
  /** Trigger price level. */
  readonly threshold: string;
  readonly close: string;
  readonly triggered: boolean;
  readonly text: string;
}

export interface StrategySignalTrace {
  /** Evaluation of the rule that produced (or was evaluated for) this signal; null for overlay exits that pre-empted it. */
  readonly rule: RuleEvaluation | null;
  readonly overlays: readonly OverlayTraceEntry[];
  readonly summary: string;
}

export interface StrategySignal {
  readonly type: StrategySignalType;
  readonly reason: StrategySignalReason;
  readonly side: TradeSide;
  readonly ts: string;
  readonly barIndex: number;
  /** Close of the signal bar. */
  readonly price: Decimal;
  readonly trace: StrategySignalTrace;
  readonly score: SignalScore;
}

export interface CompiledStrategy {
  readonly definition: StrategyDefinition;
  readonly rules: CompiledRules<'entryRules' | 'exitRules'>;
  readonly hasEntryRules: boolean;
  readonly hasExitRules: boolean;
  readonly stopLossPct: Decimal | null;
  readonly takeProfitPct: Decimal | null;
  readonly trailingStopPct: Decimal | null;
  readonly cooldownBars: number;
  /** Bars needed before rule-based signals can fire. */
  readonly warmupBars: number;
  createRunner(options?: StrategyRunnerOptions): StrategyRunner;
}

export class StrategyValidationError extends Error {
  constructor(readonly errors: readonly DslError[]) {
    super(`Invalid strategy: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'StrategyValidationError';
  }
}

const isSet = (x: unknown): boolean => x !== undefined && x !== null;
const DEC = /^\d+(\.\d+)?$/;

function overlayPct(raw: DecimalInput | null | undefined, path: string, maxExclusive: Decimal | null, errors: DslError[]): Decimal | null {
  if (raw === undefined || raw === null) return null;
  let v: Decimal;
  try {
    if (typeof raw === 'string' && !DEC.test(raw.trim())) throw new Error();
    v = d(raw);
  } catch {
    errors.push({ path, code: 'INVALID_VALUE', message: 'must be a positive decimal percentage' });
    return null;
  }
  if (!v.gt(0) || (maxExclusive !== null && !v.lt(maxExclusive))) {
    errors.push({ path, code: 'OUT_OF_RANGE', message: `must be > 0${maxExclusive ? ` and < ${maxExclusive.toString()}` : ''}` });
    return null;
  }
  return v;
}

export type CompileStrategyResult = { ok: true; strategy: CompiledStrategy } | { ok: false; errors: DslError[] };

export function tryCompileStrategy(def: StrategyDefinition): CompileStrategyResult {
  const errors: DslError[] = [];
  const rules: Partial<Record<'entryRules' | 'exitRules', unknown>> = {};
  if (isSet(def.entryRules)) rules.entryRules = def.entryRules;
  if (isSet(def.exitRules)) rules.exitRules = def.exitRules;
  const compiled = tryCompileRules(rules as Record<'entryRules' | 'exitRules', unknown>, def.parameters ?? {});
  if (!compiled.ok) errors.push(...compiled.errors);
  const sl = overlayPct(def.stopLossPct, '$.stopLossPct', HUNDRED, errors);
  const tp = overlayPct(def.takeProfitPct, '$.takeProfitPct', null, errors);
  const ts = overlayPct(def.trailingStopPct, '$.trailingStopPct', HUNDRED, errors);
  const cooldown = def.cooldownBars ?? 0;
  if (!Number.isSafeInteger(cooldown) || cooldown < 0) {
    errors.push({ path: '$.cooldownBars', code: 'OUT_OF_RANGE', message: 'must be an integer >= 0' });
  }
  if (errors.length > 0 || !compiled.ok) return { ok: false, errors };
  const strategy: CompiledStrategy = {
    definition: def,
    rules: compiled.compiled,
    hasEntryRules: 'entryRules' in rules,
    hasExitRules: 'exitRules' in rules,
    stopLossPct: sl,
    takeProfitPct: tp,
    trailingStopPct: ts,
    cooldownBars: cooldown,
    warmupBars: compiled.compiled.warmupBars,
    createRunner: (options) => new StrategyRunner(strategy, options),
  };
  return { ok: true, strategy };
}

/** Validate + compile once; throws StrategyValidationError with JSON-path errors. */
export function compileStrategy(def: StrategyDefinition): CompiledStrategy {
  const r = tryCompileStrategy(def);
  if (!r.ok) throw new StrategyValidationError(r.errors);
  return r.strategy;
}

export interface StrategyRunnerOptions {
  /**
   * Bar index (in this runner's own numbering, may be negative) at which the position last went flat.
   * Lets a fresh runner honour a cooldown that began before its first bar.
   */
  readonly lastFlatBarIndex?: number | null;
}

const isOpen = (p: StrategyPosition | null | undefined): p is StrategyPosition => p !== null && p !== undefined && p.qty.gt(0);
const fmt = (x: Decimal): string => round(x, 4).toString();

/** Stateful, incremental strategy evaluation over one symbol's bar stream. */
export class StrategyRunner {
  private readonly ev: RulesEvaluator<'entryRules' | 'exitRules'>;
  private readonly scorer: SignalScorer;
  private index = -1;
  private wasOpen = false;
  private lastFlatIndex: number | null;

  constructor(
    readonly strategy: CompiledStrategy,
    options: StrategyRunnerOptions = {},
  ) {
    this.ev = strategy.rules.createEvaluator();
    this.scorer = new SignalScorer(strategy.definition.scoring);
    this.lastFlatIndex = options.lastFlatBarIndex ?? null;
  }

  get barsSeen(): number {
    return this.index + 1;
  }
  /** True once rule-based signals are allowed. */
  get warm(): boolean {
    return this.barsSeen >= this.strategy.warmupBars;
  }

  /** Feed bar t (chronological) with the position as of its close; returns at most one signal. */
  onBar(bar: OhlcvBar, position: StrategyPosition | null): StrategySignal | null {
    this.index++;
    const open = isOpen(position);
    if (this.wasOpen && !open) this.lastFlatIndex = this.index;
    this.wasOpen = open;
    this.ev.update(bar, open ? position : null);
    this.scorer.update(bar);
    const s = this.strategy;
    const make = (type: StrategySignalType, reason: StrategySignalReason, trace: StrategySignalTrace): StrategySignal => ({
      type,
      reason,
      side: type === 'ENTRY' ? 'BUY' : 'SELL',
      ts: bar.ts,
      barIndex: this.index,
      price: bar.close,
      trace,
      score: this.scorer.score(type),
    });

    if (open) {
      const overlays = this.overlays(bar, position);
      const hit = overlays.find((o) => o.triggered);
      if (hit) return make('EXIT', hit.kind, { rule: null, overlays, summary: hit.text });
      if (s.hasExitRules && this.warm) {
        const rule = this.ev.evaluate('exitRules');
        if (rule.result) {
          return make('EXIT', s.definition.exitReason ?? 'RULE_EXIT', {
            rule,
            overlays,
            summary: rule.trace.map((t) => t.text).join('; '),
          });
        }
      }
      return null;
    }
    if (!s.hasEntryRules || !this.warm) return null;
    if (this.lastFlatIndex !== null && this.index - this.lastFlatIndex < s.cooldownBars) return null;
    const rule = this.ev.evaluate('entryRules');
    if (!rule.result) return null;
    return make('ENTRY', s.definition.entryReason ?? 'RULE_ENTRY', {
      rule,
      overlays: [],
      summary: rule.trace.map((t) => t.text).join('; '),
    });
  }

  /** Overlay checks in exit-priority order. */
  private overlays(bar: OhlcvBar, p: StrategyPosition): OverlayTraceEntry[] {
    const s = this.strategy;
    const out: OverlayTraceEntry[] = [];
    const close = bar.close;
    const push = (kind: OverlayKind, pctV: Decimal, threshold: Decimal, triggered: boolean, rel: string, base: string): void => {
      out.push({
        kind,
        pct: pctV.toString(),
        threshold: threshold.toString(),
        close: close.toString(),
        triggered,
        text: `${kind}: close=${fmt(close)} ${rel} ${base} -> ${String(triggered)}`,
      });
    };
    if (s.stopLossPct) {
      const th = p.avgCost.times(ONE.minus(s.stopLossPct.div(HUNDRED)));
      push('STOP_LOSS', s.stopLossPct, th, close.lte(th), '<=', `avgCost ${fmt(p.avgCost)} x (1 - ${s.stopLossPct.toString()}%) = ${fmt(th)}`);
    }
    if (s.trailingStopPct) {
      const th = p.highSinceEntry.times(ONE.minus(s.trailingStopPct.div(HUNDRED)));
      push('TRAILING_STOP', s.trailingStopPct, th, close.lte(th), '<=', `highSinceEntry ${fmt(p.highSinceEntry)} x (1 - ${s.trailingStopPct.toString()}%) = ${fmt(th)}`);
    }
    if (s.takeProfitPct) {
      const th = p.avgCost.times(ONE.plus(s.takeProfitPct.div(HUNDRED)));
      push('TAKE_PROFIT', s.takeProfitPct, th, close.gte(th), '>=', `avgCost ${fmt(p.avgCost)} x (1 + ${s.takeProfitPct.toString()}%) = ${fmt(th)}`);
    }
    return out;
  }
}

export interface EvaluateStrategyOptions {
  /** Position at each earlier bar's close (aligned with bars); defaults to flat history. */
  readonly positionHistory?: readonly (StrategyPosition | null)[];
  /** Bars elapsed since the position last went flat (0 = it went flat on the last bar). */
  readonly barsSinceLastExit?: number | null;
}

/**
 * Stateless convenience: evaluate the strategy at the LAST bar of `bars` (all bars <= t) given the current position.
 * Equivalent to replaying a fresh runner; prefer `StrategyRunner` for streaming use.
 */
export function evaluateStrategyAt(
  strategy: CompiledStrategy | StrategyDefinition,
  bars: readonly OhlcvBar[],
  position: StrategyPosition | null,
  options: EvaluateStrategyOptions = {},
): StrategySignal | null {
  if (bars.length === 0) return null;
  const compiled = 'createRunner' in strategy ? strategy : compileStrategy(strategy);
  const last = bars.length - 1;
  const since = options.barsSinceLastExit ?? null;
  const runner = compiled.createRunner({ lastFlatBarIndex: since === null ? null : last - since });
  let signal: StrategySignal | null = null;
  bars.forEach((b, i) => {
    const pos = i === last ? position : (options.positionHistory?.[i] ?? null);
    signal = runner.onBar(b, pos);
  });
  return signal;
}
