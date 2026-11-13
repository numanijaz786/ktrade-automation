import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { d, type Decimal } from '../decimal.js';
import {
  AtrIndicator,
  atrSeries,
  BollingerIndicator,
  bollingerSeries,
  EmaIndicator,
  emaSeries,
  HighestIndicator,
  highestSeries,
  LowestIndicator,
  lowestSeries,
  MacdIndicator,
  macdSeries,
  type OhlcvBar,
  RocIndicator,
  rocSeries,
  RsiIndicator,
  rsiSeries,
  SmaIndicator,
  smaSeries,
  type StreamingIndicator,
  VolumeSmaIndicator,
  volumeSmaSeries,
  WmaIndicator,
  wmaSeries,
} from './index.js';

/** Arbitrary well-formed OHLCV bars with 2-dp prices. */
const barsArb = (minLength = 0, maxLength = 60): fc.Arbitrary<OhlcvBar[]> =>
  fc
    .array(
      fc.record({
        a: fc.integer({ min: 100, max: 20000 }),
        b: fc.integer({ min: 100, max: 20000 }),
        o: fc.integer({ min: 0, max: 100 }),
        c: fc.integer({ min: 0, max: 100 }),
        v: fc.integer({ min: 0, max: 1_000_000 }),
      }),
      { minLength, maxLength },
    )
    .map((rows) =>
      rows.map((r, i) => {
        const lo = Math.min(r.a, r.b);
        const hi = Math.max(r.a, r.b);
        const within = (p: number): number => lo + Math.floor(((hi - lo) * p) / 100);
        const cents = (x: number): Decimal => d(String(x)).div(100);
        return {
          ts: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
          open: cents(within(r.o)),
          high: cents(hi),
          low: cents(lo),
          close: cents(within(r.c)),
          volume: d(String(r.v)),
        };
      }),
    );

type Eq<T> = (a: T, b: T) => boolean;
const decEq: Eq<Decimal> = (a, b) => a.eq(b);

function assertStreamingMatches<T>(
  ind: StreamingIndicator<T>,
  bars: OhlcvBar[],
  batch: (T | null)[],
  eq: Eq<T>,
): void {
  expect(batch.length).toBe(bars.length);
  bars.forEach((b, i) => {
    const s = ind.update(b);
    const r = batch[i] ?? null;
    if (r === null) expect(s).toBeNull();
    else {
      expect(s).not.toBeNull();
      expect(eq(s as T, r)).toBe(true);
    }
    // warm-up contract: non-null exactly from index warmupBars-1 when values are defined
    if (i < ind.warmupBars - 1) expect(s).toBeNull();
  });
  expect(ind.count).toBe(bars.length);
}

const closes = (bars: OhlcvBar[]): Decimal[] => bars.map((b) => b.close);
const period = fc.integer({ min: 1, max: 12 });

describe('batch == streaming (property)', () => {
  it('SMA, EMA, WMA, ROC, RSI, volume SMA', () => {
    fc.assert(
      fc.property(barsArb(), period, (bars, p) => {
        assertStreamingMatches(new SmaIndicator(p), bars, smaSeries(closes(bars), p), decEq);
        assertStreamingMatches(new EmaIndicator(p), bars, emaSeries(closes(bars), p), decEq);
        assertStreamingMatches(new WmaIndicator(p), bars, wmaSeries(closes(bars), p), decEq);
        assertStreamingMatches(new RocIndicator(p), bars, rocSeries(closes(bars), p), decEq);
        assertStreamingMatches(new RsiIndicator(p), bars, rsiSeries(closes(bars), p), decEq);
        assertStreamingMatches(new VolumeSmaIndicator(p), bars, volumeSmaSeries(bars, p), decEq);
      }),
      { numRuns: 60 },
    );
  });

  it('ATR, Bollinger, highest, lowest', () => {
    fc.assert(
      fc.property(barsArb(), period, (bars, p) => {
        assertStreamingMatches(new AtrIndicator(p), bars, atrSeries(bars, p), decEq);
        assertStreamingMatches(
          new BollingerIndicator(p, '2.5'),
          bars,
          bollingerSeries(closes(bars), p, '2.5'),
          (a, b) => a.upper.eq(b.upper) && a.middle.eq(b.middle) && a.lower.eq(b.lower),
        );
        assertStreamingMatches(
          new HighestIndicator(p),
          bars,
          highestSeries(
            bars.map((b) => b.high),
            p,
          ),
          decEq,
        );
        assertStreamingMatches(
          new LowestIndicator(p),
          bars,
          lowestSeries(
            bars.map((b) => b.low),
            p,
          ),
          decEq,
        );
      }),
      { numRuns: 60 },
    );
  });

  it('MACD', () => {
    fc.assert(
      fc.property(
        barsArb(0, 80),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 6 }),
        (bars, f, extra, s) => {
          assertStreamingMatches(
            new MacdIndicator(f, f + extra, s),
            bars,
            macdSeries(closes(bars), f, f + extra, s),
            (a, b) => a.macd.eq(b.macd) && a.signal.eq(b.signal) && a.histogram.eq(b.histogram),
          );
        },
      ),
      { numRuns: 60 },
    );
  });

  it('bands are ordered and highest >= lowest', () => {
    fc.assert(
      fc.property(barsArb(1), period, (bars, p) => {
        const bb = bollingerSeries(closes(bars), p);
        bb.forEach((v) => {
          if (v) expect(v.lower.lte(v.middle) && v.middle.lte(v.upper)).toBe(true);
        });
        const r = rsiSeries(closes(bars), p);
        r.forEach((v) => {
          if (v) expect(v.gte(0) && v.lte(100)).toBe(true);
        });
      }),
      { numRuns: 60 },
    );
  });
});
