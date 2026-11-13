/**
 * Backtest performance metrics. All percentages in percent units; all maths in Decimal.
 *
 *  totalReturnPct  = (finalEquity / initialCapital − 1) × 100
 *  cagrPct         = ((finalEquity / initialCapital)^(365 / days) − 1) × 100, days = calendar days between the
 *                    first and last bar timestamps; null if days < 1.
 *  maxDrawdownPct  = max over t of (peak_t − equity_t) / peak_t × 100 (peak includes initial capital), >= 0.
 *  sharpe          = (mean(r) − rf/A) / stdev(r) × sqrt(A), r = per-bar equity returns (daily for D1 bars),
 *                    stdev = sample (n − 1), rf = annual risk-free rate (decimal fraction = rfPct/100),
 *                    A = annualizationFactor (252 for daily bars). null if < 2 returns or stdev = 0.
 *  winRatePct      = winning trades / closed trades × 100 (win = net P&L > 0); null without trades.
 *  profitFactor    = Σ net P&L of winners / |Σ net P&L of losers|; null when there are no losing trades.
 *  avgWin / avgLoss = mean net P&L of winners / losers (avgLoss is negative); null when none.
 *  exposurePct     = bars ending with an open position / total bars × 100.
 */
import { type Decimal, fromInt, HUNDRED, ONE, pct, sum, ZERO } from '../decimal.js';

export interface BacktestEquityPoint {
  readonly ts: string;
  readonly barIndex: number;
  readonly cash: Decimal;
  readonly positionQty: Decimal;
  readonly close: Decimal;
  readonly equity: Decimal;
  /** Drawdown from the running peak, in percent (>= 0). */
  readonly drawdownPct: Decimal;
}

export interface BacktestMetricsInputTrade {
  readonly netPnl: Decimal;
}

export interface BacktestMetrics {
  readonly initialCapital: Decimal;
  readonly finalEquity: Decimal;
  readonly totalReturnPct: Decimal;
  readonly cagrPct: Decimal | null;
  readonly maxDrawdownPct: Decimal;
  readonly sharpe: Decimal | null;
  readonly tradeCount: number;
  readonly winRatePct: Decimal | null;
  readonly profitFactor: Decimal | null;
  readonly avgWin: Decimal | null;
  readonly avgLoss: Decimal | null;
  readonly exposurePct: Decimal;
  readonly feesTotal: Decimal;
  readonly buyAndHoldReturnPct: Decimal | null;
  readonly calendarDays: Decimal;
}

export interface BacktestMetricsOptions {
  /** Annual risk-free rate in percent (default 0). */
  readonly riskFreeRatePct?: Decimal;
  /** Periods per year for Sharpe annualisation (default 252). */
  readonly annualizationFactor?: number;
  readonly feesTotal: Decimal;
  readonly buyAndHoldReturnPct: Decimal | null;
}

const MS_PER_DAY = fromInt(86_400_000);

/** Calendar days between two ISO timestamps (may be fractional). */
export function calendarDaysBetween(fromTs: string, toTs: string): Decimal {
  const a = Date.parse(fromTs);
  const b = Date.parse(toTs);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) throw new RangeError(`invalid ISO timestamp: ${fromTs} / ${toTs}`);
  return fromInt(b - a).div(MS_PER_DAY);
}

const mean = (xs: readonly Decimal[]): Decimal => sum(xs).div(fromInt(xs.length));

export function computeBacktestMetrics(
  initialCapital: Decimal,
  curve: readonly BacktestEquityPoint[],
  trades: readonly BacktestMetricsInputTrade[],
  options: BacktestMetricsOptions,
): BacktestMetrics {
  if (!initialCapital.gt(0)) throw new RangeError('initialCapital must be > 0');
  const first = curve[0];
  const last = curve[curve.length - 1];
  const finalEquity = last ? last.equity : initialCapital;
  const ratio = finalEquity.div(initialCapital);
  const totalReturnPct = ratio.minus(ONE).times(HUNDRED);

  const calendarDays = first && last ? calendarDaysBetween(first.ts, last.ts) : ZERO;
  const cagrPct = calendarDays.lt(1) ? null : ratio.pow(fromInt(365).div(calendarDays)).minus(ONE).times(HUNDRED);

  const maxDrawdownPct = curve.reduce((m, p) => (p.drawdownPct.gt(m) ? p.drawdownPct : m), ZERO);

  // Sharpe on per-bar returns
  const A = options.annualizationFactor ?? 252;
  if (!Number.isSafeInteger(A) || A <= 0) throw new RangeError('annualizationFactor must be a positive integer');
  const returns: Decimal[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prevEq = (curve[i - 1] as BacktestEquityPoint).equity;
    if (prevEq.gt(0)) returns.push((curve[i] as BacktestEquityPoint).equity.div(prevEq).minus(ONE));
  }
  let sharpe: Decimal | null = null;
  if (returns.length >= 2) {
    const mu = mean(returns);
    const variance = sum(returns.map((r) => r.minus(mu).pow(2))).div(fromInt(returns.length - 1));
    if (variance.gt(0)) {
      const rfPer = (options.riskFreeRatePct ?? ZERO).div(HUNDRED).div(fromInt(A));
      sharpe = mu.minus(rfPer).div(variance.sqrt()).times(fromInt(A).sqrt());
    }
  }

  const wins = trades.filter((t) => t.netPnl.gt(0)).map((t) => t.netPnl);
  const losses = trades.filter((t) => t.netPnl.lt(0)).map((t) => t.netPnl);
  const grossProfit = sum(wins);
  const grossLoss = sum(losses).abs();

  const exposed = curve.filter((p) => p.positionQty.gt(0)).length;
  return {
    initialCapital,
    finalEquity,
    totalReturnPct,
    cagrPct,
    maxDrawdownPct,
    sharpe,
    tradeCount: trades.length,
    winRatePct: pct(fromInt(wins.length), fromInt(trades.length)),
    profitFactor: grossLoss.isZero() ? null : grossProfit.div(grossLoss),
    avgWin: wins.length > 0 ? mean(wins) : null,
    avgLoss: losses.length > 0 ? mean(losses) : null,
    exposurePct: pct(fromInt(exposed), fromInt(curve.length)) ?? ZERO,
    feesTotal: options.feesTotal,
    buyAndHoldReturnPct: options.buyAndHoldReturnPct,
    calendarDays,
  };
}
