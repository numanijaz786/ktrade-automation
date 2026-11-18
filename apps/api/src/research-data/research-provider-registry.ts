import { Inject, Injectable } from '@nestjs/common';
import type {
  AnnouncementsProvider,
  FundamentalsProvider,
  MacroProvider,
  ResearchProviderCapabilities,
} from '@ktrade/broker-sdk';
import type { DataSource, ProviderStatusKind, ResearchDataType } from '@ktrade/shared';
import { CLOCK, type Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CAPITAL_STAKE_FUNDAMENTALS_REASON,
  CapitalStakeFundamentalsProvider,
  EODHD_FUNDAMENTALS_REASON,
  EodhdFundamentalsProvider,
  PSX_ANNOUNCEMENTS_REASON,
  PsxAnnouncementsProvider,
  ResearchProviderUnavailableError,
  SBP_EASYDATA_REASON,
  SbpEasyDataMacroProvider,
} from './providers/disabled.providers.js';
import {
  ManualAnnouncementsProvider,
  ManualFundamentalsProvider,
  ManualMacroProvider,
} from './providers/manual.providers.js';

type AnyResearchProvider = FundamentalsProvider | AnnouncementsProvider | MacroProvider;

export interface RegisteredResearchProvider {
  dataType: ResearchDataType;
  provider: AnyResearchProvider;
  enabled: boolean;
  disabledReason?: string;
  /** Exactly which credential / licence / approval is missing (empty for enabled providers). */
  missing: readonly string[];
}

export interface ResearchProviderStatusView {
  providerKey: string;
  displayName: string;
  dataType: ResearchDataType;
  enabled: boolean;
  source: DataSource;
  status: ProviderStatusKind;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  freshnessMinutes: number | null;
  message: string | null;
  capabilities: ResearchProviderCapabilities;
  licenseNote: string;
  commercialUseAllowed: boolean;
  missing: readonly string[];
}

/**
 * Every research data provider the platform knows. Registration is not usability: a disabled stub is listed
 * (so the UI can say exactly what the owner must obtain) but `require()` refuses it. There is deliberately
 * NO fallback: asking for a disabled provider throws; nothing is ever substituted with simulated or invented data.
 * Scraping providers must never be registered.
 */
@Injectable()
export class ResearchProviderRegistry {
  private readonly entries: readonly RegisteredResearchProvider[];

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    const manualF = new ManualFundamentalsProvider(prisma, clock);
    const manualA = new ManualAnnouncementsProvider(prisma, clock);
    const manualM = new ManualMacroProvider(prisma, clock);
    const cs = new CapitalStakeFundamentalsProvider(clock);
    const eodhd = new EodhdFundamentalsProvider(clock);
    const sbp = new SbpEasyDataMacroProvider(clock);
    const psx = new PsxAnnouncementsProvider(clock);
    const live = (dataType: ResearchDataType, provider: AnyResearchProvider): RegisteredResearchProvider => ({
      dataType,
      provider,
      enabled: true,
      missing: [],
    });
    this.entries = [
      live('FUNDAMENTALS', manualF),
      {
        dataType: 'FUNDAMENTALS',
        provider: cs,
        enabled: false,
        disabledReason: CAPITAL_STAKE_FUNDAMENTALS_REASON,
        missing: cs.missing,
      },
      {
        dataType: 'FUNDAMENTALS',
        provider: eodhd,
        enabled: false,
        disabledReason: EODHD_FUNDAMENTALS_REASON,
        missing: eodhd.missing,
      },
      live('ANNOUNCEMENTS', manualA),
      {
        dataType: 'ANNOUNCEMENTS',
        provider: psx,
        enabled: false,
        disabledReason: PSX_ANNOUNCEMENTS_REASON,
        missing: psx.missing,
      },
      live('MACRO', manualM),
      {
        dataType: 'MACRO',
        provider: sbp,
        enabled: false,
        disabledReason: SBP_EASYDATA_REASON,
        missing: sbp.missing,
      },
    ];
  }

  list(): readonly RegisteredResearchProvider[] {
    return this.entries;
  }

  /** The enabled provider for `key`; throws for unknown or disabled keys — never substitutes another. */
  require(key: string): AnyResearchProvider {
    const e = this.entries.find((x) => x.provider.key === key);
    if (!e) throw new ResearchProviderUnavailableError(key, 'unknown research provider');
    if (!e.enabled) throw new ResearchProviderUnavailableError(key, e.disabledReason ?? 'disabled');
    return e.provider;
  }

  /** The owner-entered provider for a data type (the only enabled kind until a licence exists). */
  manual<T extends AnyResearchProvider>(dataType: ResearchDataType): T {
    const e = this.entries.find((x) => x.dataType === dataType && x.enabled);
    if (!e) throw new ResearchProviderUnavailableError(dataType, 'no enabled provider for this data type');
    return e.provider as T;
  }

  /** Runs every health check, persists the result to `provider_status`, and returns the view. */
  async statuses(): Promise<ResearchProviderStatusView[]> {
    const out: ResearchProviderStatusView[] = [];
    for (const e of this.entries) {
      const health = await e.provider.healthCheck();
      const caps = e.provider.capabilities();
      const attemptedAt = new Date(health.checkedAt);
      const existing = await this.prisma.providerStatus.findUnique({
        where: { providerKey_dataType: { providerKey: e.provider.key, dataType: e.dataType } },
      });
      const lastSuccessAt = health.lastSuccessAt
        ? new Date(health.lastSuccessAt)
        : (existing?.lastSuccessAt ?? null);
      const data = {
        lastAttemptAt: attemptedAt,
        lastSuccessAt,
        status: health.status,
        freshnessMinutes: health.freshnessMinutes ?? null,
        message: health.message ?? null,
        licenseNote: caps.licenseNote,
      };
      await this.prisma.providerStatus.upsert({
        where: { providerKey_dataType: { providerKey: e.provider.key, dataType: e.dataType } },
        create: { providerKey: e.provider.key, dataType: e.dataType, ...data },
        update: data,
      });
      out.push({
        providerKey: e.provider.key,
        displayName: e.provider.displayName,
        dataType: e.dataType,
        enabled: e.enabled,
        source: e.provider.source,
        status: health.status,
        lastAttemptAt: attemptedAt.toISOString(),
        lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
        freshnessMinutes: health.freshnessMinutes ?? null,
        message: health.message ?? null,
        capabilities: caps,
        licenseNote: caps.licenseNote,
        commercialUseAllowed: caps.commercialUseAllowed,
        missing: e.missing,
      });
    }
    return out;
  }
}
