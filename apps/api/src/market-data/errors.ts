import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Typed market-data errors. They extend Nest HTTP exceptions so ProblemDetailsFilter renders them as
 * RFC 9457 problem+json with a stable `code`, without any change to the shared filter.
 */

/** A provider that cannot be used yet (no licence / key / official docs) or is disabled. */
export class MarketDataProviderUnavailableError extends ConflictException {
  readonly code = 'PROVIDER_UNAVAILABLE';
  constructor(
    readonly providerKey: string,
    readonly reason: string,
  ) {
    super({ message: `Market-data provider "${providerKey}" is unavailable: ${reason}`, code: 'PROVIDER_UNAVAILABLE' });
  }
}

/** The active provider does not offer what was asked (e.g. intraday bars from an EOD-only source). */
export class MarketDataCapabilityError extends ConflictException {
  readonly code = 'CAPABILITY_UNAVAILABLE';
  constructor(providerKey: string, capability: string) {
    super({ message: `Market-data provider "${providerKey}" does not support ${capability}`, code: 'CAPABILITY_UNAVAILABLE' });
  }
}

export class UnknownSymbolError extends NotFoundException {
  constructor(symbol: string) {
    super({ message: `Unknown symbol: ${symbol}`, code: 'UNKNOWN_SYMBOL' });
  }
}

/** Live trading / live previews must refuse stale or SIMULATED prices (docs/09 §B2). */
export class StalePriceError extends ConflictException {
  constructor(symbol: string, asOf: string) {
    super({ message: `Price for ${symbol} is stale (as of ${asOf})`, code: 'STALE_PRICE' });
  }
}

export class SimulatedPriceRefusedError extends ConflictException {
  constructor(symbol: string) {
    super({ message: `Live trading refuses SIMULATED prices (${symbol})`, code: 'SIMULATED_PRICE_REFUSED' });
  }
}
