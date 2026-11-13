import { Injectable } from '@nestjs/common';
import type { MarketDataProvider } from '@ktrade/broker-sdk';
import {
  CAPITAL_STAKE_UNAVAILABLE_REASON,
  CapitalStakeProvider,
} from './providers/capital-stake.provider.js';
import { CsvEodProvider } from './providers/csv-eod.provider.js';
import { SimulatedMarketDataProvider } from './providers/simulated.provider.js';

/** `system_settings` key holding the active provider key as a JSON string, e.g. `"simulated"`. */
export const ACTIVE_PROVIDER_SETTING = 'marketData.activeProvider';
export const DEFAULT_PROVIDER_KEY = 'simulated';

export interface RegisteredProvider {
  provider: MarketDataProvider;
  enabled: boolean;
  disabledReason?: string;
}

/**
 * Every market-data provider the platform knows, keyed by `provider.key`. Registration ≠ usable:
 * a disabled provider is listed (so the UI can explain what it needs) but can never become active.
 * Scraping providers must never be registered (docs/09 §B2).
 */
@Injectable()
export class MarketDataProviderRegistry {
  private readonly entries: ReadonlyMap<string, RegisteredProvider>;

  constructor(
    simulated: SimulatedMarketDataProvider,
    csvEod: CsvEodProvider,
    capitalStake: CapitalStakeProvider,
  ) {
    const list: RegisteredProvider[] = [
      { provider: simulated, enabled: true },
      { provider: csvEod, enabled: true },
      {
        provider: capitalStake,
        enabled: capitalStake.enabled,
        disabledReason: CAPITAL_STAKE_UNAVAILABLE_REASON,
      },
    ];
    this.entries = new Map(list.map((e) => [e.provider.key, e]));
  }

  get(key: string): RegisteredProvider | undefined {
    return this.entries.get(key);
  }

  list(): RegisteredProvider[] {
    return [...this.entries.values()];
  }

  /** The enabled provider for `key`, else the default (SIMULATED — labelled, so never mistaken for real data). */
  resolve(key: string | null | undefined): MarketDataProvider {
    const entry = key ? this.entries.get(key) : undefined;
    if (entry?.enabled) return entry.provider;
    return this.entries.get(DEFAULT_PROVIDER_KEY)!.provider;
  }
}
