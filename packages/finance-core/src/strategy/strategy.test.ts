import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { d, type Decimal, fromInt, round } from '../decimal.js';
import { type OhlcvBar } from '../indicators/types.js';
import {
  buildTemplateStrategy,
  compileStrategy,
  evaluateStrategyAt,
  resolveTemplateParams,
  SignalScorer,
  sizePosition,
  STRATEGY_TEMPLATES,
  type StrategyPosition,
  StrategyValidationError,
  TemplateParamsError,
  templateParamSchema,
} from './index.js';

const mk = (close: string | number, i: number, high?: string, volume = '1000'): OhlcvBar => {
  const c = d(String(close));
  return {
    ts: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
    open: c,
    high: d(high ?? c.toString()),
    low: c,
    close: c,
    volume: d(volume),
  };
};
const series = (closes: (string | number)[]): OhlcvBar[] => closes.map((c, i) => mk(c, i));
const pos = (avgCost: string, high: string, qty = '10', barsHeld = 1): StrategyPosition => ({
  qty: d(qty),
  avgCost: d(avgCost),
  barsHeld,
  highSinceEntry: d(high),
});

describe('templates', () => {
  it('every built-in template exposes a schema and builds a compilable strategy with defaults', () => {
    for (const type of Object.keys(STRATEGY_TEMPLATES) as (keyof typeof STRATEGY_TEMPLATES)[]) {
      const schema = templateParamSchema(type);
      expect(schema.length).toBeGreaterThan(0);
      for (const p of schema) expect(p.description.length).toBeGreaterThan(0);
      const overrides: Record<string, string> = type === 'PRICE_ALERT' ? { targetPrice: '100' } : {};
      expect(() => compileStrategy(buildTemplateStrategy(type, overrides))).not.toThrow();
    }
  });

  it('defaults match docs/08', () => {
    const r = resolveTemplateParams('MA_CROSSOVER');
    expect(r).toEqual({ ok: true, params: { fastPeriod: 9, slowPeriod: 21, maType: 'EMA' } });
    expect(resolveTemplateParams('RSI')).toEqual({
      ok: true,
      params: { rsiPeriod: 14, oversold: '30', overbought: '70' },
    });
    expect(resolveTemplateParams('MACD')).toEqual({
      ok: true,
      params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, requireMacdAboveZero: false },
    });
    expect(resolveTemplateParams('STOP_LOSS')).toEqual({ ok: true, params: { stopLossPct: '5' } });
    expect(resolveTemplateParams('TAKE_PROFIT')).toEqual({ ok: true, params: { takeProfitPct: '10' } });
    expect(resolveTemplateParams('TRAILING_STOP')).toEqual({ ok: true, params: { trailingStopPct: '7' } });
  });

  it('validates parameters with paths', () => {
    const r = resolveTemplateParams('MA_CROSSOVER', {
      fastPeriod: 30,
      slowPeriod: 20,
      maType: 'HMA',
      junk: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => [e.path, e.code])).toEqual([
        ['$.parameters.junk', 'UNKNOWN_KEY'],
        ['$.parameters.maType', 'INVALID_VALUE'],
        ['$.parameters.slowPeriod', 'OUT_OF_RANGE'],
      ]);
    }
    expect(resolveTemplateParams('PRICE_ALERT').ok).toBe(false);
    expect(resolveTemplateParams('RSI', { oversold: '1.5e3' }).ok).toBe(false);
    expect(() => buildTemplateStrategy('STOP_LOSS', { stopLossPct: '0' })).toThrow(TemplateParamsError);
  });

  it('MA crossover (SMA 2/3) enters on the cross and exits on the reverse cross', () => {
    const s = compileStrategy(
      buildTemplateStrategy('MA_CROSSOVER', { fastPeriod: 2, slowPeriod: 3, maType: 'SMA' }),
    );
    const runner = s.createRunner();
    const bars = series([5, 4, 3, 4, 6, 7, 5, 3]);
    const out = bars.map((b, i) => runner.onBar(b, i >= 5 && i <= 7 ? pos('6', '7') : null));
    expect(out.map((x) => (x ? `${x.type}:${x.reason}` : null))).toEqual([
      null,
      null,
      null,
      null,
      'ENTRY:RULE_ENTRY',
      null,
      null,
      'EXIT:RULE_EXIT',
    ]);
    const entry = out[4]!;
    expect(entry.side).toBe('BUY');
    expect(entry.price.toString()).toBe('6');
    expect(entry.ts).toBe(bars[4]!.ts);
    expect(entry.trace.rule!.trace[0]!.kind).toBe('crossesAbove');
    expect(out[7]!.side).toBe('SELL');
  });

  it('MACD template with requireMacdAboveZero adds a condition; RSI template crosses', () => {
    const def = buildTemplateStrategy('MACD', { requireMacdAboveZero: true });
    expect(JSON.stringify(def.entryRules)).toContain('"all"');
    const rsi = compileStrategy(buildTemplateStrategy('RSI', { rsiPeriod: 2 }));
    // RSI(2) on 10,9,8,9: bar2 RSI=0, bar3 RSI=(1/2*... ) -> crosses above 30
    const r = rsi.createRunner();
    const sig = series([10, 9, 8, 9]).map((b) => r.onBar(b, null));
    expect(sig[3]?.type).toBe('ENTRY');
  });

  it('PRICE_ALERT entry and exit targets use reason PRICE_TARGET', () => {
    const s = compileStrategy(
      buildTemplateStrategy('PRICE_ALERT', {
        targetPrice: '100',
        exitTargetPrice: '90',
        exitDirection: 'BELOW',
      }),
    );
    expect(evaluateStrategyAt(s, series([99, 100]), null)?.reason).toBe('PRICE_TARGET');
    const exit = evaluateStrategyAt(s, series([99, 89]), pos('100', '100'));
    expect([exit?.type, exit?.reason]).toEqual(['EXIT', 'PRICE_TARGET']);
  });

  it('STOP_LOSS / TRAILING_STOP / TAKE_PROFIT templates are DSL exits tagged with their reason', () => {
    const sl = compileStrategy(buildTemplateStrategy('STOP_LOSS'));
    expect(evaluateStrategyAt(sl, series([95.01]), pos('100', '100'))).toBeNull();
    expect(evaluateStrategyAt(sl, series([95]), pos('100', '100'))?.reason).toBe('STOP_LOSS');
    const ts = compileStrategy(buildTemplateStrategy('TRAILING_STOP'));
    expect(evaluateStrategyAt(ts, series([93]), pos('80', '100'))?.reason).toBe('TRAILING_STOP');
    const tp = compileStrategy(buildTemplateStrategy('TAKE_PROFIT'));
    expect(evaluateStrategyAt(tp, series([110]), pos('100', '110'))?.reason).toBe('TAKE_PROFIT');
    expect(evaluateStrategyAt(tp, series([110]), null)).toBeNull();
  });
});

describe('strategy evaluator', () => {
  const always = { gt: [{ field: 'close' }, { const: '0' }] };

  it('exit priority: STOP_LOSS > TRAILING_STOP > TAKE_PROFIT > RULE_EXIT', () => {
    const base = { exitRules: always, stopLossPct: '5', trailingStopPct: '10', takeProfitPct: '10' };
    // all four true: close 50 <= 95 (SL), <= 200*0.9 (TS); TP false here, so test SL first
    expect(evaluateStrategyAt(base, series([50]), pos('100', '200'))?.reason).toBe('STOP_LOSS');
    // SL false, TS & TP & rule true: avgCost 100, high 200 -> TS level 180; close 150 >= 110 TP
    const sig = evaluateStrategyAt(base, series([150]), pos('100', '200'));
    expect(sig?.reason).toBe('TRAILING_STOP');
    expect(sig?.trace.overlays.map((o) => [o.kind, o.triggered])).toEqual([
      ['STOP_LOSS', false],
      ['TRAILING_STOP', true],
      ['TAKE_PROFIT', true],
    ]);
    expect(sig?.trace.rule).toBeNull();
    expect(evaluateStrategyAt(base, series([150]), pos('100', '150'))?.reason).toBe('TAKE_PROFIT');
    expect(evaluateStrategyAt(base, series([105]), pos('100', '105'))?.reason).toBe('RULE_EXIT');
  });

  it('overlay thresholds are inclusive and exact', () => {
    const s = compileStrategy({ stopLossPct: '5' });
    expect(evaluateStrategyAt(s, series(['95']), pos('100', '100'))?.trace.overlays[0]?.threshold).toBe('95');
    expect(evaluateStrategyAt(s, series(['95.0001']), pos('100', '100'))).toBeNull();
  });

  it('long-only: no entries while in a position, no exits while flat', () => {
    const s = compileStrategy({ entryRules: always, exitRules: always });
    expect(evaluateStrategyAt(s, series([1]), null)?.type).toBe('ENTRY');
    expect(evaluateStrategyAt(s, series([1]), pos('1', '1'))?.type).toBe('EXIT');
    expect(evaluateStrategyAt(s, series([1]), { ...pos('1', '1'), qty: d('0') })?.type).toBe('ENTRY');
  });

  it('warm-up: no rule signal until every referenced indicator is warm; overlays still protect', () => {
    const s = compileStrategy({
      entryRules: { gt: [{ field: 'close' }, { ind: 'SMA', period: 1 }] },
      exitRules: { lt: [{ ind: 'RSI', period: 5 }, { const: '101' }] },
      stopLossPct: '5',
    });
    expect(s.warmupBars).toBe(6);
    const r = s.createRunner();
    const held = pos('100', '100');
    const out = [100, 100, 100, 100, 100, 100].map((c, i) => r.onBar(mk(c, i), held));
    expect(out.map((x) => x?.reason ?? null)).toEqual([null, null, null, null, null, 'RULE_EXIT']);
    const r2 = s.createRunner();
    expect(r2.onBar(mk(90, 0), held)?.reason).toBe('STOP_LOSS');
  });

  it('cooldown suppresses entries for cooldownBars bars after the position goes flat', () => {
    const s = compileStrategy({ entryRules: always, cooldownBars: 2 });
    const r = s.createRunner();
    const p = pos('1', '1');
    const states = [p, p, null, null, null, null];
    const out = states.map((st, i) => r.onBar(mk(1, i), st));
    expect(out.map((x) => x?.type ?? null)).toEqual([null, null, null, null, 'ENTRY', 'ENTRY']);
    expect(evaluateStrategyAt(s, series([1, 1]), null, { barsSinceLastExit: 1 })).toBeNull();
    expect(evaluateStrategyAt(s, series([1, 1]), null, { barsSinceLastExit: 2 })?.type).toBe('ENTRY');
  });

  it('rejects invalid overlays and cooldown with paths', () => {
    try {
      compileStrategy({
        stopLossPct: '0',
        trailingStopPct: '100',
        takeProfitPct: 'abc',
        cooldownBars: -1,
        entryRules: { x: 1 },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StrategyValidationError);
      expect((e as StrategyValidationError).errors.map((x) => x.path).sort()).toEqual([
        '$.cooldownBars',
        '$.entryRules.x',
        '$.stopLossPct',
        '$.takeProfitPct',
        '$.trailingStopPct',
      ]);
    }
  });

  it('runner and evaluateStrategyAt agree; signals never depend on future bars', () => {
    const s = compileStrategy(buildTemplateStrategy('MA_CROSSOVER', { fastPeriod: 2, slowPeriod: 4 }));
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 30 }),
        fc.array(fc.integer({ min: 1, max: 100 }), { maxLength: 5 }),
        (closes, fut) => {
          const r = s.createRunner();
          const all = series([...closes, ...fut]);
          const streamed = all.map((b) => r.onBar(b, null));
          const t = closes.length - 1;
          const direct = evaluateStrategyAt(s, all.slice(0, t + 1), null);
          expect(JSON.stringify(direct)).toBe(JSON.stringify(streamed[t]));
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('signal score', () => {
  const cfg = {
    trendFastPeriod: 2,
    trendSlowPeriod: 3,
    rsiPeriod: 2,
    macdFast: 2,
    macdSlow: 3,
    macdSignal: 2,
    volumePeriod: 2,
    atrPeriod: 2,
    volatilityLookback: 5,
    volatilityMinSamples: 2,
  };

  it('is 50 with no information and deterministic with documented weights', () => {
    const sc = new SignalScorer();
    sc.update(mk(10, 0));
    const s = sc.score('ENTRY');
    expect(s.total.toString()).toBe('50');
    expect(s.components.every((c) => !c.available)).toBe(true);
  });

  it('uptrend scores bullish for entries and mirrors for exits', () => {
    const sc = new SignalScorer(cfg);
    // accelerating uptrend so the MACD histogram is strictly positive (a linear ramp gives histogram 0)
    [10, 11, 13, 16, 20, 25].forEach((c, i) => sc.update(mk(c, i, String(c + 1))));
    const entry = sc.score('ENTRY');
    const byName = Object.fromEntries(entry.components.map((c) => [c.name, c.score?.toString() ?? null]));
    expect(byName.trend).toBe('100');
    expect(byName.volume).toBe('50'); // volume equals its average
    // momentum: RSI 100 and MACD hist > 0 -> 100
    expect(byName.momentum).toBe('100');
    const exit = sc.score('EXIT');
    const ex = Object.fromEntries(exit.components.map((c) => [c.name, c.score?.toString() ?? null]));
    expect(ex.trend).toBe('0');
    expect(ex.momentum).toBe('0');
    expect(ex.volume).toBe('50');
    // total = weighted mean of available components
    const total = (comps: typeof entry.components): Decimal => {
      const av = comps.filter((c) => c.available);
      const w = av.reduce((a, c) => a + c.weight, 0);
      return round(
        av.reduce((a, c) => a.plus(c.score!.times(fromInt(c.weight))), d('0')).div(fromInt(w)),
        0,
        'HALF_UP',
      );
    };
    expect(entry.total.eq(total(entry.components))).toBe(true);
    expect(exit.total.eq(total(exit.components))).toBe(true);
  });

  it('total always within 0..100 (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 1, max: 1000 }),
            fc.integer({ min: 0, max: 50 }),
            fc.integer({ min: 0, max: 5000 }),
          ),
          { maxLength: 40 },
        ),
        (rows) => {
          const sc = new SignalScorer(cfg);
          rows.forEach(([c, h, v], i) => sc.update(mk(c, i, String(c + h), String(v))));
          for (const dir of ['ENTRY', 'EXIT'] as const) {
            const t = sc.score(dir).total;
            expect(t.gte(0) && t.lte(100) && t.isInteger()).toBe(true);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('position sizer', () => {
  it('takes the minimum of budget, max qty, risk-per-trade and concentration', () => {
    const r = sizePosition({
      price: d('100'),
      maxInvestmentRemaining: d('100000'),
      feeEstimatePct: d('0.5'),
      maxPositionQty: d('900'),
      riskPerTradePct: d('1'),
      equity: d('200000'),
      stopPrice: d('95'),
      maxPositionPct: d('20'),
      portfolioValue: d('200000'),
      currentPositionValue: d('5000'),
    });
    expect(r.candidates.map((c) => [c.constraint, c.qty.toString()])).toEqual([
      ['BUDGET', '995'], // 100000 / 100.5 = 995.02
      ['MAX_POSITION_QTY', '900'],
      ['RISK_PER_TRADE', '400'], // 2000 / 5
      ['CONCENTRATION', '350'], // (40000 - 5000) / 100
    ]);
    expect(r.qty.toString()).toBe('350');
    expect(r.binding).toBe('CONCENTRATION');
    expect(r.tradable).toBe(true);
  });

  it('returns 0 (not tradable) when budget is insufficient or concentration exhausted', () => {
    expect(sizePosition({ price: d('100'), maxInvestmentRemaining: d('99.99') }).tradable).toBe(false);
    const r = sizePosition({
      price: d('10'),
      maxInvestmentRemaining: d('1000'),
      maxPositionPct: d('10'),
      portfolioValue: d('1000'),
      currentPositionValue: d('500'),
    });
    expect(r.qty.toString()).toBe('0');
  });

  it('rejects invalid inputs', () => {
    expect(() => sizePosition({ price: d('0'), maxInvestmentRemaining: d('1') })).toThrow(RangeError);
    expect(() =>
      sizePosition({
        price: d('10'),
        maxInvestmentRemaining: d('1'),
        riskPerTradePct: d('1'),
        equity: d('1'),
        stopPrice: d('10'),
      }),
    ).toThrow(RangeError);
    expect(() =>
      sizePosition({ price: d('10'), maxInvestmentRemaining: d('1'), maxPositionPct: d('1') }),
    ).toThrow(RangeError);
  });

  it('never exceeds the budget including fees (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 500 }),
        (priceCents, budgetCents, feeBp) => {
          const price = d(String(priceCents)).div(100);
          const budget = d(String(budgetCents)).div(100);
          const fee = d(String(feeBp)).div(100);
          const r = sizePosition({ price, maxInvestmentRemaining: budget, feeEstimatePct: fee });
          expect(r.qty.isInteger() && r.qty.gte(0)).toBe(true);
          const cost = (q: Decimal): Decimal => q.times(price).times(d('1').plus(fee.div(100)));
          expect(cost(r.qty).lte(budget)).toBe(true);
          expect(cost(r.qty.plus(1)).gt(budget)).toBe(true); // maximal
        },
      ),
      { numRuns: 200 },
    );
  });
});
