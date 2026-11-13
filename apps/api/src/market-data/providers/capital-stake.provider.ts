import type {
  BarDto,
  MarketDataCapabilities,
  MarketDataProvider,
  ProviderHealth,
  QuoteDto,
  Unsubscribe,
} from '@ktrade/broker-sdk';
import type { DataSource, PriceInterval } from '@ktrade/shared';
import type { Clock } from '../../common/clock.js';
import { MarketDataProviderUnavailableError } from '../errors.js';

export const CAPITAL_STAKE_UNAVAILABLE_REASON =
  'the Capital Stake adapter is scaffolded but disabled. It requires a paid data licence/subscription, ' +
  'an API key supplied by the owner (Settings → Integrations), and Capital Stake’s official API documentation ' +
  'to implement the request mapping. Endpoints are deliberately not guessed (docs/09 §B1).';

/**
 * Licensed PSX data vendor — DISABLED stub. Every method refuses with a typed 409 PROVIDER_UNAVAILABLE.
 * No URLs, endpoints or payload shapes are encoded here on purpose; they are written against the
 * vendor's official docs once a licence and key exist.
 */
export class CapitalStakeProvider implements MarketDataProvider {
  readonly key = 'capitalstake';
  readonly displayName = 'Capital Stake (licensed vendor — not configured)';
  readonly source: DataSource = 'PROVIDER';
  readonly enabled = false;

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  /** All false: nothing is implemented, so nothing is advertised. */
  capabilities(): MarketDataCapabilities {
    return {
      quotes: false,
      intradayBars: false,
      eodBars: false,
      corporateActions: false,
      streaming: false,
      delayMinutes: 0,
    };
  }

  getQuotes(_symbols: readonly string[]): Promise<QuoteDto[]> {
    return Promise.reject(this.refuse());
  }

  getBars(_symbol: string, _interval: PriceInterval, _from: Date, _to: Date): Promise<BarDto[]> {
    return Promise.reject(this.refuse());
  }

  subscribe(_symbols: readonly string[], _onQuote: (q: QuoteDto) => void): Unsubscribe {
    throw this.refuse();
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      ok: false,
      checkedAt: this.clock.now().toISOString(),
      message: CAPITAL_STAKE_UNAVAILABLE_REASON,
    };
  }

  private refuse(): MarketDataProviderUnavailableError {
    return new MarketDataProviderUnavailableError(this.key, CAPITAL_STAKE_UNAVAILABLE_REASON);
  }
}
