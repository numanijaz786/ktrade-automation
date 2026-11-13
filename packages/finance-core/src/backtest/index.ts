// Public API of the backtest module. Re-exported from ../index.ts.
export {
  applySlippage,
  volumeCapQty,
  type PaperOrderType,
  type PaperWorkingOrder,
  type PaperQuote,
  type PaperFillOptions,
  type PaperFillResult,
  paperFill,
  barLimitFill,
} from './fills.js';
export {
  type BacktestEquityPoint,
  type BacktestMetricsInputTrade,
  type BacktestMetrics,
  type BacktestMetricsOptions,
  calendarDaysBetween,
  computeBacktestMetrics,
} from './metrics.js';
export {
  type BacktestFeeFn,
  type BacktestConfig,
  type BacktestFill,
  type BacktestTrade,
  type BacktestSignalRecord,
  type BacktestOpenPosition,
  type BacktestResult,
  BACKTEST_DISCLAIMER,
  maxAffordableQty,
  runBacktest,
  buyAndHoldReturnPct,
} from './simulator.js';
