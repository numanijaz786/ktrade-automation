import { Global, Injectable, Module } from '@nestjs/common';
import type { ActorType } from '@ktrade/shared';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntry {
  action: string; // e.g. "auth.login", "order.approved"
  actorType: ActorType;
  actorUserId?: string | null;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

/** Keys that must never be persisted in audit payloads, at any depth. */
const SECRET_KEYS = /pass(word)?|secret|token|totp|code|key|cookie|authorization/i;

export function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SECRET_KEYS.test(k) ? '[REDACTED]' : scrubSecrets(v, depth + 1),
    ]),
  );
}

const json = (v: unknown) =>
  v === undefined ? undefined : (scrubSecrets(JSON.parse(JSON.stringify(v))) as Prisma.InputJsonValue);

/**
 * Append-only audit trail (docs/04 §8). Writes are awaited and errors propagate: a security-relevant
 * action that cannot be audited must not silently succeed (fail closed).
 * Pass `tx` to write inside the caller's transaction.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        action: entry.action,
        actorType: entry.actorType,
        actorUserId: entry.actorUserId ?? null,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        before: json(entry.before),
        after: json(entry.after),
        metadata: json(entry.metadata ?? {}) ?? {},
        requestId: entry.requestId ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent?.slice(0, 512) ?? null,
      },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
