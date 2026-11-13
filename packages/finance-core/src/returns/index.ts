// Public API of the returns module. Re-exported from ../index.ts.
export {
  accountValue,
  dailyPnl,
  holdingValuation,
  liquidationValue,
  marketValue,
  portfolioWeights,
  simpleReturn,
  unrealizedPnl,
  type HoldingValuation,
  type HoldingValuationInput,
  type PortfolioWeight,
} from './valuation.js';
export {
  aggregateMonthlyPnl,
  dailyPerformance,
  maxDrawdown,
  timeWeightedReturn,
  twrIndex,
  type DailyPerformance,
  type MaxDrawdownResult,
  type MonthlyPnl,
  type ValuationPoint,
} from './performance.js';
export { xirr, xnpv, XirrError, type XirrCashFlow, type XirrOptions } from './xirr.js';
