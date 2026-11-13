import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { d, type Decimal, round } from '../decimal.js';
import { type OhlcvBar } from '../indicators/types.js';
import { buildTemplateStrategy } from '../strategy/templates.js';
import {
  barLimitFill,
  type BacktestEquityPoint,
  type BacktestFeeFn,
  BACKTEST_DISCLAIMER,
  computeBacktestMetrics,
  maxAffordableQty,
  paperFill,
  runBacktest,
} from './index.js';

const day = (i: number): string => new Date(Date.UTC(2024, 0, 1 + i)).toISOString();
const bar = (i: number, open: number | string, close: number | string, volume = '1000000'): OhlcvBar => {
  const o = d(String(open));
  const c = d(String(close));
  return { ts: day(i), open: o, close: c, high: o.gt(c) ? o : c, low: o.lt(c) ? o : c, volume: d(volume) };
};
const flatFee: BacktestFeeFn = () => d('1');
const crossStrategy = {
  entryRules: { crossesAbove: [{ field: 'close' }, { const: '10' }] },
  exitRules: { crossesBelow: [{ field: 'close' }, { const: '10' }] },
};
const scenario = (): OhlcvBar[] => [
  bar(0, 9, 9),
  bar(1, 9, 11),
  bar(2, 12, 13),
  bar(3, 14, 9),
  bar(4, 8, 8),
  bar(5, 8, 12),
  bar(6, 10, 10),
];

describe('backtest simulator: hand-computed scenario', () => {
  const r = runBacktest({ bars: scenario(), strategy: crossStrategy, initialCapital: '1000', fee: flatFee });

  it('fills at the next open, sizes with fees, and tracks cash/equity', () => {
    expect(
      r.fills.map((f) => [f.barIndex, f.side, f.qty.toString(), f.price.toString(), f.fee.toString()]),
    ).toEqual([
      [2, 'BUY', '83', '12', '1'], // 83*12 + 1 = 997 <= 1000
      [4, 'SELL', '83', '8', '1'],
      [6, 'BUY', '66', '10', '1'], // cash 666: 66*10 + 1 = 661
    ]);
    expect(r.equityCurve.map((p) => p.equity.toString())).toEqual([
      '1000',
      '1000',
      '1082',
      '750',
      '666',
      '666',
      '665',
    ]);
    expect(r.signals.map((s) => [s.signal.barIndex, s.signal.type, s.filled])).toEqual([
      [1, 'ENTRY', true],
      [3, 'EXIT', true],
      [5, 'ENTRY', true],
    ]);
  });

  it('records the round trip with P&L including fees', () => {
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect([t.entryTs, t.exitTs, t.qty.toString(), t.entryPrice.toString(), t.exitPrice.toString()]).toEqual([
      day(2),
      day(4),
      '83',
      '12',
      '8',
    ]);
    expect(t.netPnl.toString()).toBe('-334'); // 664 - 996 - 2
    expect(t.exitReason).toBe('RULE_EXIT');
    expect(t.barsHeld).toBe(2);
    expect(r.openPosition).toMatchObject({ entryTs: day(6), barsHeld: 1 });
    expect(r.openPosition!.qty.toString()).toBe('66');
    expect(r.disclaimer).toBe(BACKTEST_DISCLAIMER);
  });

  it('computes metrics', () => {
    const m = r.metrics;
    expect(m.totalReturnPct.toString()).toBe('-33.5');
    expect(m.feesTotal.toString()).toBe('3');
    expect(m.tradeCount).toBe(1);
    expect(m.winRatePct!.toString()).toBe('0');
    expect(m.profitFactor!.toString()).toBe('0');
    expect(m.avgWin).toBeNull();
    expect(m.avgLoss!.toString()).toBe('-334');
    expect(round(m.exposurePct, 6).toString()).toBe('42.857143'); // 3 of 7 bars
    expect(m.maxDrawdownPct.eq(d('417').div('1082').times(100))).toBe(true);
    expect(m.buyAndHoldReturnPct!.toString()).toBe('11'); // 111 sh @ 9 (+1 fee) -> 1110
    expect(m.calendarDays.toString()).toBe('6');
    expect(m.cagrPct!.lt(-99)).toBe(true);
  });

  it('applies adverse slippage', () => {
    const s = runBacktest({
      bars: scenario(),
      strategy: crossStrategy,
      initialCapital: '1000',
      fee: flatFee,
      slippageBps: '100',
    });
    expect(s.fills.map((f) => f.price.toString())).toEqual(['12.12', '7.92', '10.1']);
  });

  it('does not fill a signal on the last bar', () => {
    const s = runBacktest({
      bars: scenario().slice(0, 2),
      strategy: crossStrategy,
      initialCapital: '1000',
      fee: flatFee,
    });
    expect(s.fills).toEqual([]);
    expect(s.signals[0]).toMatchObject({ filled: false, note: 'signal on last bar: no next bar to fill' });
  });

  it('volume participation cap: partial entry; exit remainder keeps working', () => {
    const bars = [
      bar(0, 9, 9),
      bar(1, 9, 11),
      bar(2, 12, 13, '200'),
      bar(3, 14, 9),
      bar(4, 8, 8, '300'),
      bar(5, 8, 8, '1000'),
    ];
    const s = runBacktest({
      bars,
      strategy: crossStrategy,
      initialCapital: '1000',
      fee: flatFee,
      volumeParticipationPct: '10',
    });
    expect(s.fills.map((f) => [f.barIndex, f.side, f.qty.toString()])).toEqual([
      [2, 'BUY', '20'],
      [4, 'SELL', '20'], // holds 20, cap 30 not binding
    ]);
    expect(s.signals[0]!.note).toBe('partially filled (volume cap); remainder cancelled');
    const s2 = runBacktest({
      bars: [
        bar(0, 9, 9),
        bar(1, 9, 11),
        bar(2, 12, 13),
        bar(3, 14, 9),
        bar(4, 8, 8, '100'),
        bar(5, 8, 8, '1000'),
      ],
      strategy: crossStrategy,
      initialCapital: '1000',
      fee: flatFee,
      volumeParticipationPct: '10',
    });
    expect(s2.fills.map((f) => [f.barIndex, f.side, f.qty.toString()])).toEqual([
      [2, 'BUY', '83'],
      [4, 'SELL', '10'],
      [5, 'SELL', '73'],
    ]);
    expect(s2.trades[0]!.exitPrice.toString()).toBe('8');
  });

  it('overlay stop-loss exits with reason STOP_LOSS', () => {
    const bars = [bar(0, 9, 9), bar(1, 9, 11), bar(2, 12, 12), bar(3, 12, 11.4), bar(4, 11, 11)];
    const s = runBacktest({
      bars,
      strategy: { ...crossStrategy, stopLossPct: '5' },
      initialCapital: '1000',
      fee: flatFee,
    });
    expect(s.trades[0]!.exitReason).toBe('STOP_LOSS'); // 11.4 <= 12 * 0.95
  });

  it('rejects unsorted bars and bad config', () => {
    expect(() =>
      runBacktest({
        bars: [bar(1, 1, 1), bar(0, 1, 1)],
        strategy: crossStrategy,
        initialCapital: '1',
        fee: flatFee,
      }),
    ).toThrow(RangeError);
    expect(() =>
      runBacktest({ bars: [], strategy: crossStrategy, initialCapital: '0', fee: flatFee }),
    ).toThrow(RangeError);
  });

  it('maxAffordableQty is maximal with non-linear fees', () => {
    const fee: BacktestFeeFn = (_s, q, p) => {
      const v = q.times(p).times('0.0015');
      return v.lt(5) ? d('5') : v;
    };
    const q = maxAffordableQty(d('10000'), d('33.33'), d('300'), fee);
    const cost = (x: Decimal): Decimal => x.times('33.33').plus(fee('BUY', x, d('33.33')));
    expect(cost(q).lte(10000)).toBe(true);
    expect(cost(q.plus(1)).gt(10000)).toBe(true);
  });
});

describe('backtest properties', () => {
  const barsArb = fc
    .array(fc.tuple(fc.integer({ min: 50, max: 150 }), fc.integer({ min: 50, max: 150 })), {
      minLength: 2,
      maxLength: 45,
    })
    .map((rows) => rows.map(([o, c], i) => bar(i, o, c)));
  const strategy = {
    ...buildTemplateStrategy('MA_CROSSOVER', { fastPeriod: 2, slowPeriod: 5 }),
    stopLossPct: '4',
    trailingStopPct: '6',
  };
  const fee: BacktestFeeFn = (_s, q, p) => round(q.times(p).times('0.002'), 2);

  it('no look-ahead: changing future bars never changes past signals, fills or equity', () => {
    fc.assert(
      fc.property(barsArb, barsArb, barsArb, (past, futA, futB) => {
        const shift = (bs: OhlcvBar[]): OhlcvBar[] => bs.map((b, i) => ({ ...b, ts: day(past.length + i) }));
        const a = runBacktest({
          bars: [...past, ...shift(futA)],
          strategy,
          initialCapital: '100000',
          fee,
          slippageBps: '10',
        });
        const b = runBacktest({
          bars: [...past, ...shift(futB)],
          strategy,
          initialCapital: '100000',
          fee,
          slippageBps: '10',
        });
        const t = past.length - 1;
        const sig = (r: typeof a) =>
          JSON.stringify(r.signals.filter((s) => s.signal.barIndex <= t).map((s) => s.signal));
        const fil = (r: typeof a) => JSON.stringify(r.fills.filter((f) => f.barIndex <= t));
        expect(sig(a)).toBe(sig(b));
        expect(fil(a)).toBe(fil(b));
        expect(JSON.stringify(a.equityCurve.slice(0, t + 1))).toBe(
          JSON.stringify(b.equityCurve.slice(0, t + 1)),
        );
      }),
      { numRuns: 40 },
    );
  });

  it('deterministic and cash never negative', () => {
    fc.assert(
      fc.property(barsArb, (bars) => {
        const cfg = { bars, strategy, initialCapital: '50000', fee, slippageBps: '25' };
        const a = runBacktest(cfg);
        expect(JSON.stringify(runBacktest(cfg))).toBe(JSON.stringify(a));
        for (const p of a.equityCurve) expect(p.cash.gte(0)).toBe(true);
        // accounting identity: final equity = initial + Σ trade P&L + open position unrealised (net of entry fee)
        const closed = a.trades.reduce((s, t) => s.plus(t.netPnl), d('0'));
        const open = a.openPosition
          ? a.openPosition.marketValue
              .minus(a.openPosition.qty.times(a.openPosition.avgCost))
              .minus(a.fills[a.fills.length - 1]!.fee)
          : d('0');
        expect(a.metrics.finalEquity.eq(d('50000').plus(closed).plus(open))).toBe(true);
      }),
      { numRuns: 40 },
    );
  });
});

describe('metrics', () => {
  const pt = (ts: string, equity: string): BacktestEquityPoint => ({
    ts,
    barIndex: 0,
    cash: d(equity),
    positionQty: d('0'),
    close: d('1'),
    equity: d(equity),
    drawdownPct: d('0'),
  });
  const opts = { feesTotal: d('0'), buyAndHoldReturnPct: null };

  it('CAGR over exactly one year; null under one day', () => {
    const m = computeBacktestMetrics(
      d('100'),
      [pt('2023-01-01T00:00:00Z', '100'), pt('2024-01-01T00:00:00Z', '110')],
      [],
      opts,
    );
    expect(m.cagrPct!.toString()).toBe('10');
    expect(
      computeBacktestMetrics(
        d('100'),
        [pt('2023-01-01T00:00:00Z', '100'), pt('2023-01-01T12:00:00Z', '110')],
        [],
        opts,
      ).cagrPct,
    ).toBeNull();
  });

  it('Sharpe from sample stdev of per-bar returns, annualised, with risk-free rate', () => {
    const curve = [
      pt('2024-01-01T00:00:00Z', '100'),
      pt('2024-01-02T00:00:00Z', '101'),
      pt('2024-01-03T00:00:00Z', '103.02'),
    ];
    // returns 0.01, 0.02 -> mean 0.015, sample var 0.00005
    const m = computeBacktestMetrics(d('100'), curve, [], opts);
    expect(round(m.sharpe!, 4).toString()).toBe('33.6749'); // 0.015 / 0.0070711 * sqrt(252)
    const rf = computeBacktestMetrics(d('100'), curve, [], { ...opts, riskFreeRatePct: d('2.52') });
    expect(rf.sharpe!.eq(d('0.0149').div(d('0.00005').sqrt()).times(d('252').sqrt()))).toBe(true);
    expect(computeBacktestMetrics(d('100'), curve.slice(0, 2), [], opts).sharpe).toBeNull();
  });

  it('trade statistics', () => {
    const trades = [{ netPnl: d('30') }, { netPnl: d('-10') }, { netPnl: d('10') }, { netPnl: d('-20') }];
    const m = computeBacktestMetrics(d('100'), [pt('2024-01-01T00:00:00Z', '100')], trades, opts);
    expect(m.winRatePct!.toString()).toBe('50');
    expect(m.profitFactor!.toString()).toBe('1.333333333333333333333333333333333');
    expect(m.avgWin!.toString()).toBe('20');
    expect(m.avgLoss!.toString()).toBe('-15');
  });
});

describe('paper fills', () => {
  const q = (last: string, volume?: string) => ({
    last: d(last),
    volume: volume === undefined ? null : d(volume),
  });
  it('market orders fill at last with adverse slippage', () => {
    expect(
      paperFill({ side: 'BUY', type: 'MARKET', qty: d('10') }, q('100'), {
        slippageBps: d('50'),
      }).price!.toString(),
    ).toBe('100.5');
    expect(
      paperFill({ side: 'SELL', type: 'MARKET', qty: d('10') }, q('100'), {
        slippageBps: d('50'),
      }).price!.toString(),
    ).toBe('99.5');
  });
  it('limit buy fills only when last <= limit, never above the limit', () => {
    const o = { side: 'BUY', type: 'LIMIT', qty: d('10'), limitPrice: d('100') } as const;
    expect(paperFill(o, q('100.01')).filled).toBe(false);
    expect(paperFill(o, q('99')).price!.toString()).toBe('99');
    expect(paperFill(o, q('99.9'), { slippageBps: d('50') }).price!.toString()).toBe('100'); // 100.3995 capped
    expect(paperFill(o, q('100')).filled).toBe(true);
  });
  it('limit sell fills only when last >= limit, never below the limit', () => {
    const o = { side: 'SELL', type: 'LIMIT', qty: d('10'), limitPrice: d('100') } as const;
    expect(paperFill(o, q('99.99')).filled).toBe(false);
    expect(paperFill(o, q('101')).price!.toString()).toBe('101');
    expect(paperFill(o, q('100.2'), { slippageBps: d('50') }).price!.toString()).toBe('100');
  });
  it('volume participation produces partial fills', () => {
    const o = { side: 'BUY', type: 'MARKET', qty: d('100') } as const;
    const r = paperFill(o, q('10', '500'), { volumeParticipationPct: d('10') });
    expect([r.filled, r.qty.toString(), r.remainingQty.toString()]).toEqual([true, '50', '50']);
    expect(paperFill(o, q('10', '5'), { volumeParticipationPct: d('10') }).filled).toBe(false);
    expect(paperFill(o, q('10'), { volumeParticipationPct: d('10') }).qty.toString()).toBe('100');
  });
  it('validates inputs', () => {
    expect(() => paperFill({ side: 'BUY', type: 'LIMIT', qty: d('1') }, q('1'))).toThrow(RangeError);
    expect(() => paperFill({ side: 'BUY', type: 'MARKET', qty: d('0.5') }, q('1'))).toThrow(RangeError);
  });
  it('bar limit fills require trading through the limit', () => {
    const b = { ts: day(0), open: d('101'), high: d('102'), low: d('100'), close: d('101'), volume: d('1') };
    expect(barLimitFill('BUY', d('100'), b).filled).toBe(false); // touch only
    expect(barLimitFill('BUY', d('100.5'), b).price!.toString()).toBe('100.5');
    expect(barLimitFill('BUY', d('105'), b).price!.toString()).toBe('101'); // opened below limit
    expect(barLimitFill('SELL', d('102'), b).filled).toBe(false);
    expect(barLimitFill('SELL', d('100'), b).price!.toString()).toBe('101');
  });
});
