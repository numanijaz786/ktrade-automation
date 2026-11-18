import type {
  AnnouncementCategory,
  DataSource,
  FinancialPeriodType,
  MacroSeries,
  ProviderStatusKind,
} from '@ktrade/shared';

/**
 * Research data provider contracts (docs/10 §2). Like MarketDataProvider: a provider is a licensed or
 * owner-supplied source, never a scraper. Every value it returns carries `source`; a provider that cannot
 * serve data (no licence, no key) must refuse — it never falls back to simulated or invented values.
 */

/** How current the data is: live feed, delayed feed, end-of-day/periodic, or historical backfill only. */
export type ResearchFreshness = 'realtime' | 'delayed' | 'eod' | 'historical';

export interface ResearchProviderCapabilities {
  freshness: readonly ResearchFreshness[];
  delayMinutes: number;
  /** Plain-language licence/terms summary the owner must respect. */
  licenseNote: string;
  /** May the data be used in a commercial / derived product? false = personal use only. */
  commercialUseAllowed: boolean;
}

export interface ResearchProviderHealth {
  ok: boolean;
  status: ProviderStatusKind;
  checkedAt: string; // ISO
  lastSuccessAt?: string; // ISO
  freshnessMinutes?: number;
  message?: string;
}

/** Numeric items are decimal strings in full currency units; absent = not available (never zero-filled). */
export interface FinancialPeriodDto {
  symbol: string;
  periodType: FinancialPeriodType;
  periodEnd: string; // YYYY-MM-DD
  publishedAt: string; // ISO
  currency: string;
  source: DataSource;
  sourceRef: string;
  sourceUrl?: string;
  revenue?: string;
  grossProfit?: string;
  operatingProfit?: string;
  netProfit?: string;
  eps?: string;
  totalAssets?: string;
  totalEquity?: string;
  totalDebt?: string;
  operatingCashFlow?: string;
  capex?: string;
  sharesOutstanding?: string;
  dividendPerShare?: string;
}

export interface AnnouncementDto {
  symbol?: string;
  symbols: string[];
  title: string;
  summary?: string;
  url?: string;
  category: AnnouncementCategory;
  source: DataSource;
  sourceName: string;
  publishedAt: string; // ISO
  retrievedAt: string; // ISO
}

export interface MacroObservationDto {
  series: MacroSeries;
  date: string; // YYYY-MM-DD
  value: string;
  source: DataSource;
  sourceRef: string;
}

interface ResearchProviderBase {
  readonly key: string;
  readonly displayName: string;
  readonly source: DataSource;
  capabilities(): ResearchProviderCapabilities;
  healthCheck(): Promise<ResearchProviderHealth>;
}

export interface FundamentalsProvider extends ResearchProviderBase {
  getFinancials(symbol: string, periodType?: FinancialPeriodType): Promise<FinancialPeriodDto[]>;
}

export interface AnnouncementsProvider extends ResearchProviderBase {
  getAnnouncements(query: { symbol?: string; since?: Date; limit?: number }): Promise<AnnouncementDto[]>;
}

export interface MacroProvider extends ResearchProviderBase {
  getObservations(series: MacroSeries, from?: Date, to?: Date): Promise<MacroObservationDto[]>;
}
