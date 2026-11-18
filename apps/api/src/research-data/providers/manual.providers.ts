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
import type { DataSource, FinancialPeriodType, MacroSeries } from '@ktrade/shared';
import type { Clock } from '../../common/clock.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { fromDb } from '../../market-data/decimal-format.js';
import { financialView } from '../research-data.views.js';

const MANUAL_CAPABILITIES: ResearchProviderCapabilities = {
  freshness: ['historical', 'eod'],
  delayMinutes: 0,
  licenseNote:
    'Owner-entered or CSV-imported figures from documents the owner may lawfully use; the owner is responsible for the right to record them. Labelled USER_REPORTED.',
  commercialUseAllowed: false,
};

const minutesSince = (clock: Clock, then: Date | null | undefined): number | undefined =>
  then ? Math.max(0, Math.floor((clock.now().getTime() - then.getTime()) / 60_000)) : undefined;

async function manualHealth(
  clock: Clock,
  latest: () => Promise<{ count: number; at: Date | null }>,
  noun: string,
): Promise<ResearchProviderHealth> {
  const checkedAt = clock.now();
  try {
    const { count, at } = await latest();
    if (count === 0)
      return {
        ok: false,
        status: 'DEGRADED',
        checkedAt: checkedAt.toISOString(),
        message: `no ${noun} entered yet — research that needs them reports "not available"`,
      };
    return {
      ok: true,
      status: 'OK',
      checkedAt: checkedAt.toISOString(),
      lastSuccessAt: checkedAt.toISOString(),
      freshnessMinutes: minutesSince(clock, at),
      message: `${count} ${noun} on file; newest entered ${at?.toISOString() ?? 'unknown'}`,
    };
  } catch {
    return {
      ok: false,
      status: 'FAILED',
      checkedAt: checkedAt.toISOString(),
      message: 'database unavailable',
    };
  }
}

export class ManualFundamentalsProvider implements FundamentalsProvider {
  readonly key = 'manual-fundamentals';
  readonly displayName = 'Owner-entered fundamentals';
  readonly source: DataSource = 'USER_REPORTED';

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
  ) {}

  capabilities(): ResearchProviderCapabilities {
    return MANUAL_CAPABILITIES;
  }

  async getFinancials(symbol: string, periodType?: FinancialPeriodType): Promise<FinancialPeriodDto[]> {
    const rows = await this.prisma.companyFinancial.findMany({
      where: { stock: { symbol }, ...(periodType ? { periodType } : {}) },
      include: { stock: { select: { symbol: true } } },
      orderBy: { periodEnd: 'desc' },
    });
    return rows.map((r) => financialView(r));
  }

  healthCheck(): Promise<ResearchProviderHealth> {
    return manualHealth(
      this.clock,
      async () => {
        const a = await this.prisma.companyFinancial.aggregate({
          where: { source: this.source },
          _count: { _all: true },
          _max: { updatedAt: true },
        });
        return { count: a._count._all, at: a._max.updatedAt };
      },
      'financial periods',
    );
  }
}

export class ManualAnnouncementsProvider implements AnnouncementsProvider {
  readonly key = 'manual-announcements';
  readonly displayName = 'Owner-entered announcements';
  readonly source: DataSource = 'USER_REPORTED';

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
  ) {}

  capabilities(): ResearchProviderCapabilities {
    return MANUAL_CAPABILITIES;
  }

  async getAnnouncements(query: {
    symbol?: string;
    since?: Date;
    limit?: number;
  }): Promise<AnnouncementDto[]> {
    const rows = await this.prisma.announcement.findMany({
      where: {
        ...(query.since ? { publishedAt: { gte: query.since } } : {}),
        ...(query.symbol
          ? { OR: [{ stock: { symbol: query.symbol } }, { symbols: { has: query.symbol } }] }
          : {}),
      },
      include: { stock: { select: { symbol: true } } },
      orderBy: { publishedAt: 'desc' },
      take: query.limit ?? 100,
    });
    return rows.map((r) => ({
      ...(r.stock ? { symbol: r.stock.symbol } : {}),
      symbols: r.symbols,
      title: r.title,
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.url ? { url: r.url } : {}),
      category: r.category,
      source: r.source,
      sourceName: r.sourceName,
      publishedAt: r.publishedAt.toISOString(),
      retrievedAt: r.retrievedAt.toISOString(),
    }));
  }

  healthCheck(): Promise<ResearchProviderHealth> {
    return manualHealth(
      this.clock,
      async () => {
        const a = await this.prisma.announcement.aggregate({
          where: { source: this.source },
          _count: { _all: true },
          _max: { retrievedAt: true },
        });
        return { count: a._count._all, at: a._max.retrievedAt };
      },
      'announcements',
    );
  }
}

export class ManualMacroProvider implements MacroProvider {
  readonly key = 'manual-macro';
  readonly displayName = 'Owner-entered macro series';
  readonly source: DataSource = 'USER_REPORTED';

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
  ) {}

  capabilities(): ResearchProviderCapabilities {
    return MANUAL_CAPABILITIES;
  }

  async getObservations(series: MacroSeries, from?: Date, to?: Date): Promise<MacroObservationDto[]> {
    const rows = await this.prisma.macroObservation.findMany({
      where: {
        series,
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: { date: 'asc' },
    });
    return rows.map((r) => ({
      series: r.series,
      date: r.date.toISOString().slice(0, 10),
      value: fromDb(r.value).toFixed(),
      source: r.source,
      sourceRef: r.sourceRef,
    }));
  }

  healthCheck(): Promise<ResearchProviderHealth> {
    return manualHealth(
      this.clock,
      async () => {
        const a = await this.prisma.macroObservation.aggregate({
          where: { source: this.source },
          _count: { _all: true },
          _max: { createdAt: true },
        });
        return { count: a._count._all, at: a._max.createdAt };
      },
      'macro observations',
    );
  }
}
