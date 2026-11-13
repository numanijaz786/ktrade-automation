import { type Decimal } from '../decimal.js';

// Local mirrors of @ktrade/shared enums (identical spellings). finance-core must not depend on @ktrade/shared.
// Type names are prefixed to avoid colliding with other finance-core modules in the root barrel.
export type TradeSide = 'BUY' | 'SELL';
export type TradeOrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'STOP_LIMIT';
export type StrategySignalType = 'ENTRY' | 'EXIT';
export type StrategySignalReason =
  | 'RULE_ENTRY'
  | 'RULE_EXIT'
  | 'STOP_LOSS'
  | 'TRAILING_STOP'
  | 'TAKE_PROFIT'
  | 'PRICE_TARGET'
  | 'MANUAL';
export type StrategyTemplateType =
  | 'MA_CROSSOVER'
  | 'RSI'
  | 'MACD'
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'TRAILING_STOP'
  | 'PRICE_ALERT'
  | 'CUSTOM_RULES';
export type BarInterval = 'M1' | 'M5' | 'M15' | 'H1' | 'D1';
export type TradingMode = 'LIVE' | 'PAPER';

/**
 * Open long position as of the close of the bar being evaluated, maintained by the caller
 * (backtest simulator / paper engine). `null` (or qty 0) = flat.
 */
export interface StrategyPosition {
  readonly qty: Decimal;
  /** Weighted-average cost per share (fees excluded). */
  readonly avgCost: Decimal;
  /** Number of bar closes observed while holding, including the bar on which the entry filled (>= 1). */
  readonly barsHeld: number;
  /** Highest price seen since entry: max(entry fill price, highs of every bar held). */
  readonly highSinceEntry: Decimal;
}
