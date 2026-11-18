/**
 * The recommendation rule table (docs/12 §3). Each rule is a pure predicate over a snapshot of the already
 * computed metrics: it passes, fails, or is UNAVAILABLE (its input is missing). Every PASS is cited in the
 * output with the metric value and the threshold. A rule never estimates a missing input.
 *
 * Bearish rules flagged `structural` (trend break / fundamental deterioration) are the ONLY rules that can
 * justify a SELL. Temporary-decline signals (RSI, a single red candle, close < SMA20) are never structural.
 */
import { type Decimal, fromInt, ZERO } from '../decimal.js';
import { atrSeries } from '../indicators/volatility.js';
import { macdSeries } from '../indicators/oscillators.js';
import { rsiSeries } from '../indicators/oscillators.js';
import { type RatioKey, type DividendRecord, type FundamentalsReport, ratioValue } from './fundamentals.js';
import { type RecommendationConfig, type RuleDomain, type RuleOutcome } from './rec-types.js';
import {
  adxAnalysis,
  type AdxAnalysis,
  type BreakoutAnalysis,
  breakoutAnalysis,
  type CandlePatterns,
  candlePatterns,
  type MomentumScore,
  momentumScore,
  type SupportResistance,
  supportResistance,
  type TrendAnalysis,
  trendAnalysis,
  type VolumeAnalysis,
  volumeAnalysis,
} from './technical.js';
import { type Horizon, type ResearchBar } from './types.js';
import { type ValuationSummary } from './valuation.js';
import { at, fmt, parseTs } from './util.js';

export interface TechSnapshot {
  readonly close: Decimal;
  readonly atr: Decimal | null;
  readonly rsi: Decimal | null;
  readonly macdHistogram: Decimal | null;
  readonly trend: TrendAnalysis;
  readonly adx: AdxAnalysis;
  readonly sr: SupportResistance;
  readonly vol: VolumeAnalysis;
  readonly breakout: BreakoutAnalysis;
  readonly momentum: MomentumScore;
  readonly candles: CandlePatterns;
}

/** All technical metrics at the decision bar (the last element of `bars`). Requires >= 1 bar. */
export function computeTechSnapshot(bars: readonly ResearchBar[], cfg: RecommendationConfig): TechSnapshot {
  const closes = bars.map((b) => b.close);
  const i = bars.length - 1;
  return {
    close: at(closes, i),
    atr: at(atrSeries(bars, cfg.atrPeriod), i),
    rsi: at(rsiSeries(closes, 14), i),
    macdHistogram: at(macdSeries(closes), i)?.histogram ?? null,
    trend: trendAnalysis(bars),
    adx: adxAnalysis(bars),
    sr: supportResistance(bars),
    vol: volumeAnalysis(bars),
    breakout: breakoutAnalysis(bars),
    momentum: momentumScore(bars),
    candles: candlePatterns(bars),
  };
}

export interface DividendRecordAnalysis {
  /** How many of the 3 most recent COMPLETED calendar years (by ex-date) had a dividend. */
  readonly yearsPaidOfLast3: number;
  readonly lastYearDps: Decimal;
  readonly prevYearDps: Decimal;
  /** Last completed year's total is below the year before (and the year before paid). */
  readonly cut: boolean;
  readonly lastYear: number;
}

export function dividendRecordAnalysis(
  history: readonly DividendRecord[] | null | undefined,
  asOf: string,
): DividendRecordAnalysis | null {
  if (!history) return null;
  const y = new Date(parseTs(asOf)).getUTCFullYear();
  const total = (year: number): Decimal =>
    history
      .filter((r) => new Date(parseTs(r.exDate)).getUTCFullYear() === year)
      .reduce((a, r) => a.plus(r.amountPerShare), ZERO);
  const t1 = total(y - 1);
  const t2 = total(y - 2);
  const t3 = total(y - 3);
  const paid = [t1, t2, t3].filter((t) => t.gt(0)).length;
  return {
    yearsPaidOfLast3: paid,
    lastYearDps: t1,
    prevYearDps: t2,
    cut: t2.gt(0) && t1.lt(t2),
    lastYear: y - 1,
  };
}

export interface RuleContext {
  readonly tech: TechSnapshot;
  readonly fund: FundamentalsReport | null;
  readonly val: ValuationSummary | null;
  readonly divs: DividendRecordAnalysis | null;
  readonly cfg: RecommendationConfig;
}

type Test = (c: RuleContext) => { pass: boolean; value: string } | null;
export interface RuleDef {
  readonly id: string;
  readonly domain: RuleDomain;
  readonly side: 'BULL' | 'BEAR';
  readonly weight: number;
  readonly structural: boolean;
  readonly label: string;
  readonly threshold: (c: RecommendationConfig) => string;
  readonly test: Test;
}

const def = (
  id: string,
  domain: RuleDomain,
  side: 'BULL' | 'BEAR',
  weight: number,
  structural: boolean,
  label: string,
  threshold: RuleDef['threshold'],
  test: Test,
): RuleDef => ({ id, domain, side, weight, structural, label, threshold, test });

const cmp = (
  a: Decimal | null,
  b: Decimal | null,
  f: (a: Decimal, b: Decimal) => boolean,
  v: string,
): ReturnType<Test> => (a === null || b === null ? null : { pass: f(a, b), value: v });

const R = (c: RuleContext, k: RatioKey): Decimal | null => (c.fund ? ratioValue(c.fund, k) : null);
const dmax = (a: Decimal, b: Decimal): boolean => a.gt(b);

// ───────────────────────────── technical rules ─────────────────────────────
const closeGtSma = (n: 20 | 50 | 200, w: number): RuleDef =>
  def(
    `T_CLOSE_GT_SMA${n}`,
    'TECHNICAL',
    'BULL',
    w,
    false,
    `close above SMA${n}`,
    () => `close > SMA${n}`,
    (c) => {
      const s = n === 20 ? c.tech.trend.sma20 : n === 50 ? c.tech.trend.sma50 : c.tech.trend.sma200;
      return cmp(c.tech.close, s, dmax, `close ${fmt(c.tech.close)} vs SMA${n} ${s ? fmt(s) : 'n/a'}`);
    },
  );
const smaOver = (a: 20 | 50, b: 50 | 200, w: number): RuleDef =>
  def(
    `T_SMA${a}_GT_SMA${b}`,
    'TECHNICAL',
    'BULL',
    w,
    false,
    `SMA${a} above SMA${b}`,
    () => `SMA${a} > SMA${b}`,
    (c) => {
      const pick = (n: number): Decimal | null =>
        n === 20 ? c.tech.trend.sma20 : n === 50 ? c.tech.trend.sma50 : c.tech.trend.sma200;
      const x = pick(a);
      const y = pick(b);
      return cmp(x, y, dmax, `SMA${a} ${x ? fmt(x) : 'n/a'} vs SMA${b} ${y ? fmt(y) : 'n/a'}`);
    },
  );
const trendUp = (w: number): RuleDef =>
  def(
    'T_TREND_UP',
    'TECHNICAL',
    'BULL',
    w,
    false,
    'trend classified up',
    () => 'UPTREND or STRONG_UPTREND',
    (c) =>
      c.tech.trend.classification === 'UNKNOWN'
        ? null
        : {
            pass:
              c.tech.trend.classification === 'UPTREND' || c.tech.trend.classification === 'STRONG_UPTREND',
            value: c.tech.trend.classification,
          },
  );
const trendDown = (w: number): RuleDef =>
  def(
    'T_TREND_DOWN',
    'TECHNICAL',
    'BEAR',
    w,
    true,
    'trend classified down',
    () => 'DOWNTREND or STRONG_DOWNTREND',
    (c) =>
      c.tech.trend.classification === 'UNKNOWN'
        ? null
        : {
            pass:
              c.tech.trend.classification === 'DOWNTREND' ||
              c.tech.trend.classification === 'STRONG_DOWNTREND',
            value: c.tech.trend.classification,
          },
  );
const closeLtSma50 = (w: number): RuleDef =>
  def(
    'T_CLOSE_LT_SMA50',
    'TECHNICAL',
    'BEAR',
    w,
    true,
    'close below SMA50 (trend break)',
    () => 'close < SMA50',
    (c) =>
      cmp(
        c.tech.close,
        c.tech.trend.sma50,
        (a, b) => a.lt(b),
        `close ${fmt(c.tech.close)} vs SMA50 ${c.tech.trend.sma50 ? fmt(c.tech.trend.sma50) : 'n/a'}`,
      ),
  );
const deathZone = (w: number): RuleDef =>
  def(
    'T_BELOW_SMA200_AND_SMA50_BELOW',
    'TECHNICAL',
    'BEAR',
    w,
    true,
    'close below SMA200 and SMA50 below SMA200',
    () => 'close < SMA200 and SMA50 < SMA200',
    (c) => {
      const { sma50, sma200 } = c.tech.trend;
      if (sma50 === null || sma200 === null) return null;
      return {
        pass: c.tech.close.lt(sma200) && sma50.lt(sma200),
        value: `close ${fmt(c.tech.close)}, SMA50 ${fmt(sma50)}, SMA200 ${fmt(sma200)}`,
      };
    },
  );
const rsiHealthy = (w: number): RuleDef =>
  def(
    'T_RSI_HEALTHY',
    'TECHNICAL',
    'BULL',
    w,
    false,
    'RSI14 in the healthy band',
    (cfg) => `${fmt(cfg.rsiHealthyLow, 0)} <= RSI14 <= ${fmt(cfg.rsiHealthyHigh, 0)}`,
    (c) =>
      c.tech.rsi === null
        ? null
        : {
            pass: c.tech.rsi.gte(c.cfg.rsiHealthyLow) && c.tech.rsi.lte(c.cfg.rsiHealthyHigh),
            value: `RSI14 ${fmt(c.tech.rsi)}`,
          },
  );
const rsiOverbought = (w: number): RuleDef =>
  def(
    'T_RSI_OVERBOUGHT',
    'TECHNICAL',
    'BEAR',
    w,
    false,
    'RSI14 overbought',
    (cfg) => `RSI14 > ${fmt(cfg.rsiOverbought, 0)}`,
    (c) =>
      c.tech.rsi === null
        ? null
        : { pass: c.tech.rsi.gt(c.cfg.rsiOverbought), value: `RSI14 ${fmt(c.tech.rsi)}` },
  );
const macdPos = (w: number): RuleDef =>
  def(
    'T_MACD_POSITIVE',
    'TECHNICAL',
    'BULL',
    w,
    false,
    'MACD histogram positive',
    () => 'histogram > 0',
    (c) =>
      c.tech.macdHistogram === null
        ? null
        : { pass: c.tech.macdHistogram.gt(0), value: `histogram ${fmt(c.tech.macdHistogram, 4)}` },
  );
const macdNeg = (w: number): RuleDef =>
  def(
    'T_MACD_NEGATIVE',
    'TECHNICAL',
    'BEAR',
    w,
    false,
    'MACD histogram negative',
    () => 'histogram < 0',
    (c) =>
      c.tech.macdHistogram === null
        ? null
        : { pass: c.tech.macdHistogram.lt(0), value: `histogram ${fmt(c.tech.macdHistogram, 4)}` },
  );
const adxBull = (w: number): RuleDef =>
  def(
    'T_ADX_BULLISH',
    'TECHNICAL',
    'BULL',
    w,
    false,
    'ADX shows a bullish trend',
    (cfg) => `ADX >= ${fmt(cfg.adxTrend, 0)} and +DI > -DI`,
    (c) =>
      !c.tech.adx.warm || c.tech.adx.adx === null
        ? null
        : {
            pass: c.tech.adx.adx.gte(c.cfg.adxTrend) && c.tech.adx.direction === 'BULLISH',
            value: `ADX ${fmt(c.tech.adx.adx)}, ${c.tech.adx.direction}`,
          },
  );
const adxBear = (w: number): RuleDef =>
  def(
    'T_ADX_BEARISH',
    'TECHNICAL',
    'BEAR',
    w,
    false,
    'ADX shows a bearish trend',
    (cfg) => `ADX >= ${fmt(cfg.adxTrend, 0)} and -DI > +DI`,
    (c) =>
      !c.tech.adx.warm || c.tech.adx.adx === null
        ? null
        : {
            pass: c.tech.adx.adx.gte(c.cfg.adxTrend) && c.tech.adx.direction === 'BEARISH',
            value: `ADX ${fmt(c.tech.adx.adx)}, ${c.tech.adx.direction}`,
          },
  );
const relVol = (w: number): RuleDef =>
  def(
    'T_RELATIVE_VOLUME',
    'TECHNICAL',
    'BULL',
    w,
    false,
    'volume above its 20-day average',
    (cfg) => `relative volume >= ${fmt(cfg.relVolMin)}x`,
    (c) =>
      c.tech.vol.relativeVolume === null
        ? null
        : {
            pass: c.tech.vol.relativeVolume.gte(c.cfg.relVolMin),
            value: `${fmt(c.tech.vol.relativeVolume)}x`,
          },
  );
const breakoutRule = (w: number): RuleDef =>
  def(
    'T_BREAKOUT_CONFIRMED',
    'TECHNICAL',
    'BULL',
    w,
    false,
    'volume-confirmed breakout above resistance',
    () => 'close crosses a >=2-touch resistance on relative volume >= 1.5x',
    (c) =>
      !c.tech.breakout.warm
        ? null
        : {
            pass: c.tech.breakout.confirmed,
            value: c.tech.breakout.crossed ? c.tech.breakout.explanation.join('; ') : 'no resistance crossed',
          },
  );
const momentumStrong = (w: number): RuleDef =>
  def(
    'T_MOMENTUM_STRONG',
    'TECHNICAL',
    'BULL',
    w,
    false,
    'momentum score strong',
    (cfg) => `score >= ${fmt(cfg.momentumStrong, 0)}`,
    (c) =>
      c.tech.momentum.score === null
        ? null
        : {
            pass: c.tech.momentum.score.gte(c.cfg.momentumStrong),
            value: `score ${fmt(c.tech.momentum.score)}`,
          },
  );
const momentumWeak = (w: number): RuleDef =>
  def(
    'T_MOMENTUM_WEAK',
    'TECHNICAL',
    'BEAR',
    w,
    false,
    'momentum score weak',
    (cfg) => `score <= ${fmt(cfg.momentumWeak, 0)}`,
    (c) =>
      c.tech.momentum.score === null
        ? null
        : {
            pass: c.tech.momentum.score.lte(c.cfg.momentumWeak),
            value: `score ${fmt(c.tech.momentum.score)}`,
          },
  );
const candleBull = (w: number): RuleDef =>
  def(
    'T_CANDLE_BULLISH',
    'TECHNICAL',
    'BULL',
    w,
    false,
    'bullish candlestick on the latest bar',
    () => 'hammer or bullish engulfing',
    (c) =>
      !c.tech.candles.warm
        ? null
        : (() => {
            const hit = c.tech.candles.patterns.filter((p) => p.bias === 'BULLISH').map((p) => p.pattern);
            return { pass: hit.length > 0, value: hit.length > 0 ? hit.join(', ') : 'none' };
          })(),
  );
const candleBear = (w: number): RuleDef =>
  def(
    'T_CANDLE_BEARISH',
    'TECHNICAL',
    'BEAR',
    w,
    false,
    'bearish candlestick on the latest bar',
    () => 'shooting star or bearish engulfing',
    (c) =>
      !c.tech.candles.warm
        ? null
        : (() => {
            const hit = c.tech.candles.patterns.filter((p) => p.bias === 'BEARISH').map((p) => p.pattern);
            return { pass: hit.length > 0, value: hit.length > 0 ? hit.join(', ') : 'none' };
          })(),
  );
const nearSupport = (w: number): RuleDef =>
  def(
    'T_NEAR_SUPPORT',
    'TECHNICAL',
    'BULL',
    w,
    false,
    'price close to support (favourable entry)',
    (cfg) => `close - support <= ${fmt(cfg.nearSupportAtr)} x ATR`,
    (c) => {
      if (c.tech.atr === null || !c.tech.sr.warm) return null;
      const s = c.tech.sr.support;
      if (!s) return { pass: false, value: 'no support below the close' };
      const dist = c.tech.close.minus(s.price);
      return {
        pass: dist.lte(c.tech.atr.times(c.cfg.nearSupportAtr)),
        value: `${fmt(dist)} above support ${fmt(s.price)}; ATR ${fmt(c.tech.atr)}`,
      };
    },
  );
const adAccum = (w: number): RuleDef =>
  def(
    'T_AD_ACCUMULATION',
    'TECHNICAL',
    'BULL',
    w,
    false,
    'accumulation/distribution line rising',
    () => 'A/D change over 10 bars > 0',
    (c) =>
      c.tech.vol.adTrend === null
        ? null
        : { pass: c.tech.vol.adTrend === 'ACCUMULATION', value: c.tech.vol.adTrend },
  );
const adDistrib = (w: number): RuleDef =>
  def(
    'T_AD_DISTRIBUTION',
    'TECHNICAL',
    'BEAR',
    w,
    false,
    'accumulation/distribution line falling',
    () => 'A/D change over 10 bars < 0',
    (c) =>
      c.tech.vol.adTrend === null
        ? null
        : { pass: c.tech.vol.adTrend === 'DISTRIBUTION', value: c.tech.vol.adTrend },
  );

// ───────────────────────────── fundamental / valuation rules ─────────────────────────────
const ratioRule = (
  id: string,
  side: 'BULL' | 'BEAR',
  weight: number,
  structural: boolean,
  label: string,
  key: RatioKey,
  threshold: (cfg: RecommendationConfig) => string,
  pass: (v: Decimal, cfg: RecommendationConfig) => boolean,
  unit = '',
): RuleDef =>
  def(id, 'FUNDAMENTAL', side, weight, structural, label, threshold, (c) => {
    const v = R(c, key);
    return v === null ? null : { pass: pass(v, c.cfg), value: `${key} ${fmt(v)}${unit}` };
  });

const mosRule = (
  id: string,
  side: 'BULL' | 'BEAR',
  weight: number,
  label: string,
  th: (cfg: RecommendationConfig) => string,
  pass: (m: Decimal, cfg: RecommendationConfig) => boolean,
): RuleDef =>
  def(id, 'VALUATION', side, weight, false, label, th, (c) => {
    const m = c.val?.marginOfSafetyPct ?? null;
    return m === null
      ? null
      : {
          pass: pass(m, c.cfg),
          value: `margin of safety ${fmt(m)}% (lowest fair value ${c.val?.fairValueLow ? fmt(c.val.fairValueLow) : 'n/a'})`,
        };
  });

const revPos = (w: number): RuleDef =>
  ratioRule(
    'F_REVENUE_GROWTH_POSITIVE',
    'BULL',
    w,
    false,
    'revenue growing year on year',
    'revenueGrowthYoY',
    () => 'YoY > 0%',
    (v) => v.gt(0),
    '%',
  );
const revNeg = (w: number): RuleDef =>
  ratioRule(
    'F_REVENUE_GROWTH_NEGATIVE',
    'BEAR',
    w,
    true,
    'revenue shrinking year on year',
    'revenueGrowthYoY',
    () => 'YoY < 0%',
    (v) => v.lt(0),
    '%',
  );
const revHigh = (w: number): RuleDef =>
  ratioRule(
    'F_REVENUE_GROWTH_HIGH',
    'BULL',
    w,
    false,
    'strong revenue growth',
    'revenueGrowthYoY',
    (cfg) => `YoY >= ${fmt(cfg.growthHighPct, 0)}%`,
    (v, cfg) => v.gte(cfg.growthHighPct),
    '%',
  );
const epsHigh = (w: number): RuleDef =>
  ratioRule(
    'F_EPS_GROWTH_HIGH',
    'BULL',
    w,
    false,
    'strong EPS growth',
    'epsGrowthYoY',
    (cfg) => `YoY >= ${fmt(cfg.growthHighPct, 0)}%`,
    (v, cfg) => v.gte(cfg.growthHighPct),
    '%',
  );
const epsNeg = (w: number): RuleDef =>
  ratioRule(
    'F_EPS_GROWTH_NEGATIVE',
    'BEAR',
    w,
    true,
    'EPS shrinking year on year',
    'epsGrowthYoY',
    () => 'YoY < 0%',
    (v) => v.lt(0),
    '%',
  );
const marginPos = (w: number): RuleDef =>
  ratioRule(
    'F_NET_MARGIN_POSITIVE',
    'BULL',
    w,
    false,
    'profitable (net margin)',
    'netMargin',
    () => 'net margin > 0%',
    (v) => v.gt(0),
    '%',
  );
const marginNeg = (w: number): RuleDef =>
  ratioRule(
    'F_NET_MARGIN_NEGATIVE',
    'BEAR',
    w,
    true,
    'loss-making (net margin)',
    'netMargin',
    () => 'net margin < 0%',
    (v) => v.lt(0),
    '%',
  );
const roeMin = (w: number): RuleDef =>
  ratioRule(
    'F_ROE_MIN',
    'BULL',
    w,
    false,
    'return on equity adequate',
    'roe',
    (cfg) => `ROE >= ${fmt(cfg.roeMinPct, 0)}%`,
    (v, cfg) => v.gte(cfg.roeMinPct),
    '%',
  );
const deMax = (w: number): RuleDef =>
  ratioRule(
    'F_DEBT_TO_EQUITY_OK',
    'BULL',
    w,
    false,
    'moderate leverage',
    'debtToEquity',
    (cfg) => `D/E <= ${fmt(cfg.debtToEquityMax)}`,
    (v, cfg) => v.lte(cfg.debtToEquityMax),
  );
const deBear = (w: number): RuleDef =>
  ratioRule(
    'F_DEBT_TO_EQUITY_HIGH',
    'BEAR',
    w,
    false,
    'high leverage',
    'debtToEquity',
    (cfg) => `D/E > ${fmt(cfg.debtToEquityBear)}`,
    (v, cfg) => v.gt(cfg.debtToEquityBear),
  );
const fcfPos = (w: number): RuleDef =>
  ratioRule(
    'F_FREE_CASH_FLOW_POSITIVE',
    'BULL',
    w,
    false,
    'positive free cash flow',
    'freeCashFlow',
    () => 'FCF > 0',
    (v) => v.gt(0),
  );
const fcfNeg = (w: number): RuleDef =>
  ratioRule(
    'F_FREE_CASH_FLOW_NEGATIVE',
    'BEAR',
    w,
    false,
    'negative free cash flow',
    'freeCashFlow',
    () => 'FCF < 0',
    (v) => v.lt(0),
  );
const peLow = (w: number): RuleDef =>
  ratioRule(
    'F_PE_LOW',
    'BULL',
    w,
    false,
    'low P/E',
    'pe',
    (cfg) => `0 < P/E <= ${fmt(cfg.peMaxValue, 0)}`,
    (v, cfg) => v.gt(0) && v.lte(cfg.peMaxValue),
  );
const pbLow = (w: number): RuleDef =>
  ratioRule(
    'F_PB_LOW',
    'BULL',
    w,
    false,
    'low P/B',
    'pb',
    (cfg) => `0 < P/B <= ${fmt(cfg.pbMaxValue)}`,
    (v, cfg) => v.gt(0) && v.lte(cfg.pbMaxValue),
  );
const yieldMin = (w: number): RuleDef =>
  ratioRule(
    'F_DIVIDEND_YIELD_MIN',
    'BULL',
    w,
    false,
    'dividend yield adequate',
    'dividendYield',
    (cfg) => `yield >= ${fmt(cfg.dividendYieldMinPct, 0)}%`,
    (v, cfg) => v.gte(cfg.dividendYieldMinPct),
    '%',
  );
const payoutOk = (w: number): RuleDef =>
  ratioRule(
    'F_PAYOUT_SUSTAINABLE',
    'BULL',
    w,
    false,
    'sustainable payout ratio',
    'payoutRatio',
    (cfg) => `0 < payout <= ${fmt(cfg.payoutMaxPct, 0)}%`,
    (v, cfg) => v.gt(0) && v.lte(cfg.payoutMaxPct),
    '%',
  );
const payoutBad = (w: number): RuleDef =>
  ratioRule(
    'F_PAYOUT_UNSUSTAINABLE',
    'BEAR',
    w,
    true,
    'dividend exceeds earnings',
    'payoutRatio',
    () => 'payout > 100%',
    (v) => v.gt(100),
    '%',
  );
const divYears = (w: number): RuleDef =>
  def(
    'F_DIVIDEND_CONSISTENT',
    'FUNDAMENTAL',
    'BULL',
    w,
    false,
    'dividends paid in each of the last 3 years',
    () => '3 of 3 completed years',
    (c) =>
      c.divs === null
        ? null
        : { pass: c.divs.yearsPaidOfLast3 === 3, value: `${c.divs.yearsPaidOfLast3} of 3 years` },
  );
const divCut = (w: number): RuleDef =>
  def(
    'F_DIVIDEND_CUT',
    'FUNDAMENTAL',
    'BEAR',
    w,
    true,
    'dividend cut',
    () => 'last year DPS < previous year DPS',
    (c) =>
      c.divs === null
        ? null
        : {
            pass: c.divs.cut,
            value: `${c.divs.lastYear} DPS ${fmt(c.divs.lastYearDps)} vs ${fmt(c.divs.prevYearDps)}`,
          },
  );
const mosMin = (w: number): RuleDef =>
  mosRule(
    'V_MARGIN_OF_SAFETY',
    'BULL',
    w,
    'price below conservative fair value',
    (cfg) => `margin of safety >= ${fmt(cfg.mosMinPct, 0)}%`,
    (m, cfg) => m.gte(cfg.mosMinPct),
  );
const mosValue = (w: number): RuleDef =>
  mosRule(
    'V_MARGIN_OF_SAFETY_DEEP',
    'BULL',
    w,
    'price well below conservative fair value',
    (cfg) => `margin of safety >= ${fmt(cfg.mosValuePct, 0)}%`,
    (m, cfg) => m.gte(cfg.mosValuePct),
  );
const overvalued = (w: number): RuleDef =>
  mosRule(
    'V_OVERVALUED',
    'BEAR',
    w,
    'price well above fair value',
    (cfg) => `margin of safety <= ${fmt(cfg.overvaluedPct, 0)}%`,
    (m, cfg) => m.lte(cfg.overvaluedPct),
  );

/** The rule table per horizon. Weights are integers; they only matter relative to each other. */
export const RULE_TABLE: Readonly<Record<Horizon, readonly RuleDef[]>> = {
  SHORT_TERM: [
    closeGtSma(20, 2),
    rsiHealthy(2),
    macdPos(2),
    relVol(1),
    momentumStrong(2),
    adxBull(2),
    breakoutRule(3),
    candleBull(1),
    trendDown(3),
    closeLtSma50(2),
    rsiOverbought(1),
    macdNeg(2),
    adxBear(2),
    momentumWeak(1),
    candleBear(1),
  ],
  SWING: [
    closeGtSma(50, 2),
    smaOver(20, 50, 2),
    trendUp(3),
    adxBull(2),
    rsiHealthy(1),
    momentumStrong(2),
    nearSupport(2),
    adAccum(1),
    breakoutRule(2),
    trendDown(3),
    closeLtSma50(2),
    adxBear(2),
    adDistrib(1),
    macdNeg(1),
    rsiOverbought(1),
  ],
  LONG_TERM: [
    closeGtSma(200, 2),
    smaOver(50, 200, 2),
    trendUp(2),
    revPos(2),
    marginPos(2),
    roeMin(2),
    deMax(2),
    fcfPos(2),
    mosMin(3),
    deathZone(3),
    revNeg(2),
    marginNeg(3),
    fcfNeg(1),
    deBear(2),
    overvalued(2),
  ],
  DIVIDEND: [
    yieldMin(3),
    payoutOk(2),
    divYears(2),
    deMax(1),
    fcfPos(1),
    marginPos(1),
    closeGtSma(200, 1),
    mosMin(2),
    divCut(3),
    payoutBad(2),
    marginNeg(3),
    deBear(1),
    deathZone(2),
  ],
  VALUE: [
    peLow(2),
    pbLow(2),
    mosValue(3),
    roeMin(1),
    deMax(1),
    fcfPos(1),
    marginPos(1),
    marginNeg(3),
    revNeg(2),
    deBear(2),
    deathZone(1),
    overvalued(2),
  ],
  GROWTH: [
    revHigh(3),
    epsHigh(3),
    roeMin(2),
    trendUp(2),
    closeGtSma(50, 1),
    marginPos(1),
    revNeg(3),
    epsNeg(2),
    trendDown(2),
    marginNeg(2),
  ],
};

export function evaluateRules(horizon: Horizon, ctx: RuleContext): RuleOutcome[] {
  return RULE_TABLE[horizon].map((r) => {
    const t = r.test(ctx);
    return {
      id: r.id,
      domain: r.domain,
      side: r.side,
      weight: r.weight,
      structural: r.structural,
      label: r.label,
      threshold: r.threshold(ctx.cfg),
      value: t === null ? null : t.value,
      status: t === null ? 'UNAVAILABLE' : t.pass ? 'PASS' : 'FAIL',
    };
  });
}

export function scoreRules(rules: readonly RuleOutcome[]): {
  bull: Decimal;
  bear: Decimal;
  coveragePct: Decimal;
  structuralBearPassed: number;
} {
  const w = (side: 'BULL' | 'BEAR', f: (r: RuleOutcome) => boolean): number =>
    rules.filter((r) => r.side === side && f(r)).reduce((a, r) => a + r.weight, 0);
  const avail = (r: RuleOutcome): boolean => r.status !== 'UNAVAILABLE';
  const pass = (r: RuleOutcome): boolean => r.status === 'PASS';
  const pct = (a: number, b: number): Decimal => (b === 0 ? ZERO : fromInt(a).div(b).times(100));
  const total = rules.reduce((a, r) => a + r.weight, 0);
  const availTotal = rules.filter(avail).reduce((a, r) => a + r.weight, 0);
  return {
    bull: pct(w('BULL', pass), w('BULL', avail)),
    bear: pct(w('BEAR', pass), w('BEAR', avail)),
    coveragePct: pct(availTotal, total),
    structuralBearPassed: rules.filter((r) => r.side === 'BEAR' && r.structural && pass(r)).length,
  };
}
