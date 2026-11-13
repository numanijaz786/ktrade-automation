import type { Capability, CapabilityBlocker } from './capabilities.js';

/** Thrown whenever an adapter is asked to do something its capability manifest does not allow. */
export class BrokerCapabilityUnavailableError extends Error {
  readonly code = 'CAPABILITY_UNAVAILABLE';
  constructor(
    readonly adapter: string,
    readonly capability: Capability,
    readonly blocker: CapabilityBlocker,
  ) {
    super(`${adapter}: capability "${capability}" unavailable (${blocker})`);
    this.name = 'BrokerCapabilityUnavailableError';
  }
}

/** The adapter could not determine the outcome (e.g. timeout after submit). Never retried automatically. */
export class BrokerOutcomeUnknownError extends Error {
  readonly code = 'BROKER_OUTCOME_UNKNOWN';
  constructor(
    message: string,
    readonly brokerOrderRef?: string,
  ) {
    super(message);
    this.name = 'BrokerOutcomeUnknownError';
  }
}

export class BrokerRejectedError extends Error {
  readonly code = 'BROKER_REJECTED';
  constructor(
    message: string,
    readonly brokerReason?: string,
  ) {
    super(message);
    this.name = 'BrokerRejectedError';
  }
}

export class BrokerSessionExpiredError extends Error {
  readonly code = 'BROKER_SESSION_EXPIRED';
  constructor(message = 'Broker session expired — user must re-authenticate') {
    super(message);
    this.name = 'BrokerSessionExpiredError';
  }
}
