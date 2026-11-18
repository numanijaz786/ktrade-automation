import { type OhlcvBar } from '../indicators/types.js';

/** Mirrors @ktrade/shared DataSource (finance-core has no dependency on shared; the strings must match). */
export const RESEARCH_DATA_SOURCES = [
  'BROKER_CONFIRMED',
  'BROKER_DISPLAYED',
  'PROVIDER',
  'USER_REPORTED',
  'ESTIMATED',
  'SIMULATED',
] as const;
export type ResearchDataSource = (typeof RESEARCH_DATA_SOURCES)[number];

/** A daily OHLCV bar with provenance. */
export interface ResearchBar extends OhlcvBar {
  readonly source: ResearchDataSource;
}

export const HORIZONS = ['SHORT_TERM', 'SWING', 'LONG_TERM', 'DIVIDEND', 'VALUE', 'GROWTH'] as const;
export type Horizon = (typeof HORIZONS)[number];

export const ACTIONS = ['STRONG_BUY', 'BUY', 'HOLD', 'WATCHLIST', 'SELL', 'AVOID'] as const;
export type RecommendationAction = (typeof ACTIONS)[number];

/** Horizons whose rules depend on company fundamentals. */
export const FUNDAMENTAL_HORIZONS: readonly Horizon[] = ['LONG_TERM', 'DIVIDEND', 'VALUE', 'GROWTH'];
export const isFundamentalHorizon = (h: Horizon): boolean => FUNDAMENTAL_HORIZONS.includes(h);

/** Common shape of technical-analysis outputs: `warm` says whether enough bars existed; `explanation` says what triggered. */
export interface TechnicalResult {
  readonly warm: boolean;
  readonly explanation: readonly string[];
}
