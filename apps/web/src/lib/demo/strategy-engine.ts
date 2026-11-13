/**
 * Demo strategy evaluator + backtester (mirrors docs/08: signal at close of bar t → fill at the
 * open of t+1 ± slippage, no look-ahead; exit priority stop-loss → trailing → take-profit → rule).
 * Indicator maths are analysis numbers; cash/positions/fees use exact Dec.
 */
import type { SignalReason, StrategyType } from '@ktrade/shared';
import { Dec } from '../decimal';
import { estimateFees } from '../fees';
import { crossesAbove, crossesBelow, ema, macd, rsi, sma, type Series } from '../indicators';
import type {
  Backtest,
  BacktestMetrics,
  BacktestRequest,
  BacktestTrade,
  StrategyParams,
  StrategyTemplate,
  TraceCondition,
} from '../api/types';
import type { RawBar } from './prices';

export const BACKTEST_DISCLAIMER =
  'Past simulated performance does not guarantee future returns. Results exclude market impact and may use simulated or delayed data.';

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    type: 'MA_CROSSOVER',
    name: 'Moving-average crossover',
    description: 'Trend-following: buy when the fast average crosses above the slow one.',
    entry: 'Fast MA crosses above slow MA',
    exit: 'Fast MA crosses below slow MA',
    parameterSchema: {
      type: 'object',
      required: ['fastPeriod', 'slowPeriod', 'maType'],
      properties: {
        fastPeriod: {
          type: 'integer',
          title: 'Fast period',
          minimum: 2,
          maximum: 100,
          default: 9,
          description: 'Bars in the fast average',
        },
        slowPeriod: {
          type: 'integer',
          title: 'Slow period',
          minimum: 5,
          maximum: 250,
          default: 21,
          description: 'Bars in the slow average; must exceed the fast period',
        },
        maType: { type: 'string', title: 'Average type', enum: ['EMA', 'SMA'], default: 'EMA' },
      },
    },
  },
  {
    type: 'RSI',
    name: 'RSI mean reversion',
    description: 'Buy when RSI recovers from oversold; sell when it falls back from overbought.',
    entry: 'RSI crosses above the oversold level',
    exit: 'RSI crosses below the overbought level',
    parameterSchema: {
      type: 'object',
      required: ['period', 'oversold', 'overbought'],
      properties: {
        period: { type: 'integer', title: 'RSI period', minimum: 2, maximum: 50, default: 14 },
        oversold: { type: 'integer', title: 'Oversold level', minimum: 5, maximum: 50, default: 30 },
        overbought: { type: 'integer', title: 'Overbought level', minimum: 50, maximum: 95, default: 70 },
      },
    },
  },
  {
    type: 'MACD',
    name: 'MACD signal cross',
    description: 'Momentum: MACD line crossing its signal line.',
    entry: 'MACD crosses above signal (optionally histogram > 0)',
    exit: 'MACD crosses below signal',
    parameterSchema: {
      type: 'object',
      required: ['fast', 'slow', 'signal'],
      properties: {
        fast: { type: 'integer', title: 'Fast EMA', minimum: 2, maximum: 50, default: 12 },
        slow: { type: 'integer', title: 'Slow EMA', minimum: 5, maximum: 100, default: 26 },
        signal: { type: 'integer', title: 'Signal EMA', minimum: 2, maximum: 50, default: 9 },
        requirePositiveHistogram: { type: 'boolean', title: 'Require histogram > 0', default: false },
      },
    },
  },
  {
    type: 'STOP_LOSS',
    name: 'Stop-loss %',
    description: 'Exit-only overlay: sell when price falls a set % below average cost.',
    entry: '— (overlay on an existing position)',
    exit: 'close ≤ avgCost × (1 − sl%)',
    parameterSchema: {
      type: 'object',
      required: ['stopLossPct'],
      properties: {
        stopLossPct: {
          type: 'string',
          format: 'percent',
          title: 'Stop-loss %',
          minimum: 0.5,
          maximum: 50,
          default: '5',
        },
      },
    },
  },
  {
    type: 'TAKE_PROFIT',
    name: 'Take-profit %',
    description: 'Exit-only overlay: sell when price rises a set % above average cost.',
    entry: '— (overlay on an existing position)',
    exit: 'close ≥ avgCost × (1 + tp%)',
    parameterSchema: {
      type: 'object',
      required: ['takeProfitPct'],
      properties: {
        takeProfitPct: {
          type: 'string',
          format: 'percent',
          title: 'Take-profit %',
          minimum: 0.5,
          maximum: 200,
          default: '10',
        },
      },
    },
  },
  {
    type: 'TRAILING_STOP',
    name: 'Trailing stop %',
    description: 'Exit-only overlay: sell when price falls a set % from its high since entry.',
    entry: '— (overlay on an existing position)',
    exit: 'close ≤ highSinceEntry × (1 − ts%)',
    parameterSchema: {
      type: 'object',
      required: ['trailingStopPct'],
      properties: {
        trailingStopPct: {
          type: 'string',
          format: 'percent',
          title: 'Trailing stop %',
          minimum: 0.5,
          maximum: 50,
          default: '7',
        },
      },
    },
  },
  {
    type: 'PRICE_ALERT',
    name: 'Price alert',
    description: 'Signal (or alert only) when price reaches a target level.',
    entry: 'close ≥ / ≤ target',
    exit: 'close ≥ / ≤ exit target',
    parameterSchema: {
      type: 'object',
      required: ['target', 'direction'],
      properties: {
        target: {
          type: 'string',
          format: 'decimal',
          title: 'Target price (Rs)',
          minimum: 0.01,
          default: '150.00',
        },
        direction: {
          type: 'string',
          title: 'Trigger when price is',
          enum: ['ABOVE', 'BELOW'],
          default: 'ABOVE',
        },
        exitTarget: {
          type: 'string',
          format: 'decimal',
          title: 'Exit target (Rs)',
          minimum: 0.01,
          default: '170.00',
        },
      },
    },
  },
];

export function defaultParams(type: StrategyType): StrategyParams {
  const t = STRATEGY_TEMPLATES.find((x) => x.type === type);
  if (!t) return {};
  return Object.fromEntries(Object.entries(t.parameterSchema.properties).map(([k, p]) => [k, p.default]));
}

export interface StrategyEvent {
  i: number;
  type: 'ENTRY' | 'EXIT';
  reason: SignalReason;
  trace: TraceCondition[];
  explanation: string;
}

const f2 = (n: number | null) => (n === null ? '—' : n.toFixed(2));
const num = (v: StrategyParams[string] | undefined, d: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};

/** Run a template across bars, returning ENTRY/EXIT events with explanation traces. */
export function runStrategy(
  type: StrategyType,
  params: StrategyParams,
  bars: readonly RawBar[],
): StrategyEvent[] {
  const closes = bars.map((b) => b.close / 100);
  const events: StrategyEvent[] = [];
  let inPos = false;
  let entryPrice = 0;
  let high = 0;
  let cooldownUntil = -1;

  let entryRule: (i: number) => StrategyEvent | null = () => null;
  let exitRule: (i: number) => StrategyEvent | null = () => null;

  if (type === 'MA_CROSSOVER') {
    const fp = num(params.fastPeriod, 9);
    const sp = num(params.slowPeriod, 21);
    const kind = params.maType === 'SMA' ? 'SMA' : 'EMA';
    const fn = kind === 'SMA' ? sma : ema;
    const fast = fn(closes, fp);
    const slow = fn(closes, sp);
    const ops = (i: number) => [
      { label: `${kind}(${fp})`, value: f2(fast[i]) },
      { label: `${kind}(${sp})`, value: f2(slow[i]) },
    ];
    entryRule = (i) =>
      crossesAbove(fast, slow, i)
        ? {
            i,
            type: 'ENTRY',
            reason: 'RULE_ENTRY',
            trace: [
              { condition: `${kind}(${fp}) crosses above ${kind}(${sp})`, operands: ops(i), result: true },
            ],
            explanation: `${kind}(${fp})=${f2(fast[i])} crossed above ${kind}(${sp})=${f2(slow[i])}`,
          }
        : null;
    exitRule = (i) =>
      crossesBelow(fast, slow, i)
        ? {
            i,
            type: 'EXIT',
            reason: 'RULE_EXIT',
            trace: [
              { condition: `${kind}(${fp}) crosses below ${kind}(${sp})`, operands: ops(i), result: true },
            ],
            explanation: `${kind}(${fp})=${f2(fast[i])} crossed below ${kind}(${sp})=${f2(slow[i])}`,
          }
        : null;
  } else if (type === 'RSI') {
    const period = num(params.period, 14);
    const lo = num(params.oversold, 30);
    const hi = num(params.overbought, 70);
    const r = rsi(closes, period);
    const loS: Series = closes.map(() => lo);
    const hiS: Series = closes.map(() => hi);
    entryRule = (i) =>
      crossesAbove(r, loS, i)
        ? {
            i,
            type: 'ENTRY',
            reason: 'RULE_ENTRY',
            trace: [
              {
                condition: `RSI(${period}) crosses above ${lo}`,
                operands: [
                  { label: `RSI(${period})`, value: f2(r[i]) },
                  { label: 'Oversold', value: String(lo) },
                ],
                result: true,
              },
            ],
            explanation: `RSI(${period})=${f2(r[i])} recovered above oversold ${lo}`,
          }
        : null;
    exitRule = (i) =>
      crossesBelow(r, hiS, i)
        ? {
            i,
            type: 'EXIT',
            reason: 'RULE_EXIT',
            trace: [
              {
                condition: `RSI(${period}) crosses below ${hi}`,
                operands: [
                  { label: `RSI(${period})`, value: f2(r[i]) },
                  { label: 'Overbought', value: String(hi) },
                ],
                result: true,
              },
            ],
            explanation: `RSI(${period})=${f2(r[i])} fell back below overbought ${hi}`,
          }
        : null;
  } else if (type === 'MACD') {
    const m = macd(closes, num(params.fast, 12), num(params.slow, 26), num(params.signal, 9));
    const needHist = params.requirePositiveHistogram === true;
    const ops = (i: number) => [
      { label: 'MACD', value: f2(m.macd[i]) },
      { label: 'Signal', value: f2(m.signal[i]) },
      { label: 'Histogram', value: f2(m.histogram[i]) },
    ];
    entryRule = (i) => {
      if (!crossesAbove(m.macd, m.signal, i)) return null;
      const histOk = !needHist || (m.histogram[i] ?? 0) > 0;
      const trace: TraceCondition[] = [
        { condition: 'MACD crosses above signal', operands: ops(i), result: true },
      ];
      if (needHist)
        trace.push({
          condition: 'Histogram > 0',
          operands: [{ label: 'Histogram', value: f2(m.histogram[i]) }],
          result: histOk,
        });
      return histOk
        ? {
            i,
            type: 'ENTRY',
            reason: 'RULE_ENTRY',
            trace,
            explanation: `MACD=${f2(m.macd[i])} crossed above signal=${f2(m.signal[i])}`,
          }
        : null;
    };
    exitRule = (i) =>
      crossesBelow(m.macd, m.signal, i)
        ? {
            i,
            type: 'EXIT',
            reason: 'RULE_EXIT',
            trace: [{ condition: 'MACD crosses below signal', operands: ops(i), result: true }],
            explanation: `MACD=${f2(m.macd[i])} crossed below signal=${f2(m.signal[i])}`,
          }
        : null;
  } else if (type === 'PRICE_ALERT') {
    const target = num(params.target, 0);
    const exitT = num(params.exitTarget, Number.POSITIVE_INFINITY);
    const above = params.direction !== 'BELOW';
    const t: Series = closes.map(() => target);
    const x: Series = closes.map(() => exitT);
    entryRule = (i) =>
      (above ? crossesAbove(closes, t, i) : crossesBelow(closes, t, i))
        ? {
            i,
            type: 'ENTRY',
            reason: 'PRICE_TARGET',
            trace: [
              {
                condition: `close ${above ? '≥' : '≤'} ${target.toFixed(2)}`,
                operands: [{ label: 'Close', value: f2(closes[i]) }],
                result: true,
              },
            ],
            explanation: `Close ${f2(closes[i])} reached target ${target.toFixed(2)}`,
          }
        : null;
    exitRule = (i) =>
      Number.isFinite(exitT) && (above ? crossesAbove(closes, x, i) : crossesBelow(closes, x, i))
        ? {
            i,
            type: 'EXIT',
            reason: 'PRICE_TARGET',
            trace: [
              {
                condition: `close ${above ? '≥' : '≤'} ${exitT.toFixed(2)}`,
                operands: [{ label: 'Close', value: f2(closes[i]) }],
                result: true,
              },
            ],
            explanation: `Close ${f2(closes[i])} reached exit target ${exitT.toFixed(2)}`,
          }
        : null;
  } else {
    // Exit-only overlays: assume a held position (demo enters at the first bar / after cooldown).
    entryRule = (i) => ({
      i,
      type: 'ENTRY',
      reason: 'MANUAL',
      trace: [
        {
          condition: 'Position held (exit-only template)',
          operands: [{ label: 'Close', value: f2(closes[i]) }],
          result: true,
        },
      ],
      explanation: 'Exit-only template: the backtest assumes a position is opened, then applies the overlay',
    });
  }

  const slPct = type === 'STOP_LOSS' ? num(params.stopLossPct, 5) : null;
  const tpPct = type === 'TAKE_PROFIT' ? num(params.takeProfitPct, 10) : null;
  const tsPct = type === 'TRAILING_STOP' ? num(params.trailingStopPct, 7) : null;

  for (let i = 1; i < closes.length; i++) {
    const c = closes[i];
    if (!inPos) {
      if (i < cooldownUntil) continue;
      const ev = entryRule(i);
      if (ev) {
        events.push(ev);
        inPos = true;
        entryPrice = c;
        high = c;
      }
      continue;
    }
    high = Math.max(high, c);
    // Exit priority: stop-loss → trailing → take-profit → rule exit.
    let ev: StrategyEvent | null = null;
    if (slPct !== null && c <= entryPrice * (1 - slPct / 100)) {
      ev = {
        i,
        type: 'EXIT',
        reason: 'STOP_LOSS',
        trace: [
          {
            condition: `close ≤ avgCost × (1 − ${slPct}%)`,
            operands: [
              { label: 'Close', value: f2(c) },
              { label: 'Stop', value: f2(entryPrice * (1 - slPct / 100)) },
            ],
            result: true,
          },
        ],
        explanation: `Close ${f2(c)} hit the ${slPct}% stop at ${f2(entryPrice * (1 - slPct / 100))}`,
      };
    } else if (tsPct !== null && c <= high * (1 - tsPct / 100)) {
      ev = {
        i,
        type: 'EXIT',
        reason: 'TRAILING_STOP',
        trace: [
          {
            condition: `close ≤ highSinceEntry × (1 − ${tsPct}%)`,
            operands: [
              { label: 'Close', value: f2(c) },
              { label: 'High since entry', value: f2(high) },
            ],
            result: true,
          },
        ],
        explanation: `Close ${f2(c)} fell ${tsPct}% from the high of ${f2(high)}`,
      };
    } else if (tpPct !== null && c >= entryPrice * (1 + tpPct / 100)) {
      ev = {
        i,
        type: 'EXIT',
        reason: 'TAKE_PROFIT',
        trace: [
          {
            condition: `close ≥ avgCost × (1 + ${tpPct}%)`,
            operands: [
              { label: 'Close', value: f2(c) },
              { label: 'Target', value: f2(entryPrice * (1 + tpPct / 100)) },
            ],
            result: true,
          },
        ],
        explanation: `Close ${f2(c)} reached the ${tpPct}% take-profit`,
      };
    } else {
      ev = exitRule(i);
    }
    if (ev) {
      events.push(ev);
      inPos = false;
      cooldownUntil = i + 10;
    }
  }
  return events;
}

/** Simple, explainable 0–100 score (docs/08 §9): trend, momentum, volume, volatility. */
export function scoreAt(
  bars: readonly RawBar[],
  i: number,
): { score: number; components: { label: string; points: number; max: number }[] } {
  const closes = bars.map((b) => b.close / 100);
  const vols = bars.map((b) => b.volume);
  const e50 = ema(closes, 50)[i];
  const r = rsi(closes, 14)[i];
  const v20 = sma(vols, 20)[i];
  const trend = e50 === null ? 15 : closes[i] > e50 ? 30 : 10;
  const momentum = r === null ? 15 : Math.round(Math.max(0, 30 - Math.abs(r - 58) * 0.9));
  const volume = v20 === null ? 10 : vols[i] > v20 * 1.5 ? 20 : vols[i] > v20 ? 14 : 6;
  const window = closes.slice(Math.max(0, i - 20), i + 1);
  const rets = window.slice(1).map((c, k) => Math.log(c / window[k]));
  const sd = Math.sqrt(rets.reduce((a, b) => a + b * b, 0) / Math.max(1, rets.length));
  const volatility = sd < 0.015 ? 20 : sd < 0.025 ? 13 : 6;
  const components = [
    { label: 'Trend (close vs EMA 50)', points: trend, max: 30 },
    { label: 'Momentum (RSI 14)', points: momentum, max: 30 },
    { label: 'Volume confirmation', points: volume, max: 20 },
    { label: 'Volatility regime', points: volatility, max: 20 },
  ];
  return { score: components.reduce((a, c) => a + c.points, 0), components };
}

// ─── Backtest ──────────────────────────────────────────────────────────────

export function runBacktest(
  id: string,
  createdAt: string,
  req: BacktestRequest,
  allBars: readonly RawBar[],
): Backtest {
  const bars = allBars.filter((b) => b.date >= req.from && b.date <= req.to);
  const base: Backtest = {
    id,
    status: 'SUCCEEDED',
    request: req,
    createdAt,
    metrics: null,
    equityCurve: [],
    trades: [],
    source: 'SIMULATED',
    disclaimer: BACKTEST_DISCLAIMER,
  };
  if (bars.length < 30) return { ...base, status: 'FAILED' };

  const events = runStrategy(req.strategyType, req.parameters, bars);
  const byBar = new Map<number, StrategyEvent>(events.map((e) => [e.i, e]));
  const slip = Dec.of(req.slippageBps).div(10000);
  const initial = Dec.of(req.initialCapital);

  let cash = initial;
  let qty = Dec.zero();
  let pending: StrategyEvent | null = null;
  let open: BacktestTrade | null = null;
  let feesPaid = Dec.zero();
  let barsInPos = 0;
  const trades: BacktestTrade[] = [];
  const curve: Backtest['equityCurve'] = [];
  let peak = initial;
  let maxDd = Dec.zero();

  const firstOpen = Dec.fromMinor(bars[0].open, 2);
  const benchQty = initial.div(firstOpen.mul('1.0035')).floor(0);
  const benchCash = initial
    .sub(benchQty.mul(firstOpen))
    .sub(estimateFees('BUY', benchQty, firstOpen).totalFees);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const openPx = Dec.fromMinor(bar.open, 2);
    if (pending) {
      if (pending.type === 'ENTRY' && qty.isZero()) {
        const px = openPx.mul(Dec.of(1).add(slip)).round(2);
        const q = cash.div(px.mul('1.0035')).floor(0);
        if (q.gt(0)) {
          const est = estimateFees('BUY', q, px);
          cash = cash.sub(est.total);
          feesPaid = feesPaid.add(est.totalFees);
          qty = q;
          open = {
            id: `${id}-t${trades.length + 1}`,
            entryDate: bar.date,
            exitDate: null,
            side: 'BUY',
            quantity: q.toString(),
            entryPrice: px.toFixed(2),
            exitPrice: null,
            pnl: '0',
            returnPct: '0',
            fees: est.totalFees,
            exitReason: null,
          };
        }
      } else if (pending.type === 'EXIT' && qty.gt(0) && open) {
        const px = openPx.mul(Dec.of(1).sub(slip)).round(2);
        const est = estimateFees('SELL', qty, px);
        cash = cash.add(est.total);
        feesPaid = feesPaid.add(est.totalFees);
        const cost = Dec.of(open.entryPrice).mul(qty);
        const fees = Dec.of(open.fees).add(est.totalFees);
        const pnl = px.mul(qty).sub(cost).sub(fees);
        trades.push({
          ...open,
          exitDate: bar.date,
          exitPrice: px.toFixed(2),
          pnl: pnl.toFixed(2),
          returnPct: pnl.div(cost).mul(100).toFixed(2),
          fees: fees.toFixed(2),
          exitReason: pending.reason,
        });
        qty = Dec.zero();
        open = null;
      }
      pending = null;
    }
    const close = Dec.fromMinor(bar.close, 2);
    const equity = cash.add(qty.mul(close));
    if (qty.gt(0)) barsInPos++;
    if (equity.gt(peak)) peak = equity;
    const dd = equity.div(peak).sub(1).mul(100);
    if (dd.lt(maxDd)) maxDd = dd;
    curve.push({
      date: bar.date,
      equity: equity.toFixed(2),
      benchmark: benchCash.add(benchQty.mul(close)).toFixed(2),
      drawdownPct: dd.toFixed(2),
    });
    const ev = byBar.get(i);
    if (ev && i < bars.length - 1) pending = ev;
  }

  if (open && qty.gt(0)) {
    const last = Dec.fromMinor(bars[bars.length - 1].close, 2);
    const cost = Dec.of(open.entryPrice).mul(qty);
    const pnl = last.mul(qty).sub(cost).sub(open.fees);
    trades.push({
      ...open,
      exitPrice: last.toFixed(2),
      pnl: pnl.toFixed(2),
      returnPct: pnl.div(cost).mul(100).toFixed(2),
      exitReason: 'END_OF_TEST',
    });
  }

  const finalEq = Dec.of(curve[curve.length - 1].equity);
  const benchFinal = Dec.of(curve[curve.length - 1].benchmark);
  const totalReturn = finalEq.div(initial).sub(1).mul(100);
  const years = bars.length / 250;
  const cagr = (Math.pow(finalEq.toNumber() / initial.toNumber(), 1 / Math.max(years, 1 / 250)) - 1) * 100;
  const eqNums = curve.map((p) => Number(p.equity));
  const rets = eqNums.slice(1).map((v, k) => v / eqNums[k] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const sharpe = sd === 0 ? 0 : (mean / sd) * Math.sqrt(250);
  const wins = trades.filter((t) => Dec.of(t.pnl).gt(0));
  const losses = trades.filter((t) => Dec.of(t.pnl).lte(0));
  const grossWin = Dec.sum(wins.map((t) => t.pnl));
  const grossLoss = Dec.sum(losses.map((t) => t.pnl)).abs();

  const metrics: BacktestMetrics = {
    totalReturnPct: totalReturn.toFixed(2),
    cagrPct: cagr.toFixed(2),
    maxDrawdownPct: maxDd.toFixed(2),
    sharpe: sharpe.toFixed(2),
    winRatePct: trades.length ? Dec.of(wins.length).div(trades.length).mul(100).toFixed(1) : '0.0',
    profitFactor: grossLoss.isZero() ? null : grossWin.div(grossLoss).toFixed(2),
    avgWin: wins.length ? grossWin.div(wins.length).toFixed(2) : '0.00',
    avgLoss: losses.length ? grossLoss.div(losses.length).neg().toFixed(2) : '0.00',
    exposurePct: Dec.of(barsInPos).div(bars.length).mul(100).toFixed(1),
    feesPaid: feesPaid.toFixed(2),
    tradeCount: trades.length,
    benchmarkReturnPct: benchFinal.div(initial).sub(1).mul(100).toFixed(2),
    finalEquity: finalEq.toFixed(2),
  };
  return { ...base, metrics, equityCurve: curve, trades };
}
