/**
 * Technical analysis that the base indicators module does not cover (docs/10 §2, docs/12).
 * Pure, deterministic, decimal-only. Every function receives bars up to and including the decision bar
 * and nothing else; every result carries `warm` and an `explanation` list ("what triggered").
 * No look-ahead: swing pivots are only reported once `right` later bars confirm them.
 */
import { d, type Decimal, fromInt, HUNDRED, sum, ZERO } from '../decimal.js';
import { smaSeries } from '../indicators/moving-averages.js';
import { macdSeries, rocSeries, rsiSeries } from '../indicators/oscillators.js';
import { type OhlcvBar } from '../indicators/types.js';
import { trueRange } from '../indicators/volatility.js';
import { type TechnicalResult } from './types.js';
import { at, fmt, scale100 } from './util.js';

const last = <T>(xs: readonly T[]): T | null => (xs.length === 0 ? null : (xs[xs.length - 1] as T));

// ───────────────────────────── ADX (Wilder) ─────────────────────────────

export interface AdxValue {
  readonly plusDi: Decimal;
  readonly minusDi: Decimal;
  readonly adx: Decimal | null;
}

/**
 * Wilder ADX. +DM = up-move if up > down and up > 0 (else 0); -DM mirrored. TR, +DM, -DM are seeded with the
 * SUM of the first `period` values (bars 1..period) and then smoothed S_t = S_{t-1} - S_{t-1}/period + x_t.
 * +DI = 100 * S(+DM)/S(TR); DX = 100 * |+DI - -DI| / (+DI + -DI) (0 when both are 0);
 * ADX is seeded with the mean of the first `period` DX values, then (ADX_{t-1}(period-1) + DX_t)/period.
 * DI is available from index `period`; ADX from index `2*period - 1` (needs 2*period bars).
 */
export function adxSeries(bars: readonly OhlcvBar[], period = 14): (AdxValue | null)[] {
  if (!Number.isSafeInteger(period) || period < 1)
    throw new RangeError('ADX: period must be an integer >= 1');
  const n = fromInt(period);
  const out: (AdxValue | null)[] = bars.map(() => null);
  let sTr = ZERO;
  let sP = ZERO;
  let sM = ZERO;
  const dxs: Decimal[] = [];
  let adx: Decimal | null = null;
  for (let i = 1; i < bars.length; i++) {
    const b = at(bars, i);
    const p = at(bars, i - 1);
    const tr = trueRange(b, p.close);
    const up = b.high.minus(p.high);
    const down = p.low.minus(b.low);
    const pdm = up.gt(down) && up.gt(0) ? up : ZERO;
    const mdm = down.gt(up) && down.gt(0) ? down : ZERO;
    if (i < period) {
      sTr = sTr.plus(tr);
      sP = sP.plus(pdm);
      sM = sM.plus(mdm);
      continue;
    }
    if (i === period) {
      sTr = sTr.plus(tr);
      sP = sP.plus(pdm);
      sM = sM.plus(mdm);
    } else {
      sTr = sTr.minus(sTr.div(n)).plus(tr);
      sP = sP.minus(sP.div(n)).plus(pdm);
      sM = sM.minus(sM.div(n)).plus(mdm);
    }
    const plusDi = sTr.isZero() ? ZERO : HUNDRED.times(sP).div(sTr);
    const minusDi = sTr.isZero() ? ZERO : HUNDRED.times(sM).div(sTr);
    const di = plusDi.plus(minusDi);
    const dx = di.isZero() ? ZERO : HUNDRED.times(plusDi.minus(minusDi).abs()).div(di);
    dxs.push(dx);
    if (dxs.length === period) adx = sum(dxs).div(n);
    else if (dxs.length > period && adx !== null)
      adx = adx
        .times(period - 1)
        .plus(dx)
        .div(n);
    out[i] = { plusDi, minusDi, adx };
  }
  return out;
}

export interface AdxAnalysis extends TechnicalResult {
  readonly adx: Decimal | null;
  readonly plusDi: Decimal | null;
  readonly minusDi: Decimal | null;
  /** NONE (adx < weakBelow), DEVELOPING, STRONG (adx >= strongFrom); null while not warm. */
  readonly strength: 'NONE' | 'DEVELOPING' | 'STRONG' | null;
  readonly direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null;
}

export function adxAnalysis(
  bars: readonly OhlcvBar[],
  opts: { period?: number; weakBelow?: Decimal; strongFrom?: Decimal } = {},
): AdxAnalysis {
  const period = opts.period ?? 14;
  const weakBelow = opts.weakBelow ?? d('20');
  const strongFrom = opts.strongFrom ?? d('25');
  const v = last(adxSeries(bars, period));
  if (v === null || v.adx === null) {
    return {
      warm: false,
      adx: null,
      plusDi: v?.plusDi ?? null,
      minusDi: v?.minusDi ?? null,
      strength: null,
      direction: null,
      explanation: [`ADX(${period}) needs ${2 * period} bars; have ${bars.length}`],
    };
  }
  const strength = v.adx.lt(weakBelow) ? 'NONE' : v.adx.gte(strongFrom) ? 'STRONG' : 'DEVELOPING';
  const direction = v.plusDi.gt(v.minusDi) ? 'BULLISH' : v.plusDi.lt(v.minusDi) ? 'BEARISH' : 'NEUTRAL';
  return {
    warm: true,
    adx: v.adx,
    plusDi: v.plusDi,
    minusDi: v.minusDi,
    strength,
    direction,
    explanation: [
      `ADX(${period}) ${fmt(v.adx)} is ${strength} (weak < ${fmt(weakBelow, 0)}, strong >= ${fmt(strongFrom, 0)})`,
      `+DI ${fmt(v.plusDi)} vs -DI ${fmt(v.minusDi)} => ${direction}`,
    ],
  };
}

// ───────────────────────────── Support / resistance ─────────────────────────────

export interface SwingPivot {
  readonly index: number;
  readonly price: Decimal;
  readonly kind: 'HIGH' | 'LOW';
  /** Index of the bar at which the pivot became known (index + right). Look-ahead guard. */
  readonly confirmedAt: number;
}

/**
 * Swing pivots. A pivot high at i has high_i strictly greater than the `left` previous highs and >= the `right`
 * following highs (so the first of two equal highs counts, the second does not); pivot lows are mirrored.
 */
export function swingPivots(bars: readonly OhlcvBar[], left = 3, right = 3): SwingPivot[] {
  if (left < 1 || right < 1) throw new RangeError('swingPivots: left/right must be >= 1');
  const out: SwingPivot[] = [];
  for (let i = left; i < bars.length - right; i++) {
    const b = at(bars, i);
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      const o = at(bars, j);
      if (j < i) {
        if (b.high.lte(o.high)) isHigh = false;
        if (b.low.gte(o.low)) isLow = false;
      } else {
        if (b.high.lt(o.high)) isHigh = false;
        if (b.low.gt(o.low)) isLow = false;
      }
    }
    if (isHigh) out.push({ index: i, price: b.high, kind: 'HIGH', confirmedAt: i + right });
    if (isLow) out.push({ index: i, price: b.low, kind: 'LOW', confirmedAt: i + right });
  }
  return out;
}

export interface PriceLevel {
  /** Mean of the clustered pivot prices. */
  readonly price: Decimal;
  /** Number of pivots merged into this level. */
  readonly touches: number;
  readonly lastTouchIndex: number;
  readonly type: 'SUPPORT' | 'RESISTANCE';
}

export interface SupportResistance extends TechnicalResult {
  /** Ascending by price. */
  readonly levels: readonly PriceLevel[];
  /** Highest level at or below the last close. */
  readonly support: PriceLevel | null;
  /** Lowest level above the last close. */
  readonly resistance: PriceLevel | null;
  readonly pivotCount: number;
}

export interface SupportResistanceOptions {
  left?: number;
  right?: number;
  /** Pivots within this % of the running cluster mean merge. Default 1. */
  clusterTolerancePct?: Decimal;
  minBars?: number;
}

export function supportResistance(
  bars: readonly OhlcvBar[],
  opts: SupportResistanceOptions = {},
): SupportResistance {
  const left = opts.left ?? 3;
  const right = opts.right ?? 3;
  const tol = opts.clusterTolerancePct ?? d('1');
  const minBars = opts.minBars ?? 30;
  const lastBar = last(bars);
  if (lastBar === null || bars.length < minBars) {
    return {
      warm: false,
      levels: [],
      support: null,
      resistance: null,
      pivotCount: 0,
      explanation: [`support/resistance needs ${minBars} bars; have ${bars.length}`],
    };
  }
  const pivots = swingPivots(bars, left, right).sort((a, b) => a.price.cmp(b.price) || a.index - b.index);
  const clusters: SwingPivot[][] = [];
  let cur: SwingPivot[] = [];
  let curSum = ZERO;
  for (const p of pivots) {
    if (cur.length > 0 && p.price.lte(curSum.div(cur.length).times(HUNDRED.plus(tol)).div(HUNDRED))) {
      cur.push(p);
      curSum = curSum.plus(p.price);
    } else {
      if (cur.length > 0) clusters.push(cur);
      cur = [p];
      curSum = p.price;
    }
  }
  if (cur.length > 0) clusters.push(cur);
  const close = lastBar.close;
  const levels: PriceLevel[] = clusters.map((c) => ({
    price: sum(c.map((p) => p.price)).div(c.length),
    touches: c.length,
    lastTouchIndex: c.reduce((m, p) => (p.index > m ? p.index : m), 0),
    type: sum(c.map((p) => p.price))
      .div(c.length)
      .lte(close)
      ? 'SUPPORT'
      : 'RESISTANCE',
  }));
  const support = last(levels.filter((l) => l.type === 'SUPPORT'));
  const resistance = levels.find((l) => l.type === 'RESISTANCE') ?? null;
  const explanation = [
    `${pivots.length} swing pivots (left ${left}, right ${right}) clustered within ${fmt(tol)}% into ${levels.length} levels`,
    support
      ? `nearest support ${fmt(support.price)} (${support.touches} touches)`
      : 'no support level below the close',
    resistance
      ? `nearest resistance ${fmt(resistance.price)} (${resistance.touches} touches)`
      : 'no resistance level above the close',
  ];
  return { warm: true, levels, support, resistance, pivotCount: pivots.length, explanation };
}

// ───────────────────────────── Volume analysis ─────────────────────────────

export interface VolumeAnalysis extends TechnicalResult {
  /** Latest volume / mean volume of the 20 bars BEFORE the latest. */
  readonly relativeVolume: Decimal | null;
  readonly avgVolume20: Decimal | null;
  /** Mean of close x volume over the latest 20 bars (incl. the latest). */
  readonly avgTradedValue20: Decimal | null;
  /** Cumulative Chaikin accumulation/distribution line value at the latest bar. */
  readonly adLine: Decimal | null;
  readonly adTrend: 'ACCUMULATION' | 'DISTRIBUTION' | 'FLAT' | null;
}

/** Money-flow multiplier ((C-L)-(H-C))/(H-L); 0 for a zero-range bar. */
export function moneyFlowMultiplier(b: OhlcvBar): Decimal {
  const range = b.high.minus(b.low);
  return range.isZero() ? ZERO : b.close.minus(b.low).minus(b.high.minus(b.close)).div(range);
}

export function volumeAnalysis(
  bars: readonly OhlcvBar[],
  opts: { period?: number; adLookback?: number } = {},
): VolumeAnalysis {
  const period = opts.period ?? 20;
  const adLookback = opts.adLookback ?? 10;
  const n = bars.length;
  const lastBar = last(bars);
  const ad: Decimal[] = [];
  let acc = ZERO;
  for (const b of bars) {
    acc = acc.plus(moneyFlowMultiplier(b).times(b.volume));
    ad.push(acc);
  }
  const adLine = last(ad);
  const explanation: string[] = [];
  let adTrend: VolumeAnalysis['adTrend'] = null;
  if (n > adLookback) {
    const delta = at(ad, n - 1).minus(at(ad, n - 1 - adLookback));
    adTrend = delta.gt(0) ? 'ACCUMULATION' : delta.lt(0) ? 'DISTRIBUTION' : 'FLAT';
    explanation.push(`A/D line changed ${fmt(delta, 0)} over ${adLookback} bars => ${adTrend}`);
  } else explanation.push(`A/D trend needs ${adLookback + 1} bars; have ${n}`);
  if (lastBar === null || n < period + 1) {
    explanation.push(`relative volume needs ${period + 1} bars; have ${n}`);
    return {
      warm: false,
      relativeVolume: null,
      avgVolume20: null,
      avgTradedValue20: null,
      adLine,
      adTrend,
      explanation,
    };
  }
  const prior = bars.slice(n - 1 - period, n - 1);
  const avgVol = sum(prior.map((b) => b.volume)).div(period);
  const window = bars.slice(n - period);
  const avgTv = sum(window.map((b) => b.close.times(b.volume))).div(period);
  const rel = avgVol.isZero() ? null : lastBar.volume.div(avgVol);
  explanation.push(
    rel === null
      ? `prior ${period}-bar average volume is zero; relative volume undefined`
      : `volume ${fmt(lastBar.volume, 0)} is ${fmt(rel)}x the prior ${period}-bar average ${fmt(avgVol, 0)}`,
  );
  return {
    warm: rel !== null && adTrend !== null,
    relativeVolume: rel,
    avgVolume20: avgVol,
    avgTradedValue20: avgTv,
    adLine,
    adTrend,
    explanation,
  };
}

// ───────────────────────────── Trend classification ─────────────────────────────

export type TrendClass =
  'STRONG_UPTREND' | 'UPTREND' | 'SIDEWAYS' | 'DOWNTREND' | 'STRONG_DOWNTREND' | 'UNKNOWN';

export interface TrendAnalysis extends TechnicalResult {
  readonly classification: TrendClass;
  readonly close: Decimal | null;
  readonly sma20: Decimal | null;
  readonly sma50: Decimal | null;
  readonly sma100: Decimal | null;
  readonly sma200: Decimal | null;
  /** % change of SMA50 over `slopeLookback` bars. */
  readonly sma50SlopePct: Decimal | null;
  readonly bullishConditions: number;
  readonly bearishConditions: number;
  readonly evaluatedConditions: number;
}

/**
 * Alignment conditions (each evaluated only when both sides are warm): close > SMA20, SMA20 > SMA50,
 * SMA50 > SMA100, SMA100 > SMA200. STRONG_UPTREND = all evaluated bullish and SMA50 slope > 0;
 * UPTREND = >= 2/3 bullish and close > SMA50; mirrored for down; otherwise SIDEWAYS. `warm` = all four evaluated.
 */
export function trendAnalysis(
  bars: readonly OhlcvBar[],
  opts: { slopeLookback?: number } = {},
): TrendAnalysis {
  const lookback = opts.slopeLookback ?? 10;
  const closes = bars.map((b) => b.close);
  const s = ([20, 50, 100, 200] as const).map((p) => smaSeries(closes, p));
  const i = bars.length - 1;
  const v = (k: number, idx = i): Decimal | null => (idx < 0 ? null : (s[k]?.[idx] ?? null));
  const close = i >= 0 ? at(closes, i) : null;
  const [sma20, sma50, sma100, sma200] = [v(0), v(1), v(2), v(3)];
  const pairs: [string, Decimal | null, Decimal | null][] = [
    ['close > SMA20', close, sma20],
    ['SMA20 > SMA50', sma20, sma50],
    ['SMA50 > SMA100', sma50, sma100],
    ['SMA100 > SMA200', sma100, sma200],
  ];
  let bull = 0;
  let bear = 0;
  let evaluated = 0;
  const explanation: string[] = [];
  for (const [label, a, b] of pairs) {
    if (a === null || b === null) {
      explanation.push(`${label}: not available (warm-up)`);
      continue;
    }
    evaluated++;
    if (a.gt(b)) bull++;
    else if (a.lt(b)) bear++;
    explanation.push(
      `${label}: ${a.gt(b) ? 'yes' : a.lt(b) ? 'no (reversed)' : 'equal'} (${fmt(a)} vs ${fmt(b)})`,
    );
  }
  const prev50 = v(1, i - lookback);
  const slope =
    sma50 !== null && prev50 !== null && !prev50.isZero()
      ? sma50.minus(prev50).div(prev50).times(HUNDRED)
      : null;
  if (slope !== null) explanation.push(`SMA50 slope over ${lookback} bars: ${fmt(slope)}%`);
  let classification: TrendClass = 'UNKNOWN';
  if (evaluated > 0 && close !== null) {
    const above50 = sma50 !== null ? close.gt(sma50) : bull * 2 > evaluated;
    const below50 = sma50 !== null ? close.lt(sma50) : bear * 2 > evaluated;
    if (bull === evaluated && slope !== null && slope.gt(0)) classification = 'STRONG_UPTREND';
    else if (bear === evaluated && slope !== null && slope.lt(0)) classification = 'STRONG_DOWNTREND';
    else if (bull * 3 >= evaluated * 2 && above50) classification = 'UPTREND';
    else if (bear * 3 >= evaluated * 2 && below50) classification = 'DOWNTREND';
    else classification = 'SIDEWAYS';
  }
  explanation.push(
    `trend classification: ${classification} (${bull} bullish / ${bear} bearish of ${evaluated} conditions)`,
  );
  return {
    warm: evaluated === 4,
    classification,
    close,
    sma20,
    sma50,
    sma100,
    sma200,
    sma50SlopePct: slope,
    bullishConditions: bull,
    bearishConditions: bear,
    evaluatedConditions: evaluated,
    explanation,
  };
}

// ───────────────────────────── Breakout ─────────────────────────────

export interface BreakoutAnalysis extends TechnicalResult {
  /** Close crossed above a resistance level (previous close <= level < close). */
  readonly crossed: boolean;
  /** Crossed AND relative volume >= threshold. */
  readonly confirmed: boolean;
  readonly level: PriceLevel | null;
  readonly relativeVolume: Decimal | null;
}

/**
 * Levels are computed from bars BEFORE the latest bar (so the latest bar cannot create its own resistance).
 * Only levels with >= `minTouches` touches count. The highest crossed level is reported.
 */
export function breakoutAnalysis(
  bars: readonly OhlcvBar[],
  opts: { minTouches?: number; minRelativeVolume?: Decimal } & SupportResistanceOptions = {},
): BreakoutAnalysis {
  const minTouches = opts.minTouches ?? 2;
  const minRel = opts.minRelativeVolume ?? d('1.5');
  const n = bars.length;
  const vol = volumeAnalysis(bars);
  const sr = supportResistance(bars.slice(0, n - 1), opts);
  if (n < 2 || !sr.warm || !vol.warm) {
    return {
      warm: false,
      crossed: false,
      confirmed: false,
      level: null,
      relativeVolume: vol.relativeVolume,
      explanation: ['breakout detection needs warm support/resistance and volume history'],
    };
  }
  const close = at(bars, n - 1).close;
  const prevClose = at(bars, n - 2).close;
  const crossedLevels = sr.levels.filter(
    (l) => l.touches >= minTouches && prevClose.lte(l.price) && close.gt(l.price),
  );
  const level = last(crossedLevels);
  const rel = vol.relativeVolume as Decimal;
  const confirmed = level !== null && rel.gte(minRel);
  return {
    warm: true,
    crossed: level !== null,
    confirmed,
    level,
    relativeVolume: rel,
    explanation:
      level !== null
        ? [
            `close ${fmt(close)} crossed above resistance ${fmt(level.price)} (${level.touches} touches); previous close ${fmt(prevClose)}`,
            `relative volume ${fmt(rel)}x ${confirmed ? '>=' : '<'} ${fmt(minRel)}x => ${confirmed ? 'volume-confirmed' : 'NOT volume-confirmed'}`,
          ]
        : [`no resistance level with >= ${minTouches} touches crossed on the latest bar`],
  };
}

// ───────────────────────────── Momentum score ─────────────────────────────

export interface MomentumComponent {
  readonly name: string;
  /** 0..25 */
  readonly points: Decimal;
  readonly detail: string;
}
export interface MomentumScore extends TechnicalResult {
  /** 0..100; null unless all four components are available (never estimated). */
  readonly score: Decimal | null;
  readonly components: readonly MomentumComponent[];
}

/**
 * Four components, 25 points each: RSI(14) (30 -> 0, 70 -> 25, linear), MACD(12,26,9) histogram (15 if > 0, +10 if
 * rising vs the previous bar), ROC(20) (-10% -> 0, +10% -> 25, linear), close vs SMA50 (-5% -> 0, +5% -> 25).
 */
export function momentumScore(bars: readonly OhlcvBar[]): MomentumScore {
  const closes = bars.map((b) => b.close);
  const i = closes.length - 1;
  const comps: MomentumComponent[] = [];
  const explanation: string[] = [];
  const rsi = i >= 0 ? at(rsiSeries(closes, 14), i) : null;
  if (rsi !== null) {
    comps.push({
      name: 'RSI14',
      points: scale100(rsi, d('30'), d('70')).div(4),
      detail: `RSI ${fmt(rsi)}${rsi.gt(70) ? ' (overbought)' : ''}`,
    });
  } else explanation.push('RSI14 not available');
  const macd = macdSeries(closes);
  const m = i >= 0 ? at(macd, i) : null;
  const mPrev = i >= 1 ? at(macd, i - 1) : null;
  if (m !== null) {
    const rising = mPrev !== null && m.histogram.gt(mPrev.histogram);
    comps.push({
      name: 'MACD',
      points: (m.histogram.gt(0) ? d('15') : ZERO).plus(rising ? d('10') : ZERO),
      detail: `histogram ${fmt(m.histogram, 4)} ${m.histogram.gt(0) ? '>' : '<='} 0, ${rising ? 'rising' : 'not rising'}`,
    });
  } else explanation.push('MACD not available');
  const roc = i >= 0 ? at(rocSeries(closes, 20), i) : null;
  if (roc !== null) {
    comps.push({
      name: 'ROC20',
      points: scale100(roc, d('-10'), d('10')).div(4),
      detail: `ROC20 ${fmt(roc)}%`,
    });
  } else explanation.push('ROC20 not available');
  const sma50 = i >= 0 ? at(smaSeries(closes, 50), i) : null;
  if (sma50 !== null && !sma50.isZero()) {
    const dist = at(closes, i).minus(sma50).div(sma50).times(HUNDRED);
    comps.push({
      name: 'CLOSE_VS_SMA50',
      points: scale100(dist, d('-5'), d('5')).div(4),
      detail: `close is ${fmt(dist)}% from SMA50`,
    });
  } else explanation.push('SMA50 not available');
  const warm = comps.length === 4;
  const score = warm ? sum(comps.map((c) => c.points)) : null;
  for (const c of comps) explanation.push(`${c.name}: ${fmt(c.points)}/25 (${c.detail})`);
  if (score !== null) explanation.push(`momentum score ${fmt(score)}/100`);
  return { warm, score, components: comps, explanation };
}

// ───────────────────────────── Candlestick patterns ─────────────────────────────

export type CandlePatternName =
  'DOJI' | 'HAMMER' | 'SHOOTING_STAR' | 'BULLISH_ENGULFING' | 'BEARISH_ENGULFING';
export interface CandlePattern {
  readonly pattern: CandlePatternName;
  readonly bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  readonly explanation: string;
}
export interface CandlePatterns extends TechnicalResult {
  /** Patterns on the latest bar. */
  readonly patterns: readonly CandlePattern[];
}

/**
 * Definitions (range = high-low > 0, body = |close-open|):
 * DOJI body <= 10% of range. HAMMER body > 0, lower shadow >= 2x body, upper shadow <= 10% of range, after a
 * decline (previous close below the close `context` bars earlier). SHOOTING_STAR mirrored after an advance.
 * BULLISH_ENGULFING: previous bar bearish, latest bullish, latest open <= previous close and latest close >=
 * previous open (at least one strict). BEARISH_ENGULFING mirrored.
 */
export function candlePatterns(bars: readonly OhlcvBar[], opts: { context?: number } = {}): CandlePatterns {
  const context = opts.context ?? 5;
  const n = bars.length;
  if (n < 2) return { warm: false, patterns: [], explanation: ['candlestick patterns need >= 2 bars'] };
  const b = at(bars, n - 1);
  const p = at(bars, n - 2);
  const range = b.high.minus(b.low);
  const body = b.close.minus(b.open).abs();
  const bodyTop = b.close.gt(b.open) ? b.close : b.open;
  const bodyBottom = b.close.gt(b.open) ? b.open : b.close;
  const upper = b.high.minus(bodyTop);
  const lower = bodyBottom.minus(b.low);
  const out: CandlePattern[] = [];
  const warm = n >= context + 2;
  if (range.gt(0) && body.times(10).lte(range)) {
    out.push({
      pattern: 'DOJI',
      bias: 'NEUTRAL',
      explanation: `body ${fmt(body)} <= 10% of range ${fmt(range)}`,
    });
  }
  if (warm && range.gt(0) && body.gt(0)) {
    const ref = at(bars, n - 2 - context).close;
    if (lower.gte(body.times(2)) && upper.times(10).lte(range) && p.close.lt(ref)) {
      out.push({
        pattern: 'HAMMER',
        bias: 'BULLISH',
        explanation: `lower shadow ${fmt(lower)} >= 2x body ${fmt(body)}, tiny upper shadow, after decline (${fmt(p.close)} < ${fmt(ref)})`,
      });
    }
    if (upper.gte(body.times(2)) && lower.times(10).lte(range) && p.close.gt(ref)) {
      out.push({
        pattern: 'SHOOTING_STAR',
        bias: 'BEARISH',
        explanation: `upper shadow ${fmt(upper)} >= 2x body ${fmt(body)}, tiny lower shadow, after advance (${fmt(p.close)} > ${fmt(ref)})`,
      });
    }
  }
  const pBear = p.close.lt(p.open);
  const pBull = p.close.gt(p.open);
  if (
    pBear &&
    b.close.gt(b.open) &&
    b.open.lte(p.close) &&
    b.close.gte(p.open) &&
    (b.open.lt(p.close) || b.close.gt(p.open))
  ) {
    out.push({
      pattern: 'BULLISH_ENGULFING',
      bias: 'BULLISH',
      explanation: `bullish body ${fmt(b.open)}->${fmt(b.close)} engulfs bearish body ${fmt(p.open)}->${fmt(p.close)}`,
    });
  }
  if (
    pBull &&
    b.close.lt(b.open) &&
    b.open.gte(p.close) &&
    b.close.lte(p.open) &&
    (b.open.gt(p.close) || b.close.lt(p.open))
  ) {
    out.push({
      pattern: 'BEARISH_ENGULFING',
      bias: 'BEARISH',
      explanation: `bearish body ${fmt(b.open)}->${fmt(b.close)} engulfs bullish body ${fmt(p.open)}->${fmt(p.close)}`,
    });
  }
  return {
    warm,
    patterns: out,
    explanation:
      out.length > 0
        ? out.map((x) => `${x.pattern}: ${x.explanation}`)
        : ['no candlestick pattern on the latest bar'],
  };
}
