import { Injectable, NotFoundException } from '@nestjs/common';
import { d, type Decimal, pct, roundMoney, ZERO } from '@ktrade/finance-core';
import { type DataSource, weakestSource } from '@ktrade/shared';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const dec = (v: { toString(): string } | null | undefined): Decimal =>
  v === null || v === undefined ? ZERO : d(v.toString());
const money = (x: Decimal) => roundMoney(x).toFixed(4);
const pctStr = (x: Decimal | null) => (x === null ? null : x.toDecimalPlaces(4).toFixed(4));

/** Conservative defaults for a new paper portfolio (all editable, step-up protected). */
export const DEFAULT_PAPER_LIMITS = {
  maxOrderValue: '250000',
  maxOrderQty: '10000',
  maxDailyTradedValue: '1000000',
  maxDailyOrders: 25,
  maxPositionPct: '25',
  priceBandPct: '7.5',
  maxDailyLossPct: '5',
  allowMarketOrders: true,
};

@Injectable()
export class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string) {
    const rows = await this.prisma.portfolio.findMany({
      where: { userId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      costBasisMethod: p.costBasisMethod,
      baseCurrency: p.baseCurrency,
      initialCash: p.initialCash?.toString() ?? null,
    }));
  }

  async createPaper(userId: string, name: string, initialCash: string, meta: RequestMeta) {
    const p = await this.prisma.$transaction(async (tx) => {
      const created = await tx.portfolio.create({
        data: { userId, name, kind: 'PAPER', initialCash, riskLimit: { create: DEFAULT_PAPER_LIMITS } },
      });
      await tx.cashMovement.create({
        data: {
          portfolioId: created.id,
          type: 'DEPOSIT',
          amount: initialCash,
          valueDate: new Date(),
          description: 'Paper trading starting cash',
          source: 'SIMULATED',
        },
      });
      await this.audit.record(
        {
          action: 'portfolio.created',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'portfolio',
          entityId: created.id,
          after: { name, kind: 'PAPER', initialCash },
          ...meta,
        },
        tx,
      );
      return created;
    });
    return { id: p.id, name: p.name, kind: p.kind };
  }

  async owned(userId: string, portfolioId: string) {
    const p = await this.prisma.portfolio.findFirst({ where: { id: portfolioId, userId, archivedAt: null } });
    if (!p) throw new NotFoundException({ message: 'Portfolio not found', code: 'NOT_FOUND' });
    return p;
  }

  async holdings(userId: string, portfolioId: string) {
    await this.owned(userId, portfolioId);
    const rows = await this.prisma.holding.findMany({
      where: { portfolioId, quantity: { gt: 0 } },
      include: { stock: { include: { quote: true } } },
      orderBy: { stock: { symbol: 'asc' } },
    });
    const valued = rows.map((h) => {
      const qty = dec(h.quantity);
      const last = h.stock.quote ? dec(h.stock.quote.last) : null;
      const mv = last ? qty.times(last) : null;
      return { h, qty, last, mv };
    });
    const totalMv = valued.reduce((a, v) => a.plus(v.mv ?? ZERO), ZERO);
    return valued.map(({ h, qty, last, mv }) => {
      const totalCost = dec(h.totalCost);
      const unrealized = mv ? mv.minus(totalCost) : null;
      return {
        symbol: h.stock.symbol,
        companyName: h.stock.name,
        sector: h.stock.sector,
        quantity: qty.toFixed(),
        avgCost: dec(h.avgCost).toFixed(6),
        totalCost: money(totalCost),
        lastPrice: last
          ? { value: last.toFixed(), source: h.stock.quote!.source, asOf: h.stock.quote!.asOf.toISOString() }
          : null,
        marketValue: mv ? { value: money(mv), source: h.stock.quote!.source } : null,
        unrealizedPnl: unrealized
          ? {
              value: money(unrealized),
              pct: pctStr(pct(unrealized, totalCost)),
              source: 'ESTIMATED' as DataSource,
            }
          : null,
        realizedPnl: money(dec(h.realizedPnl)),
        weightPct: mv ? pctStr(pct(mv, totalMv)) : null,
        lastConfirmed: h.lastConfirmed?.toISOString() ?? null,
      };
    });
  }

  async transactions(userId: string, portfolioId: string, limit: number, cursor?: string) {
    await this.owned(userId, portfolioId);
    const rows = await this.prisma.transaction.findMany({
      where: { portfolioId },
      orderBy: [{ tradeDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { stock: { select: { symbol: true } }, fees: true },
    });
    const page = rows.slice(0, limit);
    return {
      data: page.map((t) => ({
        id: t.id,
        symbol: t.stock.symbol,
        type: t.type,
        tradeDate: t.tradeDate.toISOString().slice(0, 10),
        quantity: t.quantity.toString(),
        price: t.price.toString(),
        grossAmount: t.grossAmount.toString(),
        feesTotal: t.feesTotal.toString(),
        taxesTotal: t.taxesTotal.toString(),
        netAmount: t.netAmount.toString(),
        realizedPnl: t.realizedPnl?.toString() ?? null,
        source: t.source,
        reversed: t.reversedById !== null,
        fees: t.fees.map((f) => ({ component: f.component, amount: f.amount.toString(), source: f.source })),
      })),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
    };
  }

  async addCash(
    userId: string,
    portfolioId: string,
    type: 'DEPOSIT' | 'WITHDRAWAL',
    amount: string,
    valueDate: string,
    description: string | undefined,
    meta: RequestMeta,
  ) {
    const p = await this.owned(userId, portfolioId);
    const source: DataSource = p.kind === 'PAPER' ? 'SIMULATED' : 'USER_REPORTED';
    const signed = type === 'DEPOSIT' ? d(amount) : d(amount).neg();
    const row = await this.prisma.$transaction(async (tx) => {
      const m = await tx.cashMovement.create({
        data: {
          portfolioId,
          type,
          amount: signed.toFixed(4),
          valueDate: new Date(`${valueDate}T00:00:00Z`),
          description: description ?? null,
          source,
        },
      });
      await this.audit.record(
        {
          action: 'cash.recorded',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'cash_movement',
          entityId: m.id,
          after: { type, amount },
          ...meta,
        },
        tx,
      );
      return m;
    });
    return { id: row.id, type, amount: row.amount.toString(), source };
  }

  async riskLimits(userId: string, portfolioId: string) {
    await this.owned(userId, portfolioId);
    const r = await this.prisma.riskLimit.findUnique({ where: { portfolioId } });
    return r ? this.serializeLimits(r) : null;
  }

  async setRiskLimits(
    userId: string,
    portfolioId: string,
    input: typeof DEFAULT_PAPER_LIMITS,
    meta: RequestMeta,
  ) {
    await this.owned(userId, portfolioId);
    const before = await this.prisma.riskLimit.findUnique({ where: { portfolioId } });
    const after = await this.prisma.$transaction(async (tx) => {
      const r = await tx.riskLimit.upsert({
        where: { portfolioId },
        create: { portfolioId, ...input },
        update: input,
      });
      await this.audit.record(
        {
          action: 'settings.risk_limits_changed',
          actorType: 'USER',
          actorUserId: userId,
          entityType: 'portfolio',
          entityId: portfolioId,
          before: before ? this.serializeLimits(before) : null,
          after: this.serializeLimits(r),
          ...meta,
        },
        tx,
      );
      return r;
    });
    return this.serializeLimits(after);
  }

  /** Dashboard KPIs (docs/02, docs/06 §5). Every figure carries provenance; aggregates report their weakest input. */
  async summary(userId: string, portfolioId: string) {
    const p = await this.owned(userId, portfolioId);
    const [holdings, cash, closed, feesAgg, divAgg, pendingOrders, brokerCash] = await Promise.all([
      this.holdings(userId, portfolioId),
      this.ledger.cashBalance(this.prisma, portfolioId),
      this.prisma.holding.aggregate({ where: { portfolioId }, _sum: { realizedPnl: true } }),
      this.prisma.transaction.aggregate({
        where: { portfolioId, reversedById: null },
        _sum: { feesTotal: true, taxesTotal: true },
      }),
      this.prisma.dividendEntitlement.aggregate({
        where: { portfolioId, status: { in: ['PAID', 'RECONCILED'] } },
        _sum: { netAmount: true },
      }),
      this.prisma.order.count({
        where: {
          portfolioId,
          status: {
            in: [
              'PREVIEWED',
              'APPROVED',
              'AWAITING_MANUAL_PLACEMENT',
              'PLACED_BY_USER',
              'SUBMITTED',
              'ACCEPTED',
              'PARTIALLY_FILLED',
            ],
          },
        },
      }),
      p.brokerAccountId
        ? this.prisma.brokerBalanceSnapshot.findFirst({
            where: { brokerAccountId: p.brokerAccountId },
            orderBy: { asOf: 'desc' },
          })
        : Promise.resolve(null),
    ]);
    const priced = holdings.filter((h) => h.marketValue);
    const mv = priced.reduce((a, h) => a.plus(d(h.marketValue!.value)), ZERO);
    const invested = holdings.reduce((a, h) => a.plus(d(h.totalCost)), ZERO);
    const unrealized = priced.reduce((a, h) => a.plus(d(h.unrealizedPnl!.value)), ZERO);
    const priceSources = priced.map((h) => h.marketValue!.source as DataSource);
    const ledgerSource: DataSource = p.kind === 'PAPER' ? 'SIMULATED' : 'USER_REPORTED';
    const valueSource = weakestSource([...priceSources, ledgerSource]);
    const netContrib = await this.prisma.cashMovement.aggregate({
      where: { portfolioId, type: { in: ['DEPOSIT', 'WITHDRAWAL'] } },
      _sum: { amount: true },
    });
    const contributions = dec(netContrib._sum.amount);
    const accountValue = cash.plus(mv);

    return {
      portfolio: { id: p.id, name: p.name, kind: p.kind },
      accountValue: { value: money(accountValue), source: valueSource },
      portfolioValue: {
        value: money(mv),
        source: weakestSource(priceSources.length ? priceSources : [ledgerSource]),
      },
      investedAmount: { value: money(invested), source: ledgerSource },
      cash: {
        ledger: { value: money(cash), source: ledgerSource },
        broker: brokerCash
          ? {
              value: brokerCash.cashBalance.toString(),
              asOf: brokerCash.asOf.toISOString(),
              source: brokerCash.source,
            }
          : null,
      },
      realizedPnl: { value: money(dec(closed._sum.realizedPnl)), source: ledgerSource },
      unrealizedPnl: { value: money(unrealized), source: 'ESTIMATED' as DataSource },
      totalReturnPct: {
        value: pctStr(contributions.gt(0) ? pct(accountValue.minus(contributions), contributions) : null),
        method: 'SIMPLE',
        source: valueSource,
      },
      todayPnl: { value: null, note: 'Available once daily snapshots run (Phase 10)' },
      monthPnl: { value: null, note: 'Available once daily snapshots run (Phase 10)' },
      dividendsReceived: { value: money(dec(divAgg._sum.netAmount)), source: ledgerSource },
      feesAndTaxes: {
        fees: money(dec(feesAgg._sum.feesTotal)),
        taxes: money(dec(feesAgg._sum.taxesTotal)),
        source: 'ESTIMATED' as DataSource,
      },
      activeHoldings: holdings.length,
      pendingOrders,
      unpricedHoldings: holdings.length - priced.length,
    };
  }

  private serializeLimits(r: {
    maxOrderValue: { toString(): string };
    maxOrderQty: { toString(): string };
    maxDailyTradedValue: { toString(): string };
    maxDailyOrders: number;
    maxPositionPct: { toString(): string };
    priceBandPct: { toString(): string };
    maxDailyLossPct: { toString(): string };
    allowMarketOrders: boolean;
    liveAutoExecutionEnabled: boolean;
  }) {
    return {
      maxOrderValue: r.maxOrderValue.toString(),
      maxOrderQty: r.maxOrderQty.toString(),
      maxDailyTradedValue: r.maxDailyTradedValue.toString(),
      maxDailyOrders: r.maxDailyOrders,
      maxPositionPct: r.maxPositionPct.toString(),
      priceBandPct: r.priceBandPct.toString(),
      maxDailyLossPct: r.maxDailyLossPct.toString(),
      allowMarketOrders: r.allowMarketOrders,
      liveAutoExecutionEnabled: r.liveAutoExecutionEnabled,
    };
  }
}
