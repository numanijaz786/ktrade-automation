import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { allOff, type CapabilityManifest } from '@ktrade/broker-sdk';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/decorators.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Conservative defaults for a LIVE portfolio (owner edits them with step-up). Market orders off by default. */
export const DEFAULT_LIVE_LIMITS = {
  maxOrderValue: '100000',
  maxOrderQty: '5000',
  maxDailyTradedValue: '300000',
  maxDailyOrders: 10,
  maxPositionPct: '25',
  priceBandPct: '5',
  maxDailyLossPct: '3',
  allowMarketOrders: false,
};

const manifestJson = (m: CapabilityManifest) => m as unknown as Prisma.InputJsonValue;

/**
 * Registers the owner's KTrade account and its LIVE portfolio. No credentials are collected (docs/04):
 * the account is a bookkeeping anchor for imports and manual-ticket orders. KTrade automation adapters are
 * created DISABLED with every capability off (docs/03).
 */
@Injectable()
export class BrokerAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string) {
    const rows = await this.prisma.brokerAccount.findMany({
      where: { userId, isActive: true },
      include: { portfolios: { where: { kind: 'LIVE', archivedAt: null }, select: { id: true, name: true } }, connections: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((a) => ({
      id: a.id,
      brokerCode: a.brokerCode,
      displayName: a.displayName,
      clientCodeMasked: a.clientCodeMasked,
      portfolios: a.portfolios,
      connections: a.connections.map((c) => ({ adapter: c.adapter, status: c.status, capabilities: c.capabilities, authorizationRef: c.authorizationRef })),
    }));
  }

  async create(userId: string, input: { displayName: string; clientCodeLast4?: string; portfolioName: string }, meta: RequestMeta) {
    try {
      const account = await this.prisma.$transaction(async (tx) => {
        const a = await tx.brokerAccount.create({
          data: {
            userId,
            brokerCode: 'KTRADE',
            displayName: input.displayName,
            clientCodeMasked: input.clientCodeLast4 ? `****${input.clientCodeLast4}` : null,
            portfolios: {
              create: { userId, name: input.portfolioName, kind: 'LIVE', riskLimit: { create: DEFAULT_LIVE_LIMITS } },
            },
            connections: {
              create: [
                // Statement/CSV import is always available; it reads files the owner supplies, not the broker.
                { adapter: 'MANUAL_IMPORT', status: 'CONNECTED', capabilities: manifestJson(allOff()) },
                { adapter: 'KTRADE_OFFICIAL_API', status: 'DISABLED', capabilities: manifestJson(allOff()) },
                { adapter: 'KTRADE_BROWSER', status: 'PENDING_AUTHORIZATION', capabilities: manifestJson(allOff()) },
              ],
            },
          },
        });
        await this.audit.record({ action: 'integration.account_registered', actorType: 'USER', actorUserId: userId, entityType: 'broker_account', entityId: a.id, after: { displayName: input.displayName }, ...meta }, tx);
        return a;
      });
      return (await this.list(userId)).find((a) => a.id === account.id)!;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ message: 'An account or portfolio with that name already exists', code: 'ALREADY_EXISTS' });
      }
      throw err;
    }
  }

  async connections(userId: string, accountId: string) {
    const a = (await this.list(userId)).find((x) => x.id === accountId);
    if (!a) throw new NotFoundException({ message: 'Broker account not found', code: 'NOT_FOUND' });
    return a.connections;
  }
}
