import { Injectable } from '@nestjs/common';
import {
  computeTradeFees,
  d,
  type Decimal,
  type FeeBreakdown,
  type FeeScheduleSpec,
  ktradeDefaultSchedule,
  selectFeeSchedule,
} from '@ktrade/finance-core';
import type { OrderSide } from '@ktrade/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/** KTrade's published schedule (Commission Structure PDF) — the fallback when none is configured in the DB. */
export const DEFAULT_SCHEDULE_EFFECTIVE_FROM = '2025-01-01';

/** Estimates fees with the effective-dated schedule from the DB (or KTrade's published default). */
@Injectable()
export class FeeService {
  constructor(private readonly prisma: PrismaService) {}

  async scheduleFor(date: string, brokerCode = 'KTRADE'): Promise<{ spec: FeeScheduleSpec; scheduleId: string | null }> {
    const rows = await this.prisma.feeSchedule.findMany({ where: { brokerCode }, include: { items: true } });
    if (rows.length === 0) return { spec: ktradeDefaultSchedule(DEFAULT_SCHEDULE_EFFECTIVE_FROM), scheduleId: null };
    const specs = rows.map((r) => ({
      id: r.id,
      brokerCode: r.brokerCode,
      name: r.name,
      effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
      sourceNote: r.sourceNote,
      items: r.items.map((i) => ({
        component: i.component,
        appliesTo: i.appliesTo,
        method: i.method,
        rate: i.rate ? d(i.rate.toString()) : null,
        perShare: i.perShare ? d(i.perShare.toString()) : null,
        fixedAmount: i.fixedAmount ? d(i.fixedAmount.toString()) : null,
        minAmount: i.minAmount ? d(i.minAmount.toString()) : null,
        baseComponent: i.baseComponent,
        capitalise: i.capitalise,
        sortOrder: i.sortOrder,
      })),
    }));
    const chosen = selectFeeSchedule(specs, date);
    return { spec: chosen, scheduleId: chosen.id };
  }

  async estimate(side: OrderSide, quantity: Decimal, price: Decimal, date: string): Promise<FeeBreakdown & { scheduleId: string | null }> {
    const { spec, scheduleId } = await this.scheduleFor(date);
    return { ...computeTradeFees(spec, { side, quantity, price }), scheduleId };
  }
}
