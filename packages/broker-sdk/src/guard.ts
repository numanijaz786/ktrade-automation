import type { BrokerAdapter } from './broker-adapter.js';
import { capabilityBlocker, type Capability } from './capabilities.js';
import { BrokerCapabilityUnavailableError } from './errors.js';

/** Adapter methods and the capability each one requires. Single source of truth — callers never pick the capability. */
export const METHOD_CAPABILITY = {
  getCash: 'readCash',
  getHoldings: 'readHoldings',
  getOrders: 'readOrders',
  getOrderStatus: 'readOrders',
  getExecutions: 'readExecutions',
  prepareOrder: 'prepareOrder',
  placeOrder: 'placeOrder',
  cancelOrder: 'cancelOrder',
} as const satisfies Record<string, Capability>;

export type AdapterMethod = keyof typeof METHOD_CAPABILITY;
type Fn<M extends AdapterMethod> = NonNullable<BrokerAdapter[M]>;

/** Throws BrokerCapabilityUnavailableError unless the capability is implemented ∧ verified ∧ authorized ∧ enabled. */
export function assertCapability(adapter: BrokerAdapter, capability: Capability): void {
  const blocker = capabilityBlocker(adapter.capabilities()[capability]);
  if (blocker) throw new BrokerCapabilityUnavailableError(adapter.kind, capability, blocker);
}

/**
 * The only sanctioned way to invoke an adapter:  `guardedCall(adapter, 'placeOrder', ctx, order)`.
 * Checks the capability chain for that method, then that the method actually exists.
 */
export async function guardedCall<M extends AdapterMethod>(
  adapter: BrokerAdapter,
  method: M,
  ...args: Parameters<Fn<M>>
): Promise<Awaited<ReturnType<Fn<M>>>> {
  const capability = METHOD_CAPABILITY[method];
  assertCapability(adapter, capability);
  const fn = adapter[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
  if (typeof fn !== 'function') {
    throw new BrokerCapabilityUnavailableError(adapter.kind, capability, 'NOT_IMPLEMENTED');
  }
  return (await fn.apply(adapter, args)) as Awaited<ReturnType<Fn<M>>>;
}
