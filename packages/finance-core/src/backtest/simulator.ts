/**
 * Event-driven, single-symbol, long-only backtest simulator (docs/08 §5).
 *
 * Timeline for bar t:
 *   1. a market order created by a signal at the CLOSE of bar t−1 fills at the OPEN of bar t ± slippage;
 *   2. position bookkeeping (barsHeld, highSinceEntry) is updated with bar t;
 *   3. equity is marked at close_t;
 *   4. the strategy sees bars 0..t and the position as of close_t and may emit one signal → order for t+1.
 * A signal on the last bar is recorded but never filled. The strategy never sees bar t+1 before deciding at t,
 * so there is no look-ahead (the volume cap uses bar t+1's total volume — a standard approximation).
 *
 * Sizing: an entry buys the largest whole qty with qty × fillPrice + fee(BUY, qty, fillPrice) ≤ cash × investPct/100,
 * further limited by maxPositionQty and the volume cap (fees assumed non-decreasing in qty). Unfilled entry
 * quantity is cancelled; an exit not fully filled (volume cap) keeps working at subsequent opens.
 * avgCost is the weighted-average fill price EXCLUDING fees; fees are charged to cash and to trade P&L.
 */
import { type Decimal, type DecimalInput, d, HUNDRED, max, min, ONE, ZERO } from '../decimal.js';
import { at } from '../indicators/internal.js';
import { type OhlcvBar } from '../indicators/types.js';
import { sizePosition } from '../strategy/sizing.js';
import {
  type CompiledStrategy,
  compileStrategy,
  type StrategyDefinition,
  type StrategySignal,
} from '../strategy/strategy.js';
import { type StrategyPosition, type StrategySignalReason, type TradeSide } from '../strategy/types.js';
import { applySlippage, volumeCapQty } from './fills.js';
import {
  type BacktestEquityPoint,
  type BacktestMetrics,
  calendarDaysBetween,
  computeBacktestMetrics,
} from './metrics.js';

/** Fee callback (inject the fee engine). Must be >= 0 and non-decreasing in qty. */
export type BacktestFeeFn = (side: TradeSide, qty: Decimal, price: Decimal) => Decimal;

export interface BacktestConfig {
  /** Ascending, one symbol. */
  readonly bars: readonly OhlcvBar[];
  readonly strategy: StrategyDefinition | CompiledStrategy;
  readonly initialCapital: DecimalInput;
  readonly fee: BacktestFeeFn;
  /** Adverse slippage in basis points (default 0). */
  readonly slippageBps?: DecimalInput;
  /** Max % of a bar's volume a fill may take (default: no cap). */
  readonly volumeParticipationPct?: DecimalInput | null;
  /** % of available cash to deploy per entry (default 100). */
  readonly investPct?: DecimalInput;
  readonly maxPositionQty?: DecimalInput | null;
  /** Annual risk-free rate in percent for Sharpe (default 0). */
  readonly riskFreeRatePct?: DecimalInput;
  /** Sharpe annualisation factor (default 252 = daily bars). */
  readonly annualizationFactor?: number;
}

export interface BacktestFill {
  readonly ts: string;
  readonly barIndex: number;
  readonly side: TradeSide;
  readonly qty: Decimal;
  readonly price: Decimal;
  readonly fee: Decimal;
  readonly reason: StrategySignalReason;
}

export interface BacktestTrade {
  readonly entryTs: string;
  readonly entryBarIndex: number;
  readonly exitTs: string;
  readonly exitBarIndex: number;
  readonly qty: Decimal;
  readonly entryPrice: Decimal;
  /** Quantity-weighted average exit price. */
  readonly exitPrice: Decimal;
  readonly entryFees: Decimal;
  readonly exitFees: Decimal;
  /** proceeds − cost − all fees. */
  readonly netPnl: Decimal;
  /** netPnl / (cost + entry fees) × 100. */
  readonly returnPct: Decimal;
  readonly exitReason: StrategySignalReason;
  readonly barsHeld: number;
}

export interface BacktestSignalRecord {
  readonly signal: StrategySignal;
  readonly filled: boolean;
  /** Why the signal did not (fully) execute, if applicable. */
  readonly note: string | null;
}

export interface BacktestOpenPosition {
  readonly qty: Decimal;
  readonly avgCost: Decimal;
  readonly entryTs: string;
  readonly barsHeld: number;
  readonly highSinceEntry: Decimal;
  readonly marketValue: Decimal;
}

export interface BacktestResult {
  readonly equityCurve: readonly BacktestEquityPoint[];
  readonly trades: readonly BacktestTrade[];
  readonly fills: readonly BacktestFill[];
  readonly signals: readonly BacktestSignalRecord[];
  readonly openPosition: BacktestOpenPosition | null;
  readonly metrics: BacktestMetrics;
  readonly disclaimer: string;
}

export const BACKTEST_DISCLAIMER =
  'Past simulated performance does not guarantee future returns. Results exclude market impact and may use simulated or delayed data.';

interface OpenLot {
  qty: Decimal;
  avgCost: Decimal;
  entryTs: string;
  entryBarIndex: number;
  entryFees: Decimal;
  entryQty: Decimal;
  exitQty: Decimal;
  exitValue: Decimal;
  exitFees: Decimal;
  barsHeld: number;
  highSinceEntry: Decimal;
}

interface PendingOrder {
  side: TradeSide;
  reason: StrategySignalReason;
  /** For sells: remaining qty to sell (null for entries — sized at fill). */
  qty: Decimal | null;
  signalIndex: number;
}

function checkFee(fee: Decimal): Decimal {
  if (fee.isNeg()) throw new RangeError('fee callback returned a negative fee');
  return fee;
}

/** Largest whole qty in [0, hi] with qty × price + fee(qty) ≤ budget (binary search; fee non-decreasing in qty). */
export function maxAffordableQty(budget: Decimal, price: Decimal, hi: Decimal, fee: BacktestFeeFn): Decimal {
  const cost = (q: Decimal): Decimal =>
    q.isZero() ? ZERO : q.times(price).plus(checkFee(fee('BUY', q, price)));
  let lo = ZERO;
  let top = hi;
  while (lo.lt(top)) {
    const mid = lo.plus(top).plus(ONE).div(2).floor();
    if (cost(mid).lte(budget)) lo = mid;
    else top = mid.minus(ONE);
  }
  return lo;
}

function assertBars(bars: readonly OhlcvBar[]): void {
  for (let i = 1; i < bars.length; i++) {
    if (calendarDaysBetween(at(bars, i - 1).ts, at(bars, i).ts).lte(0)) {
      throw new RangeError(`bars must be strictly ascending by ts (index ${i})`);
    }
  }
}

export function runBacktest(config: BacktestConfig): BacktestResult {
  const bars = config.bars;
  assertBars(bars);
  const strategy = 'createRunner' in config.strategy ? config.strategy : compileStrategy(config.strategy);
  const initialCapital = d(config.initialCapital);
  if (!initialCapital.gt(0)) throw new RangeError('initialCapital must be > 0');
  const slip = d(config.slippageBps ?? '0');
  const participation =
    config.volumeParticipationPct === null || config.volumeParticipationPct === undefined
      ? null
      : d(config.volumeParticipationPct);
  const investPct = d(config.investPct ?? '100');
  if (!investPct.gt(0) || investPct.gt(HUNDRED)) throw new RangeError('investPct must be in (0, 100]');
  const maxPositionQty =
    config.maxPositionQty === null || config.maxPositionQty === undefined ? null : d(config.maxPositionQty);

  const runner = strategy.createRunner();
  let cash = initialCapital;
  let lot: OpenLot | null = null;
  let pending: PendingOrder | null = null;
  let peak = initialCapital;
  let feesTotal = ZERO;
  const curve: BacktestEquityPoint[] = [];
  const trades: BacktestTrade[] = [];
  const fills: BacktestFill[] = [];
  const signals: { signal: StrategySignal; filled: boolean; note: string | null }[] = [];
  const recordFor = new Map<number, { signal: StrategySignal; filled: boolean; note: string | null }>();

  for (let t = 0; t < bars.length; t++) {
    const bar = at(bars, t);
    // 1. fills at the open
    if (pending) {
      const order: PendingOrder = pending;
      pending = null;
      const rec = recordFor.get(order.signalIndex);
      const cap = volumeCapQty(bar.volume, participation);
      const price = applySlippage(order.side, bar.open, slip);
      if (order.side === 'BUY' && lot === null) {
        const budget = cash.times(investPct).div(HUNDRED);
        const uncapped = sizePosition({ price, maxInvestmentRemaining: budget, maxPositionQty }).qty;
        const hi = cap === null ? uncapped : min(uncapped, cap);
        const qty = maxAffordableQty(budget, price, hi, config.fee);
        if (qty.isZero()) {
          if (rec)
            rec.note =
              cap !== null && cap.isZero()
                ? 'volume cap allows 0 shares'
                : 'insufficient cash for one share incl. fees';
        } else {
          const fee = checkFee(config.fee('BUY', qty, price));
          cash = cash.minus(qty.times(price)).minus(fee);
          feesTotal = feesTotal.plus(fee);
          lot = {
            qty,
            avgCost: price,
            entryTs: bar.ts,
            entryBarIndex: t,
            entryFees: fee,
            entryQty: qty,
            exitQty: ZERO,
            exitValue: ZERO,
            exitFees: ZERO,
            barsHeld: 0,
            highSinceEntry: price,
          };
          fills.push({ ts: bar.ts, barIndex: t, side: 'BUY', qty, price, fee, reason: order.reason });
          if (rec) {
            rec.filled = true;
            if (cap !== null && cap.lt(uncapped) && qty.eq(cap))
              rec.note = 'partially filled (volume cap); remainder cancelled';
          }
        }
      } else if (order.side === 'SELL' && lot !== null) {
        const want = order.qty ?? lot.qty;
        const qty = cap === null ? want : min(want, cap);
        if (qty.gt(0)) {
          const fee = checkFee(config.fee('SELL', qty, price));
          cash = cash.plus(qty.times(price)).minus(fee);
          feesTotal = feesTotal.plus(fee);
          lot.qty = lot.qty.minus(qty);
          lot.exitQty = lot.exitQty.plus(qty);
          lot.exitValue = lot.exitValue.plus(qty.times(price));
          lot.exitFees = lot.exitFees.plus(fee);
          fills.push({ ts: bar.ts, barIndex: t, side: 'SELL', qty, price, fee, reason: order.reason });
          if (rec) rec.filled = true;
        }
        if (lot.qty.isZero()) {
          const cost = lot.entryQty.times(lot.avgCost);
          const netPnl = lot.exitValue.minus(cost).minus(lot.entryFees).minus(lot.exitFees);
          trades.push({
            entryTs: lot.entryTs,
            entryBarIndex: lot.entryBarIndex,
            exitTs: bar.ts,
            exitBarIndex: t,
            qty: lot.entryQty,
            entryPrice: lot.avgCost,
            exitPrice: lot.exitValue.div(lot.exitQty),
            entryFees: lot.entryFees,
            exitFees: lot.exitFees,
            netPnl,
            returnPct: netPnl.div(cost.plus(lot.entryFees)).times(HUNDRED),
            exitReason: order.reason,
            barsHeld: lot.barsHeld,
          });
          lot = null;
        } else {
          // keep working the remainder at the next open
          pending = { ...order, qty: lot.qty };
          if (rec) rec.note = 'partially filled (volume cap); remainder working';
        }
      }
    }

    // 2. position bookkeeping with bar t
    if (lot) {
      lot.barsHeld += 1;
      lot.highSinceEntry = max(lot.highSinceEntry, bar.high);
    }

    // 3. mark to market at the close
    const qtyHeld = lot ? lot.qty : ZERO;
    const equity = cash.plus(qtyHeld.times(bar.close));
    peak = max(peak, equity);
    curve.push({
      ts: bar.ts,
      barIndex: t,
      cash,
      positionQty: qtyHeld,
      close: bar.close,
      equity,
      drawdownPct: peak.isZero() ? ZERO : peak.minus(equity).div(peak).times(HUNDRED),
    });

    // 4. strategy decision at the close (sees bars 0..t only)
    const snapshot: StrategyPosition | null = lot
      ? { qty: lot.qty, avgCost: lot.avgCost, barsHeld: lot.barsHeld, highSinceEntry: lot.highSinceEntry }
      : null;
    const signal = runner.onBar(bar, snapshot);
    if (signal) {
      const rec = { signal, filled: false, note: null as string | null };
      signals.push(rec);
      if (t === bars.length - 1) rec.note = 'signal on last bar: no next bar to fill';
      else if (pending) rec.note = 'an order is already working';
      else {
        pending = { side: signal.side, reason: signal.reason, qty: null, signalIndex: t };
        recordFor.set(t, rec);
      }
    }
  }

  const lastBar = bars[bars.length - 1];
  const openPosition: BacktestOpenPosition | null =
    lot && lastBar
      ? {
          qty: lot.qty,
          avgCost: lot.avgCost,
          entryTs: lot.entryTs,
          barsHeld: lot.barsHeld,
          highSinceEntry: lot.highSinceEntry,
          marketValue: lot.qty.times(lastBar.close),
        }
      : null;

  const metrics = computeBacktestMetrics(initialCapital, curve, trades, {
    feesTotal,
    buyAndHoldReturnPct: buyAndHoldReturnPct(bars, initialCapital, slip, config.fee),
    ...(config.riskFreeRatePct === undefined ? {} : { riskFreeRatePct: d(config.riskFreeRatePct) }),
    ...(config.annualizationFactor === undefined ? {} : { annualizationFactor: config.annualizationFactor }),
  });
  return {
    equityCurve: curve,
    trades,
    fills,
    signals,
    openPosition,
    metrics,
    disclaimer: BACKTEST_DISCLAIMER,
  };
}

/**
 * Buy-and-hold benchmark on the same bars and fill model: buy the max affordable qty at the OPEN of bar 1
 * (the earliest fill the strategy itself could get) with the same slippage and fees, mark to market at the
 * last close (no exit fee, like an open strategy position). null with fewer than 2 bars.
 */
export function buyAndHoldReturnPct(
  bars: readonly OhlcvBar[],
  initialCapital: Decimal,
  slippageBps: Decimal,
  fee: BacktestFeeFn,
): Decimal | null {
  if (bars.length < 2) return null;
  const entry = at(bars, 1);
  const price = applySlippage('BUY', entry.open, slippageBps);
  if (!price.gt(0)) return null;
  const qty = maxAffordableQty(initialCapital, price, initialCapital.div(price).floor(), fee);
  const spent = qty.isZero() ? ZERO : qty.times(price).plus(fee('BUY', qty, price));
  const finalEquity = initialCapital.minus(spent).plus(qty.times(at(bars, bars.length - 1).close));
  return finalEquity.div(initialCapital).minus(ONE).times(HUNDRED);
}
