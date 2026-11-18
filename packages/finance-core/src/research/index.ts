// Public API of the research module. Re-exported from ../index.ts.
export * from './types.js';
export * from './technical.js';
export * from './fundamentals.js';
export * from './valuation.js';
export * from './rec-types.js';
export {
  RULE_TABLE,
  type RuleDef,
  type TechSnapshot,
  computeTechSnapshot,
  dividendRecordAnalysis,
  type DividendRecordAnalysis,
} from './rules.js';
export { evaluateStock, evaluateAllHorizons, requiredBars } from './evaluate.js';
export {
  evaluateHolding,
  type EvaluateHoldingInput,
  type HoldingAdvice,
  type HoldingEvaluation,
  type HoldingPnl,
  type HoldingPosition,
} from './holding.js';
export { rankOpportunities, type RankedOpportunity, type ScanFilters, type ScanResult } from './scanner.js';
