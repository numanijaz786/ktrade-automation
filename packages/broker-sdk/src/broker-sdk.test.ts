import { describe, expect, it } from 'vitest';
import type { ApprovedOrder, BrokerAdapter } from './broker-adapter.js';
import {
  CAPABILITIES,
  allOff,
  canEnable,
  capabilityBlocker,
  type CapabilityManifest,
} from './capabilities.js';
import { BrokerCapabilityUnavailableError } from './errors.js';
import { guardedCall } from './guard.js';
import { KTradeBrowserAdapter, KTradeOfficialApiAdapter } from './stubs.js';

const ctx = { brokerAccountId: 'acc-1', requestId: 'req-1' };
const order: ApprovedOrder = {
  orderId: 'o1',
  idempotencyKey: 'k1',
  previewHash: 'h',
  symbol: 'HUBC',
  side: 'BUY',
  type: 'LIMIT',
  timeInForce: 'DAY',
  quantity: '100',
  limitPrice: '150.00',
};

describe('capability chain', () => {
  const full = {
    implemented: true,
    verified: true,
    authorized: true,
    authorizationRef: 'KTrade email 2027-01-05',
    enabled: true,
  };

  it('is usable only when all four flags are set and an authorization reference exists', () => {
    expect(capabilityBlocker(full)).toBeNull();
    expect(capabilityBlocker({ ...full, implemented: false })).toBe('NOT_IMPLEMENTED');
    expect(capabilityBlocker({ ...full, verified: false })).toBe('NOT_VERIFIED');
    expect(capabilityBlocker({ ...full, authorized: false })).toBe('NOT_AUTHORIZED');
    expect(capabilityBlocker({ ...full, authorizationRef: null })).toBe('NOT_AUTHORIZED');
    expect(capabilityBlocker({ ...full, enabled: false })).toBe('NOT_ENABLED');
    expect(capabilityBlocker(undefined)).toBe('NOT_IMPLEMENTED');
  });

  it('owners cannot enable an unauthorized capability', () => {
    expect(canEnable({ ...full, enabled: false })).toEqual({ ok: true });
    expect(canEnable({ ...full, authorized: false, enabled: false })).toEqual({
      ok: false,
      reason: 'NOT_AUTHORIZED',
    });
  });
});

describe.each([new KTradeOfficialApiAdapter(), new KTradeBrowserAdapter()])('$kind stub', (adapter) => {
  it('reports every capability as off', () => {
    for (const c of CAPABILITIES)
      expect(capabilityBlocker(adapter.capabilities()[c])).toBe('NOT_IMPLEMENTED');
  });

  it('refuses placeOrder, cancelOrder and reads', async () => {
    await expect(guardedCall(adapter, 'placeOrder', ctx, order)).rejects.toBeInstanceOf(
      BrokerCapabilityUnavailableError,
    );
    await expect(guardedCall(adapter, 'cancelOrder', ctx, 'ref')).rejects.toThrow(/NOT_IMPLEMENTED/);
    await expect(guardedCall(adapter, 'getHoldings', ctx)).rejects.toThrow(/unavailable/);
  });
});

describe('guardedCall', () => {
  it('refuses when the manifest claims usable but the method is missing', async () => {
    const manifest: CapabilityManifest = allOff();
    manifest.placeOrder = {
      implemented: true,
      verified: true,
      authorized: true,
      authorizationRef: 'x',
      enabled: true,
    };
    const liar: BrokerAdapter = { kind: 'PAPER', displayName: 'liar', capabilities: () => manifest };
    await expect(guardedCall(liar, 'placeOrder', ctx, order)).rejects.toThrow(/NOT_IMPLEMENTED/);
  });

  it('invokes the method when the capability is usable', async () => {
    const manifest: CapabilityManifest = allOff();
    manifest.placeOrder = {
      implemented: true,
      verified: true,
      authorized: true,
      authorizationRef: 'x',
      enabled: true,
    };
    const ok: BrokerAdapter = {
      kind: 'PAPER',
      displayName: 'ok',
      capabilities: () => manifest,
      placeOrder: async () => ({
        brokerOrderRef: 'B1',
        status: 'SUBMITTED',
        source: 'SIMULATED',
        receivedAt: 'now',
      }),
    };
    await expect(guardedCall(ok, 'placeOrder', ctx, order)).resolves.toMatchObject({ status: 'SUBMITTED' });
  });
});
