/**
 * @ktrade/finance-core — pure, deterministic, decimal-exact domain logic.
 * No I/O, no clocks, no randomness (pass them in). Every function here is unit-tested.
 * Module ownership: each sub-folder exposes its public API through its own index.ts.
 */
export * from './decimal.js';
export * from './fees/index.js';
export * from './ledger/index.js';
export * from './returns/index.js';
export * from './indicators/index.js';
export * from './strategy/index.js';
export * from './risk/index.js';
export * from './backtest/index.js';
