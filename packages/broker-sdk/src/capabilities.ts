/**
 * Capability model — the single gate between the platform and any real brokerage action.
 * A capability is USABLE only when all four flags are true (docs/02 §5, docs/03 §6).
 */
export const CAPABILITIES = [
  'readAccount',
  'readCash',
  'readHoldings',
  'readOrders',
  'readExecutions',
  'prepareOrder',
  'placeOrder',
  'cancelOrder',
  'streamOrderUpdates',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityState {
  /** Code exists and passes the adapter contract-test suite. */
  implemented: boolean;
  /** Checked in a supervised session against the real platform. */
  verified: boolean;
  /** Broker's written permission is on record (see authorizationRef). */
  authorized: boolean;
  authorizationRef?: string | null;
  /** The account owner switched it on (step-up auth, audited). */
  enabled: boolean;
}

export type CapabilityManifest = Record<Capability, CapabilityState>;

export const OFF: CapabilityState = Object.freeze({
  implemented: false,
  verified: false,
  authorized: false,
  authorizationRef: null,
  enabled: false,
});

/** A manifest with every capability off — the default for unauthorized adapters. */
export function allOff(): CapabilityManifest {
  return Object.fromEntries(CAPABILITIES.map((c) => [c, { ...OFF }])) as CapabilityManifest;
}

export type CapabilityBlocker = 'NOT_IMPLEMENTED' | 'NOT_VERIFIED' | 'NOT_AUTHORIZED' | 'NOT_ENABLED';

/** Returns the first unmet requirement, or null when the capability is usable. Order matters for UX messages. */
export function capabilityBlocker(state: CapabilityState | undefined): CapabilityBlocker | null {
  if (!state?.implemented) return 'NOT_IMPLEMENTED';
  if (!state.verified) return 'NOT_VERIFIED';
  if (!state.authorized || !state.authorizationRef) return 'NOT_AUTHORIZED';
  if (!state.enabled) return 'NOT_ENABLED';
  return null;
}

export const isUsable = (state: CapabilityState | undefined): boolean => capabilityBlocker(state) === null;

/**
 * Validates an owner's attempt to change `enabled`. Owners may only toggle `enabled`;
 * implemented/verified/authorized are set by engineering/compliance processes, never via the UI.
 */
export function canEnable(state: CapabilityState): { ok: true } | { ok: false; reason: CapabilityBlocker } {
  if (!state.implemented) return { ok: false, reason: 'NOT_IMPLEMENTED' };
  if (!state.verified) return { ok: false, reason: 'NOT_VERIFIED' };
  if (!state.authorized || !state.authorizationRef) return { ok: false, reason: 'NOT_AUTHORIZED' };
  return { ok: true };
}
