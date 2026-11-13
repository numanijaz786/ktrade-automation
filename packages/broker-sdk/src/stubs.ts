import type { BrokerAdapterKind } from '@ktrade/shared';
import type { BrokerAdapter } from './broker-adapter.js';
import { allOff, type CapabilityManifest } from './capabilities.js';

/**
 * KTrade official-API adapter. KTrade publishes no API (docs/01). Every capability is OFF and
 * no methods are implemented; guardedCall() therefore refuses every operation.
 * When an official API is documented and authorized, implement methods here and flip `implemented`.
 */
export class KTradeOfficialApiAdapter implements BrokerAdapter {
  readonly kind: BrokerAdapterKind = 'KTRADE_OFFICIAL_API';
  readonly displayName = 'KTrade official API (not available)';
  capabilities(): CapabilityManifest {
    return allOff();
  }
}

/**
 * KTrade web-portal browser adapter. Designed in docs/03 §5; NOT implemented and DISABLED until
 * KTrade grants written permission per capability. Even then, login/OTP is always completed by the user,
 * and placeOrder additionally requires RiskLimit.liveAutoExecutionEnabled + the global kill switch.
 */
export class KTradeBrowserAdapter implements BrokerAdapter {
  readonly kind: BrokerAdapterKind = 'KTRADE_BROWSER';
  readonly displayName = 'KTrade web portal (disabled — awaiting written authorization)';
  capabilities(): CapabilityManifest {
    return allOff();
  }
}
