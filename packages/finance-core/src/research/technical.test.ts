import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { d, type Decimal } from '../decimal.js';
import { type OhlcvBar } from '../indicators/types.js';
import { bar, driftBars } from './fixtures.js';
import {
  adxAnalysis,
  adxSeries,
  breakoutAnalysis,
  candlePatterns,
  momentumScore,
  supportResistance,
  swingPivots,
  trendAnalysis,
  volumeAnalysis,
} from './technical.js';

// ───────── independent exact-fraction reference (bigint rationals) ─────────
const babs = (x: bigint): bigint => (x < 0n ? -x : x);
const gcd = (a: bigint, b: bigint): bigint => {
  a = babs(a);
  b = babs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
};
class Q {
  readonly n: bigint;
  readonly m: bigint;
  constructor(n: bigint, m = 1n) {
    if (m < 0n) [n, m] = [-n, -m];
    const g = gcd(n, m);
    this.n = n / g;
    this.m = m / g;
  }
  static of(s: string): Q {
    const [i = '0', f = ''] = s.split('.');
    return new Q(BigInt(i + f), 10n ** BigInt(f.length));
  }
  add(o: Q): Q {
    return new Q(this.n * o.m + o.n * this.m, this.m * o.m);
  }
  sub(o: Q): Q {
    return new Q(this.n * o.m - o.n * this.m, this.m * o.m);
  }
  mul(o: Q): Q {
    return new Q(this.n * o.n, this.m * o.m);
  }
  div(o: Q): Q {
    return new Q(this.n * o.m, this.m * o.n);
  }
  gt(o: Q): boolean {
    return this.sub(o).n > 0n;
  }
  abs(): Q {
    return new Q(babs(this.n), this.m);
  }
  isZero(): boolean {
    return this.n === 0n;
  }
  approxEquals(x: Decimal): boolean {
    const diff = this.sub(Q.of(x.toFixed())).abs();
    const scale = babs(this.n) > this.m ? new Q(babs(this.n), this.m) : new Q(1n);
    return diff.sub(scale.mul(new Q(1n, 10n ** 25n))).n < 0n;
  }
}
const Z = new Q(0n);
const H = new Q(100n);

function refAdx(bars: OhlcvBar[], period: number): { pdi: Q; mdi: Q; adx: Q | null }[] {
  const out: { pdi: Q; mdi: Q; adx: Q | null }[] = [];
  const f = (x: Decimal): Q => Q.of(x.toFixed());
  const P = new Q(BigInt(period));
  let sTr = Z;
  let sP = Z;
  let sM = Z;
  const dxs: Q[] = [];
  let adx: Q | null = null;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i] as OhlcvBar;
    const p = bars[i - 1] as OhlcvBar;
    const hl = f(b.high).sub(f(b.low));
    const hc = f(b.high).sub(f(p.close)).abs();
    const lc = f(b.low).sub(f(p.close)).abs();
    let tr = hl;
    if (hc.gt(tr)) tr = hc;
    if (lc.gt(tr)) tr = lc;
    const up = f(b.high).sub(f(p.high));
    const down = f(p.low).sub(f(b.low));
    const pdm = up.gt(down) && up.gt(Z) ? up : Z;
    const mdm = down.gt(up) && down.gt(Z) ? down : Z;
    if (i <= period) {
      sTr = sTr.add(tr);
      sP = sP.add(pdm);
      sM = sM.add(mdm);
    } else {
      sTr = sTr.sub(sTr.div(P)).add(tr);
      sP = sP.sub(sP.div(P)).add(pdm);
      sM = sM.sub(sM.div(P)).add(mdm);
    }
    if (i < period) continue;
    const pdi = sTr.isZero() ? Z : H.mul(sP).div(sTr);
    const mdi = sTr.isZero() ? Z : H.mul(sM).div(sTr);
    const sum = pdi.add(mdi);
    const dx = sum.isZero() ? Z : H.mul(pdi.sub(mdi).abs()).div(sum);
    dxs.push(dx);
    if (dxs.length === period) adx = dxs.reduce((a, x) => a.add(x), Z).div(P);
    else if (dxs.length > period && adx)
      adx = adx
        .mul(new Q(BigInt(period - 1)))
        .add(dx)
        .div(P);
    out.push({ pdi, mdi, adx });
  }
  return out;
}

const ohlc = (rows: [string, string, string, string][]): OhlcvBar[] =>
  rows.map(([o, h, l, c], i) => bar(i, o, h, l, c, '1000'));

describe('ADX', () => {
  it('hand-computed: a steady staircase gives +DI 50, -DI 0, ADX 100 (period 2)', () => {
    // high=10+i, low=8+i, close=9+i: TR=2, +DM=1, -DM=0 every bar => +DI = 100*1/2 = 50, DX = 100.
    const bars = ohlc([0, 1, 2, 3, 4, 5].map((i) => [`${9 + i}`, `${10 + i}`, `${8 + i}`, `${9 + i}`]));
    const s = adxSeries(bars, 2);
    expect(s[1]).toBeNull();
    expect(s[2]?.plusDi.toString()).toBe('50');
    expect(s[2]?.minusDi.toString()).toBe('0');
    expect(s[2]?.adx).toBeNull(); // first ADX at index 2*period-1 = 3
    expect(s[3]?.adx?.toString()).toBe('100');
    expect(s[5]?.adx?.toString()).toBe('100');
  });

  it('matches the exact-fraction reference on a synthetic series (period 5 and 14)', () => {
    const bars = driftBars(80);
    for (const period of [5, 14]) {
      const got = adxSeries(bars, period).filter((x) => x !== null);
      const ref = refAdx(bars, period);
      expect(got.length).toBe(ref.length);
      got.forEach((g, i) => {
        const r = ref[i]!;
        expect(r.pdi.approxEquals(g!.plusDi)).toBe(true);
        expect(r.mdi.approxEquals(g!.minusDi)).toBe(true);
        if (r.adx) expect(r.adx.approxEquals(g!.adx!)).toBe(true);
        else expect(g!.adx).toBeNull();
      });
    }
  });

  it('flags warm-up and explains', () => {
    const cold = adxAnalysis(driftBars(20));
    expect(cold.warm).toBe(false);
    expect(cold.adx).toBeNull();
    expect(cold.explanation[0]).toContain('needs 28 bars');
    const warm = adxAnalysis(driftBars(120));
    expect(warm.warm).toBe(true);
    expect(warm.direction).toBe('BULLISH');
    expect(warm.strength).not.toBeNull();
  });
});

describe('support / resistance', () => {
  // Highs with two near-equal peaks (15 and 15.1) and one trough; lows 2 below highs; close = high - 1.
  const highs = ['10', '11', '12', '15', '12', '11', '10', '11', '12', '15.1', '12', '11', '10'];
  const bars = highs.map((h, i) =>
    bar(i, `${d(h).minus(1)}`, h, `${d(h).minus(2)}`, `${d(h).minus(1)}`, '1000'),
  );

  it('finds swing pivots only after `right` confirming bars', () => {
    const p = swingPivots(bars, 3, 3);
    expect(
      p.filter((x) => x.kind === 'HIGH').map((x) => [x.index, x.price.toString(), x.confirmedAt]),
    ).toEqual([
      [3, '15', 6],
      [9, '15.1', 12],
    ]);
    expect(p.filter((x) => x.kind === 'LOW').map((x) => [x.index, x.price.toString()])).toEqual([[6, '8']]);
  });

  it('clusters near-equal pivots (1%) and counts touches', () => {
    const sr = supportResistance(bars, { minBars: 5 });
    expect(sr.warm).toBe(true);
    expect(sr.levels.map((l) => [l.price.toString(), l.touches, l.type])).toEqual([
      ['8', 1, 'SUPPORT'],
      ['15.05', 2, 'RESISTANCE'],
    ]);
    expect(sr.support?.price.toString()).toBe('8');
    expect(sr.resistance?.price.toString()).toBe('15.05');
    expect(sr.explanation.join(' ')).toContain('nearest resistance 15.05 (2 touches)');
  });

  it('does not merge levels farther apart than the tolerance', () => {
    const sr = supportResistance(bars, { minBars: 5, clusterTolerancePct: d('0.1') });
    expect(sr.levels.filter((l) => l.type === 'RESISTANCE').map((l) => l.price.toString())).toEqual([
      '15',
      '15.1',
    ]);
  });

  it('is not warm with too few bars', () => {
    expect(supportResistance(bars).warm).toBe(false);
  });
});

describe('volume analysis', () => {
  const rows = Array.from({ length: 22 }, (_, i) => bar(i, '9', '10', '8', '10', i === 21 ? '300' : '100'));
  it('relative volume vs the prior 20-bar average, and accumulation', () => {
    const v = volumeAnalysis(rows);
    expect(v.warm).toBe(true);
    expect(v.avgVolume20?.toString()).toBe('100');
    expect(v.relativeVolume?.toString()).toBe('3');
    expect(v.adTrend).toBe('ACCUMULATION'); // close at the high => money-flow multiplier +1
    expect(v.adLine?.toString()).toBe('2400'); // 21 x 100 + 300
    expect(v.avgTradedValue20?.toString()).toBe('1100'); // mean of 10 x volume over the last 20 bars: (19x1000 + 3000)/20
  });
  it('distribution when closes sit at the lows', () => {
    const r = Array.from({ length: 22 }, (_, i) => bar(i, '9', '10', '8', '8', '100'));
    expect(volumeAnalysis(r).adTrend).toBe('DISTRIBUTION');
  });
  it('not warm below 21 bars', () => {
    expect(volumeAnalysis(rows.slice(0, 10)).warm).toBe(false);
  });
});

describe('trend classification', () => {
  it('strong uptrend, strong downtrend and sideways', () => {
    expect(trendAnalysis(driftBars(250)).classification).toBe('STRONG_UPTREND');
    expect(trendAnalysis(driftBars(250, { start: '300', slope: '-0.3' })).classification).toBe(
      'STRONG_DOWNTREND',
    );
    const flat = Array.from({ length: 250 }, (_, i) => bar(i, '100', '100', '100', '100', '1000'));
    const t = trendAnalysis(flat);
    expect(t.classification).toBe('SIDEWAYS');
    expect(t.warm).toBe(true);
  });
  it('warm=false and partial evaluation before SMA200 exists', () => {
    const t = trendAnalysis(driftBars(120));
    expect(t.warm).toBe(false);
    expect(t.evaluatedConditions).toBe(3);
    expect(t.sma200).toBeNull();
    expect(t.explanation.join(' ')).toContain('SMA100 > SMA200: not available');
  });
});

describe('breakout', () => {
  const base = (lastVolume: string): OhlcvBar[] => {
    const rows = Array.from({ length: 60 }, (_, i) => {
      const peak = i === 20 ? '110' : i === 40 ? '110.2' : '101';
      return bar(i, '100', peak, '99', '100', '1000');
    });
    rows.push(bar(60, '100', '111.5', '100', '111', lastVolume));
    return rows;
  };
  it('detects a close above a 2-touch resistance and confirms it with volume', () => {
    const b = breakoutAnalysis(base('3000'));
    expect(b.warm).toBe(true);
    expect(b.crossed).toBe(true);
    expect(b.confirmed).toBe(true);
    expect(b.level?.touches).toBe(2);
    expect(b.relativeVolume?.toString()).toBe('3');
    expect(b.explanation.join(' ')).toContain('volume-confirmed');
  });
  it('crossing on normal volume is not confirmed', () => {
    const b = breakoutAnalysis(base('1000'));
    expect(b.crossed).toBe(true);
    expect(b.confirmed).toBe(false);
  });
  it('no breakout when the close stays below the resistance', () => {
    const rows = base('3000');
    rows[60] = bar(60, '100', '105', '100', '104', '3000');
    const b = breakoutAnalysis(rows);
    expect(b.crossed).toBe(false);
  });
});

describe('momentum score', () => {
  it('is null (never estimated) until all four components are warm', () => {
    const m = momentumScore(driftBars(30));
    expect(m.warm).toBe(false);
    expect(m.score).toBeNull();
    expect(m.explanation.join(' ')).toContain('SMA50 not available');
  });
  it('sums four 0-25 components', () => {
    const m = momentumScore(driftBars(120));
    expect(m.warm).toBe(true);
    expect(m.components).toHaveLength(4);
    for (const c of m.components) {
      expect(c.points.gte(0) && c.points.lte(25)).toBe(true);
    }
    expect(m.score?.toString()).toBe(m.components.reduce((a, c) => a.plus(c.points), d('0')).toString());
  });
  it('is higher in an uptrend than in a downtrend', () => {
    const up = momentumScore(driftBars(120)).score!;
    const down = momentumScore(driftBars(120, { start: '300', slope: '-0.3' })).score!;
    expect(up.gt(down)).toBe(true);
  });
});

describe('candlestick patterns', () => {
  const fall = [120, 118, 116, 114, 112, 110, 108].map((c, i) =>
    bar(i, `${c + 1}`, `${c + 1.5}`, `${c - 0.5}`, `${c}`, '1000'),
  );
  const rise = [80, 82, 84, 86, 88, 90, 92].map((c, i) =>
    bar(i, `${c - 1}`, `${c + 0.5}`, `${c - 1.5}`, `${c}`, '1000'),
  );
  const names = (bars: OhlcvBar[]): string[] => candlePatterns(bars).patterns.map((p) => p.pattern);

  it('hammer after a decline', () => {
    expect(names([...fall, bar(7, '96', '99.2', '88', '99', '1000')])).toEqual(['HAMMER']);
  });
  it('the same candle after an advance is not a hammer', () => {
    expect(names([...rise, bar(7, '96', '99.2', '88', '99', '1000')])).not.toContain('HAMMER');
  });
  it('shooting star after an advance', () => {
    expect(names([...rise, bar(7, '97', '108', '96.8', '100', '1000')])).toEqual(['SHOOTING_STAR']);
  });
  it('doji', () => {
    expect(
      names([bar(0, '100', '101', '99', '100', '1'), bar(1, '100', '102', '98', '100.1', '1')]),
    ).toContain('DOJI');
  });
  it('bullish and bearish engulfing', () => {
    expect(
      names([bar(0, '100', '100.5', '97.5', '98', '1'), bar(1, '97', '101.5', '96.5', '101', '1')]),
    ).toEqual(['BULLISH_ENGULFING']);
    expect(
      names([bar(0, '98', '100.5', '97.5', '100', '1'), bar(1, '101', '101.5', '96.5', '97', '1')]),
    ).toEqual(['BEARISH_ENGULFING']);
  });
  it('a smaller body does not engulf', () => {
    expect(
      names([bar(0, '100', '100.5', '97.5', '98', '1'), bar(1, '98.5', '100', '98', '99.5', '1')]),
    ).toEqual([]);
  });
  it('warm flag needs context bars', () => {
    expect(candlePatterns([bar(0, '1', '2', '1', '2', '1'), bar(1, '2', '3', '2', '3', '1')]).warm).toBe(
      false,
    );
  });
});

describe('look-ahead safety (technical)', () => {
  const barArb = fc.record({
    c: fc.integer({ min: 50, max: 150 }),
    up: fc.integer({ min: 0, max: 5 }),
    dn: fc.integer({ min: 0, max: 5 }),
    v: fc.integer({ min: 100, max: 1000 }),
  });
  const mk = (rows: { c: number; up: number; dn: number; v: number }[]): OhlcvBar[] =>
    rows.map((r, i) => bar(i, `${r.c}`, `${r.c + r.up}`, `${r.c - r.dn}`, `${r.c}`, `${r.v}`));

  it('pivots known at bar k are identical whether or not later bars exist', () => {
    fc.assert(
      fc.property(
        fc.array(barArb, { minLength: 30, maxLength: 70 }),
        fc.integer({ min: 10, max: 29 }),
        (rows, k) => {
          const full = mk(rows);
          const prefix = full.slice(0, k + 1);
          const known = swingPivots(full, 3, 3).filter((p) => p.confirmedAt <= k);
          const fromPrefix = swingPivots(prefix, 3, 3);
          expect(fromPrefix.map((p) => [p.index, p.price.toString(), p.kind])).toEqual(
            known.map((p) => [p.index, p.price.toString(), p.kind]),
          );
        },
      ),
    );
  });

  it('ADX at bar k does not depend on later bars', () => {
    fc.assert(
      fc.property(
        fc.array(barArb, { minLength: 40, maxLength: 70 }),
        fc.integer({ min: 20, max: 39 }),
        (rows, k) => {
          const full = mk(rows);
          const a = adxSeries(full, 5)[k];
          const b = adxSeries(full.slice(0, k + 1), 5)[k];
          expect(b?.adx?.toString()).toBe(a?.adx?.toString());
          expect(b?.plusDi.toString()).toBe(a?.plusDi.toString());
        },
      ),
    );
  });

  it('analysis of a prefix ignores mutated future bars', () => {
    const full = driftBars(150);
    const k = 119;
    const mutated = full.map((b, i) => (i > k ? { ...b, close: d('1'), high: d('999'), volume: d('1') } : b));
    for (const fn of [
      trendAnalysis,
      momentumScore,
      volumeAnalysis,
      candlePatterns,
      breakoutAnalysis,
      supportResistance,
      adxAnalysis,
    ]) {
      const a = JSON.stringify(fn(full.slice(0, k + 1)));
      const b = JSON.stringify(fn(mutated.slice(0, k + 1)));
      expect(b).toBe(a);
    }
  });
});
