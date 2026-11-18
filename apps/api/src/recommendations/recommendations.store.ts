import { Injectable, NotFoundException } from '@nestjs/common';
import { RECOMMENDATION_HORIZONS } from '@ktrade/shared';
import { AuditService } from '../audit/audit.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { addDays, pktInstant } from '../market-data/calendar.js';
import { fromDb } from '../market-data/decimal-format.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { performanceReport, type PerformanceRow } from './performance.js';
import {
  type ListRecommendationsQuery,
  type ParsedRecommendation,
  type PerformanceQuery,
  type RecordRecommendationInput,
  recordRecommendationSchema,
} from './recommendations.schemas.js';

const toDate = (s: string): Date => new Date(`${s}T00:00:00Z`);
const day = (d: Date): string => d.toISOString().slice(0, 10);
const dec = (v: { toFixed(): string } | null): string | null => (v === null ? null : fromDb(v).toFixed());

type Rec = Prisma.RecommendationGetPayload<{ include: { stock: { select: { symbol: true } } } }>;
type Outcome = Prisma.RecommendationOutcomeGetPayload<object>;

export function outcomeView(o: Outcome) {
  return {
    id: o.id,
    evaluatedAt: o.evaluatedAt.toISOString(),
    lastBarDate: day(o.lastBarDate),
    status: o.status,
    maxFavourablePct: dec(o.maxFavourable),
    maxAdversePct: dec(o.maxAdverse),
    target1HitAt: o.target1HitAt ? day(o.target1HitAt) : null,
    target2HitAt: o.target2HitAt ? day(o.target2HitAt) : null,
    target3HitAt: o.target3HitAt ? day(o.target3HitAt) : null,
    stopHitAt: o.stopHitAt ? day(o.stopHitAt) : null,
    closedAt: o.closedAt ? day(o.closedAt) : null,
    exitPrice: dec(o.exitPrice),
    returnPct: dec(o.returnPct),
    holdingDays: o.holdingDays,
    benchmarkReturnPct: dec(o.benchmarkReturnPct),
  };
}

export function recommendationView(r: Rec) {
  return {
    id: r.id,
    userId: r.userId,
    symbol: r.stock.symbol,
    horizon: r.horizon,
    action: r.action,
    status: r.status,
    generatedAt: r.generatedAt.toISOString(),
    asOfBar: day(r.asOfBar),
    price: dec(r.price),
    priceSource: r.priceSource,
    /** Computed on SIMULATED prices: for testing only, never investment evidence. */
    simulated: r.priceSource === 'SIMULATED',
    entryLow: dec(r.entryLow),
    entryHigh: dec(r.entryHigh),
    stop: dec(r.stop),
    target1: dec(r.target1),
    target2: dec(r.target2),
    target3: dec(r.target3),
    riskReward: dec(r.riskReward),
    holdingPeriod: r.holdingPeriod,
    holdingDaysMax: r.holdingDaysMax,
    confidence: dec(r.confidence),
    confidenceLevel: r.confidenceLevel,
    components: r.components,
    reasons: r.reasons,
    invalidations: r.invalidations,
    dataQuality: r.dataQuality,
    engineVersion: r.engineVersion,
    inputsSnapshot: r.inputsSnapshot,
  };
}

const withStock = { stock: { select: { symbol: true } } } as const;

/**
 * Append-only recommendation ledger. Recommendations are never updated or deleted (DB triggers enforce it):
 * a changed opinion is a NEW row from a newer bar or engine version. Visible to their owner; user-less
 * (system) rows are visible to everyone who is signed in.
 */
@Injectable()
export class RecommendationsStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Idempotent per user + stock + horizon + asOfBar + engineVersion: a repeat returns the stored row unchanged
   * (`created: false`), it never overwrites.
   */
  async record(
    raw: RecordRecommendationInput,
  ): Promise<{ created: boolean; recommendation: ReturnType<typeof recommendationView> }> {
    const input = recordRecommendationSchema.parse(raw);
    const stock = await this.prisma.stock.findUnique({
      where: { symbol: input.symbol },
      select: { id: true },
    });
    if (!stock)
      throw new NotFoundException({ message: `Unknown symbol: ${input.symbol}`, code: 'UNKNOWN_SYMBOL' });

    const key = {
      userId: input.userId,
      stockId: stock.id,
      horizon: input.horizon,
      asOfBar: toDate(input.asOfBar),
      engineVersion: input.engineVersion,
    };
    const find = () => this.prisma.recommendation.findFirst({ where: key, include: withStock });
    const existing = await find();
    if (existing) return { created: false, recommendation: recommendationView(existing) };
    try {
      const row = await this.prisma.recommendation.create({
        data: this.toData(input, stock.id),
        include: withStock,
      });
      await this.audit.record({
        action: 'recommendation.recorded',
        actorType: 'SYSTEM',
        actorUserId: input.userId,
        entityType: 'recommendations',
        entityId: row.id,
        after: {
          symbol: input.symbol,
          horizon: input.horizon,
          action: input.action,
          status: input.status,
          engineVersion: input.engineVersion,
        },
      });
      return { created: true, recommendation: recommendationView(row) };
    } catch (e) {
      // A concurrent identical record won the unique index: return it.
      const winner = await find();
      if (winner) return { created: false, recommendation: recommendationView(winner) };
      throw e;
    }
  }

  async list(userId: string, q: ListRecommendationsQuery) {
    const where = this.visible(userId, q);
    const [total, rows] = await Promise.all([
      this.prisma.recommendation.count({ where }),
      this.prisma.recommendation.findMany({
        where,
        include: withStock,
        orderBy: [{ generatedAt: 'desc' }, { id: 'asc' }],
        take: q.limit,
        skip: q.offset,
      }),
    ]);
    const latest = await this.latestOutcomes(rows.map((r) => r.id));
    return {
      total,
      data: rows.map((r) => {
        const o = latest.get(r.id);
        return { ...recommendationView(r), latestOutcome: o ? outcomeView(o) : null };
      }),
    };
  }

  async get(userId: string, id: string) {
    const r = await this.prisma.recommendation.findFirst({
      where: { id, OR: [{ userId }, { userId: null }] },
      include: { ...withStock, outcomes: { orderBy: [{ evaluatedAt: 'asc' }, { lastBarDate: 'asc' }] } },
    });
    if (!r) throw new NotFoundException({ message: 'Recommendation not found', code: 'NOT_FOUND' });
    const outcomes = r.outcomes.map(outcomeView);
    return { ...recommendationView(r), outcomes, latestOutcome: outcomes[outcomes.length - 1] ?? null };
  }

  async performance(userId: string, q: PerformanceQuery) {
    const recs = await this.prisma.recommendation.findMany({
      where: {
        ...this.visible(userId, q),
        status: 'ACTIONABLE',
        ...(q.includeSimulated ? {} : { priceSource: { not: 'SIMULATED' } }),
      },
      select: { id: true, horizon: true },
    });
    const latest = await this.latestOutcomes(recs.map((r) => r.id));
    const rows: PerformanceRow[] = recs.map((r) => {
      const o = latest.get(r.id);
      return {
        horizon: r.horizon,
        outcome: o
          ? {
              status: o.status,
              returnPct: o.returnPct ? fromDb(o.returnPct) : null,
              holdingDays: o.holdingDays,
              target1Hit: o.target1HitAt !== null,
              benchmarkReturnPct: o.benchmarkReturnPct ? fromDb(o.benchmarkReturnPct) : null,
            }
          : null,
      };
    });
    return {
      scope: { onlyActionable: true, includesSimulated: q.includeSimulated },
      ...performanceReport(rows, RECOMMENDATION_HORIZONS),
      note: 'Past recommendation outcomes are not a prediction or a guarantee of future returns.',
    };
  }

  private visible(
    userId: string,
    q: { action?: string; horizon?: string; status?: string; symbol?: string; from?: string; to?: string },
  ): Prisma.RecommendationWhereInput {
    return {
      OR: [{ userId }, { userId: null }],
      ...(q.action ? { action: q.action as Prisma.RecommendationWhereInput['action'] } : {}),
      ...(q.horizon ? { horizon: q.horizon as Prisma.RecommendationWhereInput['horizon'] } : {}),
      ...(q.status ? { status: q.status as Prisma.RecommendationWhereInput['status'] } : {}),
      ...(q.symbol ? { stock: { symbol: q.symbol } } : {}),
      ...(q.from || q.to
        ? {
            generatedAt: {
              ...(q.from ? { gte: pktInstant(q.from, 0) } : {}),
              ...(q.to ? { lt: pktInstant(addDays(q.to, 1), 0) } : {}),
            },
          }
        : {}),
    };
  }

  /** Newest evaluation per recommendation (by evaluatedAt, then last bar date). */
  private async latestOutcomes(ids: string[]): Promise<Map<string, Outcome>> {
    const out = new Map<string, Outcome>();
    if (ids.length === 0) return out;
    const rows = await this.prisma.recommendationOutcome.findMany({
      where: { recommendationId: { in: ids } },
      orderBy: [{ evaluatedAt: 'desc' }, { lastBarDate: 'desc' }],
    });
    for (const o of rows) if (!out.has(o.recommendationId)) out.set(o.recommendationId, o);
    return out;
  }

  private toData(i: ParsedRecommendation, stockId: string): Prisma.RecommendationUncheckedCreateInput {
    return {
      userId: i.userId,
      stockId,
      horizon: i.horizon,
      action: i.action,
      status: i.status,
      generatedAt: i.generatedAt,
      asOfBar: toDate(i.asOfBar),
      price: i.price,
      priceSource: i.priceSource,
      entryLow: i.entryLow ?? null,
      entryHigh: i.entryHigh ?? null,
      stop: i.stop ?? null,
      target1: i.target1 ?? null,
      target2: i.target2 ?? null,
      target3: i.target3 ?? null,
      riskReward: i.riskReward ?? null,
      holdingPeriod: i.holdingPeriod ?? null,
      holdingDaysMax: i.holdingDaysMax ?? null,
      confidence: i.confidence,
      confidenceLevel: i.confidenceLevel,
      components: i.components as Prisma.InputJsonValue,
      reasons: i.reasons as Prisma.InputJsonValue,
      invalidations: i.invalidations as Prisma.InputJsonValue,
      dataQuality: i.dataQuality as Prisma.InputJsonValue,
      engineVersion: i.engineVersion,
      inputsSnapshot: i.inputsSnapshot as Prisma.InputJsonValue,
    };
  }
}
