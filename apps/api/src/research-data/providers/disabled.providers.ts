import { ConflictException } from '@nestjs/common';
import type {
  AnnouncementDto,
  AnnouncementsProvider,
  FinancialPeriodDto,
  FundamentalsProvider,
  MacroObservationDto,
  MacroProvider,
  ResearchProviderCapabilities,
  ResearchProviderHealth,
} from '@ktrade/broker-sdk';
import type { DataSource, MacroSeries } from '@ktrade/shared';
import type { Clock } from '../../common/clock.js';

/** A research provider that cannot be used (no licence / key / approval). Refuses with a typed 409. */
export class ResearchProviderUnavailableError extends ConflictException {
  readonly code = 'PROVIDER_UNAVAILABLE';
  constructor(
    readonly providerKey: string,
    readonly reason: string,
  ) {
    super({
      message: `Research provider "${providerKey}" is unavailable: ${reason}`,
      code: 'PROVIDER_UNAVAILABLE',
    });
  }
}

export const CAPITAL_STAKE_FUNDAMENTALS_REASON =
  'the Capital Stake fundamentals adapter is scaffolded but disabled. It requires a paid data licence, an API key ' +
  'supplied by the owner (Settings → Integrations), and Capital Stake’s official API documentation. ' +
  'Endpoints are deliberately not guessed.';
export const EODHD_FUNDAMENTALS_REASON =
  'the EODHD fundamentals adapter is scaffolded but disabled. It requires a paid EODHD plan that includes PSX (.KAR) ' +
  'fundamentals, an API key supplied by the owner, and confirmation of EODHD’s PSX coverage and licence terms.';
export const SBP_EASYDATA_REASON =
  'the SBP EasyData adapter is scaffolded but disabled. It requires a free SBP EasyData account, the API key issued ' +
  'to it (USER_ACTION_REQUIRED #8), and SBP’s official API documentation. Endpoints are deliberately not guessed.';
export const PSX_ANNOUNCEMENTS_REASON =
  'PSX’s portal terms forbid commercial or derived use of its announcements without PSX approval. No scraping. ' +
  'Needs written approval (marketdatarequest@psx.com.pk) or a licensed vendor feed; until then announcements are owner-entered only.';

/** Shared shape of every disabled stub: nothing advertised, every call refused, health explains why. */
abstract class DisabledResearchProvider {
  abstract readonly key: string;
  abstract readonly displayName: string;
  readonly source: DataSource = 'PROVIDER';
  readonly enabled = false;
  protected abstract readonly reason: string;
  protected abstract readonly licenseNote: string;
  /** Exactly what the owner has to obtain before this can be enabled. */
  abstract readonly missing: readonly string[];

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  capabilities(): ResearchProviderCapabilities {
    return { freshness: [], delayMinutes: 0, licenseNote: this.licenseNote, commercialUseAllowed: false };
  }

  async healthCheck(): Promise<ResearchProviderHealth> {
    return {
      ok: false,
      status: 'NOT_CONFIGURED',
      checkedAt: this.clock.now().toISOString(),
      message: this.reason,
    };
  }

  protected refuse(): ResearchProviderUnavailableError {
    return new ResearchProviderUnavailableError(this.key, this.reason);
  }
}

export class CapitalStakeFundamentalsProvider
  extends DisabledResearchProvider
  implements FundamentalsProvider
{
  readonly key = 'capitalstake-fundamentals';
  readonly displayName = 'Capital Stake fundamentals (licensed vendor — not configured)';
  protected readonly reason = CAPITAL_STAKE_FUNDAMENTALS_REASON;
  protected readonly licenseNote =
    'Paid licence from Capital Stake (authorized PSX vendor); terms not yet obtained.';
  readonly missing = [
    'Capital Stake data licence (paid subscription)',
    'API key entered by the owner in Settings → Integrations',
    'Capital Stake official API documentation (endpoints are not guessed)',
  ];
  getFinancials(): Promise<FinancialPeriodDto[]> {
    return Promise.reject(this.refuse());
  }
}

export class EodhdFundamentalsProvider extends DisabledResearchProvider implements FundamentalsProvider {
  readonly key = 'eodhd-fundamentals';
  readonly displayName = 'EODHD fundamentals (paid plan — not configured)';
  protected readonly reason = EODHD_FUNDAMENTALS_REASON;
  protected readonly licenseNote =
    'Paid EODHD plan; PSX licensing and coverage depth must be confirmed with the vendor.';
  readonly missing = [
    'Paid EODHD plan that includes PSX (.KAR) fundamentals',
    'API key entered by the owner in Settings → Integrations',
    'Confirmation of EODHD PSX coverage depth and licence terms',
  ];
  getFinancials(): Promise<FinancialPeriodDto[]> {
    return Promise.reject(this.refuse());
  }
}

export class SbpEasyDataMacroProvider extends DisabledResearchProvider implements MacroProvider {
  readonly key = 'sbp-easydata-macro';
  readonly displayName = 'SBP EasyData macro series (API key needed — not configured)';
  override readonly source: DataSource = 'PROVIDER';
  protected readonly reason = SBP_EASYDATA_REASON;
  protected readonly licenseNote =
    'Official State Bank of Pakistan public datasets; the API needs a free account key.';
  readonly missing = [
    'Free SBP EasyData account (USER_ACTION_REQUIRED #8)',
    'API key issued to that account, entered in Settings → Integrations',
    'SBP EasyData official API documentation (endpoints are not guessed)',
  ];
  getObservations(_series: MacroSeries): Promise<MacroObservationDto[]> {
    return Promise.reject(this.refuse());
  }
}

export class PsxAnnouncementsProvider extends DisabledResearchProvider implements AnnouncementsProvider {
  readonly key = 'psx-announcements';
  readonly displayName = 'PSX announcements (approval needed — not configured)';
  protected readonly reason = PSX_ANNOUNCEMENTS_REASON;
  protected readonly licenseNote =
    'PSX terms forbid commercial/derived use of portal data without approval. Scraping is prohibited.';
  readonly missing = [
    'Written PSX approval for the intended use (marketdatarequest@psx.com.pk) or a licensed vendor feed (e.g. Capital Stake)',
  ];
  getAnnouncements(): Promise<AnnouncementDto[]> {
    return Promise.reject(this.refuse());
  }
}
