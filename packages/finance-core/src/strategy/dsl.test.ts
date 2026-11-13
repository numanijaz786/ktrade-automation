import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { d } from '../decimal.js';
import { type OhlcvBar } from '../indicators/types.js';
import { compileRules, evaluateRuleOverBars, type StrategyPosition, validateRule } from './index.js';

const mk = (
  close: string | number,
  i = 0,
  extra: Partial<Record<'open' | 'high' | 'low' | 'volume', string>> = {},
): OhlcvBar => {
  const c = d(String(close));
  return {
    ts: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
    open: d(extra.open ?? c.toString()),
    high: d(extra.high ?? c.toString()),
    low: d(extra.low ?? c.toString()),
    close: c,
    volume: d(extra.volume ?? '1000'),
  };
};
const series = (closes: (string | number)[]): OhlcvBar[] => closes.map((c, i) => mk(c, i));
const results = (rule: unknown, closes: (string | number)[], params = {}): boolean[] =>
  evaluateRuleOverBars(rule, series(closes), params).map((e) => e.result);

describe('rule DSL validation', () => {
  it('accepts the docs/08 example with $params', () => {
    const rule = {
      all: [
        {
          crossesAbove: [
            { ind: 'EMA', period: '$fastPeriod' },
            { ind: 'EMA', period: '$slowPeriod' },
          ],
        },
        { gt: [{ ind: 'RSI', period: 14 }, { const: '50' }] },
        { gt: [{ field: 'volume' }, { mul: [{ ind: 'VOLUME_SMA', period: 20 }, { const: '1.5' }] }] },
      ],
    };
    expect(validateRule(rule, { fastPeriod: 9, slowPeriod: 21 })).toEqual([]);
  });

  it('reports typed errors with JSON paths', () => {
    const errs = validateRule(
      {
        all: [
          {
            crossesAbove: [
              { ind: 'EMA', period: '$nope' },
              { ind: 'FOO', period: 3 },
            ],
          },
          { gt: [{ const: 1.5 }, { field: 'close', extra: 1 }] },
          { between: [{ const: '1' }, { const: '2' }] },
          { frobnicate: [] },
          { gt: [{ ind: 'SMA' }, { ind: 'MACD', fast: 30, slow: 10 }] },
          { rising: [{ field: 'close' }, 0] },
        ],
      },
      {},
    );
    const byPath = Object.fromEntries(errs.map((e) => [e.path, e.code]));
    expect(byPath).toEqual({
      '$.all[0].crossesAbove[0].period': 'UNKNOWN_PARAM',
      '$.all[0].crossesAbove[1].ind': 'UNKNOWN_INDICATOR',
      '$.all[1].gt[0].const': 'INVALID_VALUE',
      '$.all[1].gt[1].extra': 'UNKNOWN_KEY',
      '$.all[2].between': 'ARITY',
      '$.all[3].frobnicate': 'UNKNOWN_OPERATOR',
      '$.all[4].gt[0].period': 'MISSING_FIELD',
      '$.all[4].gt[1].fast': 'OUT_OF_RANGE',
      '$.all[5].rising[1]': 'OUT_OF_RANGE',
    });
  });

  it('rejects non-objects, multi-key rules, empty combinators, wrong param types and deep nesting', () => {
    expect(validateRule(null)[0]?.code).toBe('INVALID_TYPE');
    expect(validateRule({ gt: [], lt: [] })[0]?.code).toBe('UNKNOWN_KEY');
    expect(validateRule({ all: [] })[0]?.code).toBe('ARITY');
    expect(validateRule({ gt: [{ ind: 'SMA', period: '$p' }, { const: '1' }] }, { p: true })[0]?.code).toBe(
      'INVALID_VALUE',
    );
    expect(validateRule({ gt: [{ ind: 'SMA', period: 0 }, { const: '1' }] })[0]?.code).toBe('OUT_OF_RANGE');
    let deep: unknown = { gt: [{ const: '1' }, { const: '0' }] };
    for (let i = 0; i < 30; i++) deep = { not: deep };
    expect(validateRule(deep).some((e) => e.code === 'TOO_COMPLEX')).toBe(true);
    expect(() => compileRules({ r: { bogus: 1 } })).toThrow(/\$\.r\.bogus/);
  });

  it('cannot execute code: strings are never evaluated', () => {
    const errs = validateRule({ gt: [{ const: 'process.exit(1)' }, { const: '0' }] });
    expect(errs[0]?.code).toBe('INVALID_VALUE');
  });
});

describe('rule DSL evaluation', () => {
  it('comparisons, constants and arithmetic', () => {
    expect(results({ gt: [{ field: 'close' }, { const: '10' }] }, [9, 10, 11])).toEqual([false, false, true]);
    expect(results({ gte: [{ field: 'close' }, { const: '10' }] }, [9, 10, 11])).toEqual([false, true, true]);
    expect(
      results(
        { eq: [{ add: [{ field: 'close' }, { const: '1' }, { const: '0.5' }] }, { const: '11.5' }] },
        [10],
      ),
    ).toEqual([true]);
    expect(
      results(
        { eq: [{ sub: [{ field: 'close' }, { const: '4' }] }, { mul: [{ const: '2' }, { const: '3' }] }] },
        [10],
      ),
    ).toEqual([true]);
    // division by zero -> null -> comparison false (never throws)
    expect(results({ lt: [{ div: [{ const: '1' }, { const: '0' }] }, { const: '5' }] }, [10])).toEqual([
      false,
    ]);
    expect(
      results({ between: [{ field: 'close' }, { const: '10' }, { const: '11' }] }, [9, 10, 11, 12]),
    ).toEqual([false, true, true, false]);
  });

  it('crossesAbove / crossesBelow (touch then cross counts; staying above does not)', () => {
    const rule = { crossesAbove: [{ field: 'close' }, { const: '10' }] };
    expect(results(rule, [9, 10, 11, 12, 9, 11])).toEqual([false, false, true, false, false, true]);
    const below = { crossesBelow: [{ field: 'close' }, { const: '10' }] };
    expect(results(below, [11, 10, 9, 8, 11, 9])).toEqual([false, false, true, false, false, true]);
  });

  it('SMA crossover on a hand-computed series', () => {
    // SMA2 vs SMA3 on closes 5,4,3,4,6,7
    // SMA2: -, 4.5, 3.5, 3.5, 5, 6.5   SMA3: -, -, 4, 3.667, 4.333, 5.667
    const rule = {
      crossesAbove: [
        { ind: 'SMA', period: 2 },
        { ind: 'SMA', period: 3 },
      ],
    };
    const ev = evaluateRuleOverBars(rule, series([5, 4, 3, 4, 6, 7]));
    expect(ev.map((e) => e.result)).toEqual([false, false, false, false, true, false]);
    expect(ev.map((e) => e.warm)).toEqual([false, false, false, true, true, true]);
    const t = ev[4]!.trace[0]!;
    expect(t.kind).toBe('crossesAbove');
    expect(t.operands[0]).toEqual({ label: 'SMA(2)', value: '5', history: ['3.5', '5'] });
    expect(t.operands[1]!.label).toBe('SMA(3)');
    expect(t.text).toContain('crosses above');
  });

  it('rising / falling over n bars (strict)', () => {
    expect(results({ rising: [{ field: 'close' }, 2] }, [1, 2, 3, 3, 4, 5])).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
    expect(results({ falling: [{ field: 'close' }, 1] }, [3, 2, 2, 1])).toEqual([false, true, false, true]);
  });

  it('all / any / not with a complete trace (no short-circuit)', () => {
    const rule = {
      any: [
        { gt: [{ field: 'close' }, { const: '100' }] },
        { not: { lt: [{ field: 'close' }, { const: '5' }] } },
      ],
    };
    const [ev] = evaluateRuleOverBars(rule, series([10]));
    expect(ev!.result).toBe(true);
    expect(ev!.trace.map((t) => [t.path, t.kind, t.result])).toEqual([
      ['$.rule', 'any', true],
      ['$.rule.any[0]', 'gt', false],
      ['$.rule.any[1]', 'not', true],
      ['$.rule.any[1].not', 'lt', false],
    ]);
  });

  it('offsets, changePct and HIGHEST breakout', () => {
    const closes = [10, 11, 12, 11, 13];
    expect(
      results(
        { gt: [{ field: 'close' }, { ind: 'HIGHEST', period: 2, source: 'close', offset: 1 }] },
        closes,
      ),
    ).toEqual([false, false, true, false, true]);
    expect(results({ eq: [{ field: 'close', offset: 2 }, { const: '10' }] }, closes)).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    const ev = evaluateRuleOverBars(
      { gt: [{ field: 'changePct' }, { const: '9' }] },
      series(['100', '110', '111']),
    );
    expect(ev.map((e) => e.result)).toEqual([false, true, false]);
    expect(ev[1]!.trace[0]!.operands[0]!.value).toBe('10');
  });

  it('position operands (flat: qty 0, avgCost null)', () => {
    const pos: StrategyPosition = { qty: d('100'), avgCost: d('50'), barsHeld: 3, highSinceEntry: d('60') };
    const rule = { lte: [{ position: 'unrealizedPct' }, { const: '-10' }] };
    const ev = evaluateRuleOverBars(rule, series([45, 44]), {}, [pos, null]);
    expect(ev.map((e) => e.result)).toEqual([true, false]);
    expect(ev[0]!.trace[0]!.operands[0]!.value).toBe('-10');
    const qty = evaluateRuleOverBars({ eq: [{ position: 'qty' }, { const: '0' }] }, series([1]));
    expect(qty[0]!.result).toBe(true);
    const held = evaluateRuleOverBars({ gte: [{ position: 'barsHeld' }, { const: 3 }] }, series([1]), {}, [
      pos,
    ]);
    expect(held[0]!.result).toBe(true);
  });

  it('MACD and BB outputs, shared indicator state', () => {
    const compiled = compileRules({
      a: { gt: [{ ind: 'MACD', fast: 2, slow: 3, signal: 2, output: 'histogram' }, { const: '-1' }] },
      b: {
        lte: [
          { ind: 'BB', period: 3, stdDev: '0', output: 'upper' },
          { ind: 'SMA', period: 3 },
        ],
      },
    });
    expect(compiled.requiredBars).toEqual({ a: 4, b: 3 });
    const ev = compiled.createEvaluator();
    series([1, 2, 3, 4]).forEach((b) => ev.update(b));
    expect(ev.evaluate('a').result).toBe(true);
    expect(ev.evaluate('b').result).toBe(true);
  });
});

describe('no look-ahead (property)', () => {
  const rule = {
    any: [
      {
        crossesAbove: [
          { ind: 'EMA', period: 3 },
          { ind: 'SMA', period: 5 },
        ],
      },
      {
        all: [
          { rising: [{ ind: 'RSI', period: 4 }, 2] },
          { gt: [{ field: 'close' }, { ind: 'BB', period: 4, output: 'upper', offset: 1 }] },
        ],
      },
    ],
  };
  it('evaluation at t is identical whether or not later bars exist or change', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 2, maxLength: 40 }),
        fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 10 }),
        (closes, future) => {
          const t = closes.length - 1;
          const prefix = evaluateRuleOverBars(rule, series(closes));
          const extended = evaluateRuleOverBars(rule, series([...closes, ...future]));
          expect(JSON.stringify(extended.slice(0, t + 1))).toBe(JSON.stringify(prefix));
        },
      ),
      { numRuns: 80 },
    );
  });
});
