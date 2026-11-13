import type { DataSource, PriceInterval } from '@ktrade/shared';

export interface QuoteDto {
  symbol: string;
  last: string;
  open?: string;
  prevClose?: string;
  high?: string;
  low?: string;
  volume?: string;
  change?: string;
  changePct?: string;
  asOf: string; // ISO
  delayMinutes: number;
  source: DataSource;
  providerKey: string;
}

export interface BarDto {
  symbol: string;
  interval: PriceInterval;
  ts: string; // bar open, ISO
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  isAdjusted: boolean;
}

export interface CorporateActionDto {
  symbol: string;
  type: 'CASH_DIVIDEND' | 'BONUS' | 'SPLIT' | 'REVERSE_SPLIT' | 'RIGHTS';
  announcementDate?: string;
  exDate?: string;
  bookClosureFrom?: string;
  bookClosureTo?: string;
  dividendPerShare?: string;
  ratioNumerator?: string;
  ratioDenominator?: string;
  subscriptionPrice?: string;
}

export interface MarketDataCapabilities {
  quotes: boolean;
  intradayBars: boolean;
  eodBars: boolean;
  corporateActions: boolean;
  streaming: boolean;
  delayMinutes: number;
}

export interface ProviderHealth {
  ok: boolean;
  checkedAt: string;
  message?: string;
}

export type Unsubscribe = () => void;

/**
 * A licensed / authorized market-data source. Scraping implementations are prohibited (docs/09 §B2).
 * `source` labels every value it produces; SIMULATED providers are refused for live order previews.
 */
export interface MarketDataProvider {
  readonly key: string;
  readonly displayName: string;
  readonly source: DataSource;
  capabilities(): MarketDataCapabilities;
  getQuotes(symbols: readonly string[]): Promise<QuoteDto[]>;
  getBars(symbol: string, interval: PriceInterval, from: Date, to: Date): Promise<BarDto[]>;
  getCorporateActions?(symbol: string, from: Date, to: Date): Promise<CorporateActionDto[]>;
  subscribe?(symbols: readonly string[], onQuote: (q: QuoteDto) => void): Unsubscribe;
  healthCheck(): Promise<ProviderHealth>;
}
