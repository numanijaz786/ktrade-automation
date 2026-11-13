// Public API of the fees module. Re-exported from ../index.ts.
export type {
  FeeAppliesTo,
  FeeComponent,
  FeeMethod,
  FeeScheduleItemSpec,
  FeeScheduleSpec,
  FeeTradeSide,
  TaxFilerStatus,
  TaxType,
} from './types.js';
export {
  computeTradeFees,
  FeeScheduleError,
  ktradeDefaultSchedule,
  selectFeeSchedule,
  type FeeBreakdown,
  type FeeComputeOptions,
  type FeeLine,
  type FeeTradeInput,
} from './engine.js';
export {
  estimateDividendTax,
  findTaxRate,
  TaxRateNotFoundError,
  type DividendTaxEstimate,
  type TaxRateQuery,
  type TaxRateRow,
} from './tax.js';
