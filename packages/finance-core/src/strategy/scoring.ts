/**
 * Signal confidence score 0–100 (docs/08 §9). Fully explainable and deterministic.
 *
 * Four components, each scored 0–100 from the BULLISH point of view, then mirrored for exits:
 *
 *  trend      (weight 30)  = 50·[close > EMA(slow)] + 50·[EMA(fast) > EMA(slow)]           (defaults 20 / 50)
 *  momentum   (weight 30)  = 0.5·RSI(14) + 0.5·M, where M = 100 if MACD histogram > 0, 50 if = 0, 0 if < 0
 *  volume     (weight 20)  = min(100, 50 · volume / SMA(volume, 20))   — 1x average volume = 50, ≥2x = 100
 *  volatility (weight 20)  = 100 − percentileRank(ATR%(14)) over the last 100 bars (incl. current),
 *                            percentileRank = 100 · (#below + ½·#equal) / N  (mid-rank, needs N ≥ 20).
 *                            Calm regimes (low ATR% vs own history) score high.
 *
 * Direction: for ENTRY (long) the components are used as-is. For EXIT the directional components are mirrored
 * (trend' = 100 − trend, momentum' = 100 − momentum); volume and volatility are direction-neutral
 * confirmation and are unchanged.
 *
 * total = Σ wᵢ·sᵢ / Σ wᵢ over AVAILABLE components (warm and defined), rounded half-up to an integer.
 * If no component is available, total = 50 (no information). Components are reported rounded to 2 dp;
 * the total is computed from unrounded component values.
 */
import { type Decimal, fromInt, HUNDRED, min, round, sum, ZERO } from '../decimal.js';
import { assertPeriod } from '../indicators/internal.js';
import { EmaIndicator, VolumeSmaIndicator } from '../indicators/moving-averages.js';
import { MacdIndicator, RsiIndicator } from '../indicators/oscillators.js';
import { type OhlcvBar } from '../indicators/types.js';
import { AtrIndicator } from '../indicators/volatility.js';
import { type StrategySignalType } from './types.js';

export type SignalScoreComponentName = 'trend' | 'momentum' | 'volume' | 'volatility';

export interface SignalScoreConfig {
  readonly trendFastPeriod: number;
  readonly trendSlowPeriod: number;
  readonly rsiPeriod: number;
  readonly macdFast: number;
  readonly macdSlow: number;
  readonly macdSignal: number;
  readonly volumePeriod: number;
  readonly atrPeriod: number;
  readonly volatilityLookback: number;
  readonly volatilityMinSamples: number;
  readonly weights: Readonly<Record<SignalScoreComponentName, number>>;
}

export const DEFAULT_SIGNAL_SCORE_CONFIG: SignalScoreConfig = {
  trendFastPeriod: 20,
  trendSlowPeriod: 50,
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  volumePeriod: 20,
  atrPeriod: 14,
  volatilityLookback: 100,
  volatilityMinSamples: 20,
  weights: { trend: 30, momentum: 30, volume: 20, volatility: 20 },
};

export interface SignalScoreComponent {
  readonly name: SignalScoreComponentName;
  readonly weight: number;
  readonly available: boolean;
  /** 0–100 (2 dp) or null when unavailable. */
  readonly score: Decimal | null;
  readonly detail: string;
}

export interface SignalScore {
  /** Integer 0–100. */
  readonly total: Decimal;
  readonly direction: StrategySignalType;
  readonly components: readonly SignalScoreComponent[];
}

const FIFTY = fromInt(50);
const show = (x: Decimal | null): string => (x === null ? 'n/a' : round(x, 2).toString());

/** Streaming scorer; call `update(bar)` on every bar, then `score(direction)`. */
export class SignalScorer {
  private readonly cfg: SignalScoreConfig;
  private readonly emaFast: EmaIndicator;
  private readonly emaSlow: EmaIndicator;
  private readonly rsi: RsiIndicator;
  private readonly macd: MacdIndicator;
  private readonly volSma: VolumeSmaIndicator;
  private readonly atr: AtrIndicator;
  private readonly atrPctHistory: Decimal[] = [];
  private lastBar: OhlcvBar | null = null;

  constructor(config: Partial<SignalScoreConfig> = {}) {
    this.cfg = { ...DEFAULT_SIGNAL_SCORE_CONFIG, ...config };
    const c = this.cfg;
    assertPeriod('volatilityLookback', c.volatilityLookback);
    assertPeriod('volatilityMinSamples', c.volatilityMinSamples);
    for (const w of Object.values(c.weights)) {
      if (!Number.isSafeInteger(w) || w < 0) throw new RangeError('score weights must be non-negative integers');
    }
    this.emaFast = new EmaIndicator(c.trendFastPeriod);
    this.emaSlow = new EmaIndicator(c.trendSlowPeriod);
    this.rsi = new RsiIndicator(c.rsiPeriod);
    this.macd = new MacdIndicator(c.macdFast, c.macdSlow, c.macdSignal);
    this.volSma = new VolumeSmaIndicator(c.volumePeriod);
    this.atr = new AtrIndicator(c.atrPeriod);
  }

  update(bar: OhlcvBar): void {
    this.emaFast.update(bar);
    this.emaSlow.update(bar);
    this.rsi.update(bar);
    this.macd.update(bar);
    this.volSma.update(bar);
    const atr = this.atr.update(bar);
    if (atr !== null && !bar.close.isZero()) {
      this.atrPctHistory.push(atr.div(bar.close).times(HUNDRED));
      if (this.atrPctHistory.length > this.cfg.volatilityLookback) this.atrPctHistory.shift();
    }
    this.lastBar = bar;
  }

  score(direction: StrategySignalType): SignalScore {
    const bar = this.lastBar;
    const w = this.cfg.weights;
    const bearish = direction === 'EXIT';
    const mirror = (x: Decimal): Decimal => (bearish ? HUNDRED.minus(x) : x);
    const comps: { name: SignalScoreComponentName; raw: Decimal | null; detail: string }[] = [];

    // trend
    const ef = this.emaFast.value;
    const es = this.emaSlow.value;
    if (bar && ef !== null && es !== null) {
      const bull = (bar.close.gt(es) ? FIFTY : ZERO).plus(ef.gt(es) ? FIFTY : ZERO);
      comps.push({
        name: 'trend',
        raw: mirror(bull),
        detail: `close=${show(bar.close)} vs EMA(${this.cfg.trendSlowPeriod})=${show(es)}; EMA(${this.cfg.trendFastPeriod})=${show(ef)}`,
      });
    } else comps.push({ name: 'trend', raw: null, detail: 'trend EMAs warming up' });

    // momentum
    const rsi = this.rsi.value;
    const m = this.macd.value;
    if (rsi !== null && m !== null) {
      const macdPart = m.histogram.gt(0) ? HUNDRED : m.histogram.isZero() ? FIFTY : ZERO;
      const bull = rsi.plus(macdPart).div(2);
      comps.push({ name: 'momentum', raw: mirror(bull), detail: `RSI(${this.cfg.rsiPeriod})=${show(rsi)}; MACD hist=${show(m.histogram)}` });
    } else comps.push({ name: 'momentum', raw: null, detail: 'RSI/MACD warming up' });

    // volume
    const vs = this.volSma.value;
    if (bar && vs !== null && vs.gt(0)) {
      const ratio = bar.volume.div(vs);
      comps.push({ name: 'volume', raw: min(HUNDRED, FIFTY.times(ratio)), detail: `volume/SMA(${this.cfg.volumePeriod})=${show(ratio)}x` });
    } else comps.push({ name: 'volume', raw: null, detail: 'volume average unavailable' });

    // volatility regime
    const hist = this.atrPctHistory;
    const cur = hist[hist.length - 1];
    if (cur !== undefined && hist.length >= this.cfg.volatilityMinSamples) {
      let below = 0;
      let equal = 0;
      for (const v of hist) {
        if (v.lt(cur)) below++;
        else if (v.eq(cur)) equal++;
      }
      const rank = fromInt(2 * below + equal).times(HUNDRED).div(fromInt(2 * hist.length));
      comps.push({
        name: 'volatility',
        raw: HUNDRED.minus(rank),
        detail: `ATR%=${show(cur)} at percentile ${show(rank)} of last ${hist.length} bars`,
      });
    } else comps.push({ name: 'volatility', raw: null, detail: 'ATR% history too short' });

    const avail = comps.filter((c) => c.raw !== null && w[c.name] > 0);
    const wsum = avail.reduce((a, c) => a + w[c.name], 0);
    const total =
      wsum === 0 ? FIFTY : sum(avail.map((c) => (c.raw as Decimal).times(fromInt(w[c.name])))).div(fromInt(wsum));
    return {
      total: round(total, 0, 'HALF_UP'),
      direction,
      components: comps.map((c) => ({
        name: c.name,
        weight: w[c.name],
        available: c.raw !== null,
        score: c.raw === null ? null : round(c.raw, 2),
        detail: c.detail,
      })),
    };
  }
}
