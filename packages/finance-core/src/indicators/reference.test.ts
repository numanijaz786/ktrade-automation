import { describe, expect, it } from 'vitest';
import { d, type Decimal, round } from '../decimal.js';
import {
  atrSeries,
  bollingerSeries,
  emaSeries,
  highestSeries,
  lowestSeries,
  macdSeries,
  rocSeries,
  rsiSeries,
  smaSeries,
  volumeSmaSeries,
  wmaSeries,
  type OhlcvBar,
} from './index.js';

// ───────── exact rational arithmetic (independent reference implementation) ─────────
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
    if (m === 0n) throw new Error('div0');
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
  isZero(): boolean {
    return this.n === 0n;
  }
  gt0(): boolean {
    return this.n > 0n;
  }
  /** |this - x| < 10^-25 * max(1, |this|) */
  approxEquals(x: Decimal): boolean {
    const diff = this.sub(Q.of(x.toFixed()));
    const scale = babs(this.n) > this.m ? new Q(babs(this.n), this.m) : new Q(1n);
    const lhs = new Q(babs(diff.n), diff.m);
    const bound = scale.mul(new Q(1n, 10n ** 25n));
    return lhs.sub(bound).n < 0n;
  }
}
const qi = (x: number): Q => new Q(BigInt(x));

function refRsi(closes: string[], period: number): (Q | null)[] {
  const v = closes.map(Q.of);
  const out: (Q | null)[] = [null];
  let ag: Q | null = null;
  let al = qi(0);
  let gs = qi(0);
  let ls = qi(0);
  for (let i = 1; i < v.length; i++) {
    const ch = v[i]!.sub(v[i - 1]!);
    const g = ch.gt0() ? ch : qi(0);
    const l = ch.gt0() || ch.isZero() ? qi(0) : qi(0).sub(ch);
    if (ag === null) {
      gs = gs.add(g);
      ls = ls.add(l);
      if (i === period) {
        ag = gs.div(qi(period));
        al = ls.div(qi(period));
      }
    } else {
      ag = ag.mul(qi(period - 1)).add(g).div(qi(period));
      al = al.mul(qi(period - 1)).add(l).div(qi(period));
    }
    if (ag === null) out.push(null);
    else {
      // classic form: 100 - 100 / (1 + RS)
      out.push(al.isZero() ? qi(100) : qi(100).sub(qi(100).div(qi(1).add(ag.div(al)))));
    }
  }
  return out;
}

function refEma(values: string[], period: number): (Q | null)[] {
  const v = values.map(Q.of);
  const k = new Q(2n, BigInt(period + 1));
  const out: (Q | null)[] = [];
  let prev: Q | null = null;
  let s = qi(0);
  v.forEach((x, i) => {
    if (prev === null) {
      s = s.add(x);
      if (i + 1 === period) prev = s.div(qi(period));
    } else prev = prev.add(k.mul(x.sub(prev)));
    out.push(prev);
  });
  return out;
}

const D = (xs: (string | number)[]): Decimal[] => xs.map((x) => d(String(x)));
const str = (xs: (Decimal | null)[]): (string | null)[] => xs.map((x) => (x === null ? null : x.toString()));
const bar = (h: string, l: string, c: string, o = c, v = '0'): OhlcvBar => ({
  ts: '2024-01-01T00:00:00Z',
  open: d(o),
  high: d(h),
  low: d(l),
  close: d(c),
  volume: d(v),
});

// StockCharts' Wilder RSI worked example (14-period).
const RSI_CLOSES = [
  '44.34', '44.09', '44.15', '43.61', '44.33', '44.83', '45.10', '45.42', '45.84', '46.08', '45.89', '46.03',
  '45.61', '46.28', '46.28', '46.00', '46.03', '46.41', '46.22', '45.64', '46.21', '46.25', '45.71', '46.45',
  '45.78', '45.35', '44.03', '44.18', '44.22', '44.57', '43.42', '42.66', '43.13',
];

describe('indicator reference values', () => {
  it('SMA / WMA / volume SMA by hand', () => {
    expect(str(smaSeries(D([1, 2, 3, 4, 5]), 3))).toEqual([null, null, '2', '3', '4']);
    const w = wmaSeries(D([1, 2, 3, 4]), 3);
    expect(w[0]).toBeNull();
    expect(w[2]!.eq(d('14').div(6))).toBe(true); // (1*1+2*2+3*3)/6
    expect(w[3]!.eq(d('20').div(6))).toBe(true); // (2+6+12)/6
    const vs = volumeSmaSeries([bar('1', '1', '1', '1', '100'), bar('1', '1', '1', '1', '300')], 2);
    expect(str(vs)).toEqual([null, '200']);
  });

  it('EMA seeded with SMA; exact on a dyadic example', () => {
    // period 3 → alpha 0.5; seed (1+2+3)/3 = 2; then 3, 4, 5
    expect(str(emaSeries(D([1, 2, 3, 4, 5, 6]), 3))).toEqual([null, null, '2', '3', '4', '5']);
  });

  it('EMA matches an exact rational reference (non-terminating alpha 1/3)', () => {
    const xs = ['10', '11.5', '9.75', '12', '13.25', '12.5', '14', '13', '15.5', '16'];
    const ref = refEma(xs, 5);
    const got = emaSeries(D(xs), 5);
    ref.forEach((r, i) => {
      if (r === null) expect(got[i]).toBeNull();
      else expect(r.approxEquals(got[i]!)).toBe(true);
    });
  });

  it('RSI (Wilder) reproduces the StockCharts textbook example', () => {
    const got = rsiSeries(D(RSI_CLOSES), 14);
    const ref = refRsi(RSI_CLOSES, 14);
    expect(got.slice(0, 14).every((x) => x === null)).toBe(true);
    ref.forEach((r, i) => {
      if (r === null) expect(got[i]).toBeNull();
      else expect(r.approxEquals(got[i]!)).toBe(true);
    });
    // Exact (unrounded-intermediate) values; they match the StockCharts spreadsheet (first RSI 70.46).
    // The article prose quotes 70.53 because it rounds the average gain/loss to 2 dp before dividing.
    const rounded = got.slice(14).map((x) => round(x!, 2).toFixed(2));
    expect(rounded).toEqual([
      '70.46', '66.25', '66.48', '69.35', '66.29', '57.92', '62.88', '63.21', '56.01', '62.34', '54.67',
      '50.39', '40.02', '41.49', '41.90', '45.50', '37.32', '33.09', '37.79',
    ]);
  });

  it('RSI edge cases: monotone up = 100, monotone down = 0, flat = 50', () => {
    expect(rsiSeries(D([1, 2, 3, 4]), 3)[3]!.toString()).toBe('100');
    expect(rsiSeries(D([4, 3, 2, 1]), 3)[3]!.toString()).toBe('0');
    expect(rsiSeries(D([5, 5, 5, 5]), 3)[3]!.toString()).toBe('50');
  });

  it('MACD by hand (2/3/2)', () => {
    const out = macdSeries(D([1, 2, 3, 4, 5, 6]), 2, 3, 2);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]!.macd.toString()).toBe('0.5');
    expect(out[3]!.signal.toString()).toBe('0.5');
    expect(out[5]!.histogram.isZero()).toBe(true);
    expect(() => macdSeries(D([1]), 26, 12, 9)).toThrow(RangeError);
  });

  it('MACD line equals EMA(fast) - EMA(slow)', () => {
    const xs = D(RSI_CLOSES);
    const m = macdSeries(xs, 12, 26, 5);
    const f = emaSeries(xs, 12);
    const s = emaSeries(xs, 26);
    m.forEach((v, i) => {
      if (v !== null) expect(v.macd.eq(f[i]!.minus(s[i]!))).toBe(true);
    });
    expect(m.findIndex((v) => v !== null)).toBe(26 + 5 - 2);
  });

  it('ATR (Wilder) by hand', () => {
    const bars = [bar('10', '8', '9'), bar('11', '9', '10'), bar('12', '10', '11'), bar('10', '7', '8')];
    // TR1 = 2, TR2 = 2, TR3 = max(3, 1, 4) = 4; ATR2 = 2; ATR3 = (2*1 + 4)/2 = 3
    expect(str(atrSeries(bars, 2))).toEqual([null, null, '2', '3']);
  });

  it('Bollinger: textbook population std-dev example', () => {
    const bb = bollingerSeries(D([2, 4, 4, 4, 5, 5, 7, 9]), 8, '2');
    const v = bb[7]!;
    expect(v.middle.toString()).toBe('5');
    expect(v.stdDev.toString()).toBe('2');
    expect(v.upper.toString()).toBe('9');
    expect(v.lower.toString()).toBe('1');
    expect(bb[6]).toBeNull();
  });

  it('ROC by hand; null on zero base', () => {
    expect(str(rocSeries(D(['10', '11', '12.1']), 1))).toEqual([null, '10', '10']);
    expect(str(rocSeries(D(['10', '11', '12.1']), 2))).toEqual([null, null, '21']);
    expect(rocSeries(D(['0', '1']), 1)[1]).toBeNull();
  });

  it('rolling highest / lowest include the current value', () => {
    const xs = D([3, 1, 4, 1, 5, 9, 2, 6]);
    expect(str(highestSeries(xs, 3))).toEqual([null, null, '4', '4', '5', '9', '9', '9']);
    expect(str(lowestSeries(xs, 3))).toEqual([null, null, '1', '1', '1', '1', '2', '2']);
  });

  it('rejects invalid periods', () => {
    expect(() => smaSeries([], 0)).toThrow(RangeError);
    expect(() => emaSeries([], 1.5)).toThrow(RangeError);
  });
});
