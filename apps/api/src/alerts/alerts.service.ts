import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EVALUABLE_ALERT_TYPES, type EvaluableAlertType } from './alert-rules.js';
import {
  alertParamsSchemas,
  type CreateAlertInput,
  thresholdOf,
  type UpdateAlertInput,
} from './alerts.schemas.js';

const include = {
  stock: { select: { symbol: true } },
  portfolio: { select: { id: true, name: true } },
} as const;
type AlertRow = Prisma.AlertGetPayload<{ include: typeof include }>;

export function alertView(a: AlertRow) {
  return {
    id: a.id,
    type: a.type,
    symbol: a.stock?.symbol ?? null,
    portfolio: a.portfolio ? { id: a.portfolio.id, name: a.portfolio.name } : null,
    params: a.params as Record<string, string>,
    threshold: a.threshold?.toString() ?? null,
    channels: a.channels,
    isActive: a.isActive,
    triggerOnce: a.triggerOnce,
    cooldownMinutes: a.cooldownMinutes,
    lastTriggeredAt: a.lastTriggeredAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/** Owner-scoped alert CRUD. Other users' alerts are 404 (ids are not disclosed). Every change is audited. */
@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string) {
    const rows = await this.prisma.alert.findMany({
      where: { userId, type: { in: [...EVALUABLE_ALERT_TYPES] } },
      include,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(alertView);
  }

  async get(userId: string, id: string) {
    return alertView(await this.owned(userId, id));
  }

  async create(userId: string, input: CreateAlertInput, meta: RequestMeta) {
    let stockId: string | null = null;
    if ('symbol' in input) {
      const stock = await this.prisma.stock.findUnique({ where: { symbol: input.symbol } });
      if (!stock)
        throw new NotFoundException({ message: `Unknown symbol ${input.symbol}`, code: 'UNKNOWN_SYMBOL' });
      stockId = stock.id;
    }
    let portfolioId: string | null = null;
    if ('portfolioId' in input) {
      const p = await this.prisma.portfolio.findFirst({
        where: { id: input.portfolioId, userId, archivedAt: null },
      });
      if (!p) throw new NotFoundException({ message: 'Portfolio not found', code: 'NOT_FOUND' });
      portfolioId = p.id;
    }
    const params = input.params as Record<string, string>;
    const created = await this.prisma.$transaction(async (tx) => {
      const a = await tx.alert.create({
        data: {
          userId,
          type: input.type,
          stockId,
          portfolioId,
          threshold: thresholdOf(input.type, params),
          params,
          channels: input.channels,
          isActive: input.isActive,
          triggerOnce: input.triggerOnce,
          cooldownMinutes: input.cooldownMinutes,
        },
        include,
      });
      await this.audit.record(
        {
          action: 'alert.created',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'alert',
          entityId: a.id,
          after: alertView(a),
          ...meta,
        },
        tx,
      );
      return a;
    });
    return alertView(created);
  }

  async update(userId: string, id: string, input: UpdateAlertInput, meta: RequestMeta) {
    const before = await this.owned(userId, id);
    const type = before.type as EvaluableAlertType;
    const params = input.params ? alertParamsSchemas[type].parse(input.params) : undefined;
    // Re-enabling an alert (or changing what it watches) re-arms it.
    const rearm =
      (input.isActive === true && !before.isActive) || params !== undefined || input.triggerOnce === false;
    const after = await this.prisma.$transaction(async (tx) => {
      const a = await tx.alert.update({
        where: { id },
        data: {
          ...(params ? { params, threshold: thresholdOf(type, params as Record<string, string>) } : {}),
          ...(input.channels ? { channels: input.channels } : {}),
          ...(input.cooldownMinutes !== undefined ? { cooldownMinutes: input.cooldownMinutes } : {}),
          ...(input.triggerOnce !== undefined ? { triggerOnce: input.triggerOnce } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(rearm ? { lastTriggeredAt: null } : {}),
        },
        include,
      });
      await this.audit.record(
        {
          action: 'alert.updated',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'alert',
          entityId: id,
          before: alertView(before),
          after: alertView(a),
          ...meta,
        },
        tx,
      );
      return a;
    });
    return alertView(after);
  }

  async remove(userId: string, id: string, meta: RequestMeta) {
    const before = await this.owned(userId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.alert.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'alert.deleted',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'alert',
          entityId: id,
          before: alertView(before),
          ...meta,
        },
        tx,
      );
    });
  }

  private async owned(userId: string, id: string): Promise<AlertRow> {
    const a = await this.prisma.alert.findFirst({
      where: { id, userId, type: { in: [...EVALUABLE_ALERT_TYPES] } },
      include,
    });
    if (!a) throw new NotFoundException({ message: 'Alert not found', code: 'NOT_FOUND' });
    return a;
  }
}
