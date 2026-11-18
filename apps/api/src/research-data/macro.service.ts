import { Inject, Injectable } from '@nestjs/common';
import { d } from '@ktrade/finance-core';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { pktDateOf } from '../market-data/calendar.js';
import { CLOCK, type Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { fromDb } from '../market-data/decimal-format.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fieldError } from './csv.js';
import type { MacroInput } from './research-data.schemas.js';

const toDate = (s: string): Date => new Date(`${s}T00:00:00Z`);

type Row = Prisma.MacroObservationGetPayload<object>;
const view = (r: Row) => ({
  id: r.id,
  series: r.series,
  date: r.date.toISOString().slice(0, 10),
  value: fromDb(r.value).toFixed(),
  source: r.source,
  sourceRef: r.sourceRef,
});

/** Owner-entered macro observations (policy rate, CPI, USD/PKR, KIBOR, KSE-100). One value per series + date. */
@Injectable()
export class MacroService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(userId: string, input: MacroInput, meta: RequestMeta) {
    if (input.date > pktDateOf(this.clock.now())) throw fieldError('date', 'must not be in the future');
    const where = {
      series_date_source: {
        series: input.series,
        date: toDate(input.date),
        source: 'USER_REPORTED' as const,
      },
    };
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.macroObservation.findUnique({ where });
      const row = existing
        ? d(existing.value.toFixed()).eq(d(input.value)) && existing.sourceRef === input.sourceRef
          ? existing
          : await tx.macroObservation.update({
              where,
              data: { value: input.value, sourceRef: input.sourceRef },
            })
        : await tx.macroObservation.create({
            data: {
              series: input.series,
              date: toDate(input.date),
              value: input.value,
              source: 'USER_REPORTED',
              sourceRef: input.sourceRef,
            },
          });
      if (row !== existing)
        await this.audit.record(
          {
            action: existing ? 'research.macro_corrected' : 'research.macro_recorded',
            actorType: 'USER',
            actorUserId: userId,
            entityType: 'macro_observations',
            entityId: row.id,
            before: existing ? view(existing) : undefined,
            after: view(row),
            ...meta,
          },
          tx,
        );
      return { ...view(row), created: !existing };
    });
  }

  async list(q: { series?: Row['series']; from?: string; to?: string; limit: number }) {
    const rows = await this.prisma.macroObservation.findMany({
      where: {
        ...(q.series ? { series: q.series } : {}),
        ...(q.from || q.to
          ? { date: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } }
          : {}),
      },
      orderBy: [{ date: 'desc' }, { series: 'asc' }],
      take: q.limit,
    });
    return {
      data: rows.map(view),
      note:
        rows.length === 0
          ? 'No macro observations on file. Nothing is estimated.'
          : 'Owner-entered (USER_REPORTED).',
    };
  }
}
