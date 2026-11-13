import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import type { AuthTokensResponse, LoginInput, RegisterInput } from '@ktrade/shared';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { AppConfig } from '../config/config.module.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { openFromBuffer, sealToBuffer } from '../security/envelope.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../security/totp.js';
import type { RequestMeta } from './decorators.js';
import { TokenService } from './token.service.js';

import { ARGON2_OPTIONS, LOCKOUT_MS, MAX_FAILED_LOGINS } from './password-policy.js';

export interface IssuedSession extends AuthTokensResponse {
  refreshToken: string;
  refreshExpiresAt: Date;
}

const invalidCredentials = () =>
  new UnauthorizedException({ message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });

@Injectable()
export class AuthService {
  /** Hash of a random password: verifying against it equalises timing for unknown emails (no user enumeration). */
  private readonly dummyHash = argon2.hash(randomUUID(), ARGON2_OPTIONS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get kek(): Buffer {
    return Buffer.from(this.config.get('APP_MASTER_KEY'), 'base64');
  }
  private totpAad = (userId: string) => `totp|${userId}`;

  /** Single-owner platform: registration is open only until the first OWNER exists. */
  async register(input: RegisterInput, meta: RequestMeta): Promise<IssuedSession> {
    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);
    const user = await this.prisma.$transaction(
      async (tx) => {
        if ((await tx.user.count()) > 0) {
          throw new ForbiddenException({ message: 'Registration is closed', code: 'REGISTRATION_CLOSED' });
        }
        const created = await tx.user.create({
          data: { email: input.email, passwordHash, displayName: input.displayName, role: 'OWNER', settings: { create: {} } },
        });
        await this.audit.record(
          { action: 'auth.registered', actorType: 'USER', actorUserId: created.id, entityType: 'user', entityId: created.id, ...meta },
          tx,
        );
        return created;
      },
      { isolationLevel: 'Serializable' },
    );
    return this.issueSession(user, meta);
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !user.isActive) {
      await argon2.verify(await this.dummyHash, input.password).catch(() => false);
      await this.audit.record({ action: 'auth.login_failed', actorType: 'USER', metadata: { reason: 'unknown_user' }, ...meta });
      throw invalidCredentials();
    }
    const now = this.clock.now();
    if (user.lockedUntil && user.lockedUntil > now) {
      throw new HttpException(
        { message: 'Account temporarily locked after repeated failures', code: 'ACCOUNT_LOCKED' },
        HttpStatus.LOCKED,
      );
    }

    const passwordOk = await argon2.verify(user.passwordHash, input.password);
    if (!passwordOk) {
      await this.registerFailure(user, now, 'bad_password', meta);
      throw invalidCredentials();
    }

    if (user.totpEnabled) {
      if (!input.totpCode) {
        throw new UnauthorizedException({ message: 'Two-factor code required', code: 'TOTP_REQUIRED' });
      }
      const step = this.checkTotp(user, input.totpCode, now);
      if (step === null) {
        await this.registerFailure(user, now, 'bad_totp', meta);
        throw new UnauthorizedException({ message: 'Invalid two-factor code', code: 'INVALID_TOTP' });
      }
      await this.prisma.user.update({ where: { id: user.id }, data: { totpLastStep: step } });
    }

    if (argon2.needsRehash(user.passwordHash, ARGON2_OPTIONS)) {
      await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await argon2.hash(input.password, ARGON2_OPTIONS) } });
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    });
    await this.audit.record({ action: 'auth.login', actorType: 'USER', actorUserId: user.id, entityType: 'user', entityId: user.id, ...meta });
    return this.issueSession(user, meta);
  }

  /**
   * Refresh-token rotation with reuse detection (docs/04 §2). Presenting an already-rotated token means it
   * leaked or was replayed: the whole session family is revoked and the user must log in again.
   */
  async refresh(rawToken: string | undefined, meta: RequestMeta): Promise<IssuedSession> {
    if (!rawToken) throw new UnauthorizedException({ message: 'No session', code: 'NO_SESSION' });
    const hash = TokenService.hash(rawToken);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash }, include: { user: true } });
    if (!existing) throw new UnauthorizedException({ message: 'Invalid session', code: 'INVALID_SESSION' });
    const now = this.clock.now();

    if (existing.revokedAt) {
      await this.revokeFamily(existing.familyId, 'reuse_detected');
      await this.audit.record({
        action: 'auth.refresh_reuse_detected',
        actorType: 'SYSTEM',
        actorUserId: existing.userId,
        entityType: 'session',
        entityId: existing.familyId,
        ...meta,
      });
      throw new UnauthorizedException({ message: 'Session revoked', code: 'SESSION_REVOKED' });
    }
    if (existing.expiresAt <= now || !existing.user.isActive) {
      throw new UnauthorizedException({ message: 'Session expired', code: 'SESSION_EXPIRED' });
    }

    const next = this.tokens.newRefreshToken();
    const nextExpiry = this.tokens.refreshExpiry(now);
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: {
          userId: existing.userId,
          familyId: existing.familyId,
          tokenHash: next.hash,
          expiresAt: nextExpiry,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent?.slice(0, 512) ?? null,
        },
      });
      // Conditional update: if a concurrent request already rotated this token, count is 0 → treat as reuse.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'rotated', replacedById: created.id, lastUsedAt: now },
      });
      if (count !== 1) throw new UnauthorizedException({ message: 'Session revoked', code: 'SESSION_REVOKED' });
    });

    return this.buildSession(existing.user, existing.familyId, next.raw, nextExpiry);
  }

  async logout(sessionId: string, userId: string, meta: RequestMeta): Promise<void> {
    await this.revokeFamily(sessionId, 'logout', userId);
    await this.audit.record({ action: 'auth.logout', actorType: 'USER', actorUserId: userId, entityType: 'session', entityId: sessionId, ...meta });
  }

  async listSessions(userId: string, currentSessionId: string) {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: this.clock.now() } },
      orderBy: { issuedAt: 'desc' },
      select: { familyId: true, issuedAt: true, expiresAt: true, ip: true, userAgent: true },
    });
    return rows.map((r) => ({
      id: r.familyId,
      lastActiveAt: r.issuedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      ip: r.ip,
      userAgent: r.userAgent,
      current: r.familyId === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string, meta: RequestMeta): Promise<void> {
    const n = await this.revokeFamily(sessionId, 'user_revoked', userId);
    if (n === 0) throw new ConflictException({ message: 'Session not found or already revoked', code: 'NOT_FOUND' });
    await this.audit.record({ action: 'auth.session_revoked', actorType: 'USER', actorUserId: userId, entityType: 'session', entityId: sessionId, ...meta });
  }

  async revokeAllSessions(userId: string, meta: RequestMeta): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokeReason: 'revoke_all' },
    });
    await this.audit.record({ action: 'auth.sessions_revoked_all', actorType: 'USER', actorUserId: userId, metadata: { count }, ...meta });
    return count;
  }

  /** Step-up: TOTP when enabled, otherwise password re-entry. Returns a short-lived token for 🔐 routes. */
  async stepUp(userId: string, proof: { totpCode?: string; password?: string }, meta: RequestMeta): Promise<{ stepUpToken: string; expiresIn: number }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const now = this.clock.now();
    let ok = false;
    if (user.totpEnabled) {
      const step = proof.totpCode ? this.checkTotp(user, proof.totpCode, now) : null;
      if (step !== null) {
        await this.prisma.user.update({ where: { id: user.id }, data: { totpLastStep: step } });
        ok = true;
      }
    } else if (proof.password) {
      ok = await argon2.verify(user.passwordHash, proof.password);
    }
    await this.audit.record({ action: ok ? 'auth.step_up' : 'auth.step_up_failed', actorType: 'USER', actorUserId: userId, ...meta });
    if (!ok) throw new ForbiddenException({ message: 'Verification failed', code: 'STEP_UP_FAILED' });
    return { stepUpToken: await this.tokens.signStepUp(userId), expiresIn: this.config.get('STEP_UP_TTL_SECONDS') };
  }

  async beginTotpEnrolment(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabled) throw new ConflictException({ message: 'Two-factor already enabled', code: 'TOTP_ALREADY_ENABLED' });
    const secret = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: userId },
      // Prisma Bytes expects an ArrayBuffer-backed Uint8Array; copy out of Node's pooled Buffer.
      data: {
        totpPendingEnc: new Uint8Array(
          sealToBuffer(this.kek, this.config.get('APP_MASTER_KEY_VERSION'), secret, this.totpAad(userId)),
        ),
      },
    });
    // Shown once to the owner for their authenticator app; never logged.
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  async confirmTotpEnrolment(userId: string, code: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpPendingEnc) throw new ConflictException({ message: 'No enrolment in progress', code: 'NO_PENDING_TOTP' });
    const secret = openFromBuffer(this.kek, Buffer.from(user.totpPendingEnc), this.totpAad(userId));
    const res = verifyTotp(secret, code, this.clock.now().getTime());
    if (!res.ok) throw new ForbiddenException({ message: 'Invalid two-factor code', code: 'INVALID_TOTP' });
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecretEnc: user.totpPendingEnc, totpPendingEnc: null, totpEnabled: true, totpLastStep: res.step! },
    });
    await this.audit.record({ action: 'auth.totp_enabled', actorType: 'USER', actorUserId: userId, ...meta });
  }

  async disableTotp(userId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: false, totpSecretEnc: null, totpPendingEnc: null, totpLastStep: null },
    });
    await this.audit.record({ action: 'auth.totp_disabled', actorType: 'USER', actorUserId: userId, ...meta });
  }

  async changePassword(userId: string, current: string, next: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await argon2.verify(user.passwordHash, current))) throw invalidCredentials();
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await argon2.hash(next, ARGON2_OPTIONS) } });
    await this.revokeAllSessions(userId, meta);
    await this.audit.record({ action: 'auth.password_changed', actorType: 'USER', actorUserId: userId, ...meta });
  }

  async me(userId: string): Promise<AuthTokensResponse['user']> {
    return this.publicUser(await this.prisma.user.findUniqueOrThrow({ where: { id: userId } }));
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private checkTotp(user: User, code: string, now: Date): bigint | null {
    if (!user.totpSecretEnc) return null;
    const secret = openFromBuffer(this.kek, Buffer.from(user.totpSecretEnc), this.totpAad(user.id));
    const res = verifyTotp(secret, code, now.getTime(), user.totpLastStep ?? null);
    return res.ok ? res.step! : null;
  }

  private async registerFailure(user: User, now: Date, reason: string, meta: RequestMeta): Promise<void> {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + LOCKOUT_MS) : user.lockedUntil },
    });
    await this.audit.record({
      action: lock ? 'auth.account_locked' : 'auth.login_failed',
      actorType: 'USER',
      actorUserId: user.id,
      metadata: { reason, failed },
      ...meta,
    });
  }

  private async revokeFamily(familyId: string, reason: string, userId?: string): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null, ...(userId ? { userId } : {}) },
      data: { revokedAt: this.clock.now(), revokeReason: reason },
    });
    return count;
  }

  private async issueSession(user: User, meta: RequestMeta): Promise<IssuedSession> {
    const familyId = randomUUID();
    const rt = this.tokens.newRefreshToken();
    const expiresAt = this.tokens.refreshExpiry(this.clock.now());
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: rt.hash,
        expiresAt,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
      },
    });
    return this.buildSession(user, familyId, rt.raw, expiresAt);
  }

  private async buildSession(user: User, familyId: string, rawRefresh: string, refreshExpiresAt: Date): Promise<IssuedSession> {
    return {
      accessToken: await this.tokens.signAccess({ sub: user.id, role: user.role, sid: familyId }),
      expiresIn: this.tokens.accessTtlSeconds,
      user: this.publicUser(user),
      refreshToken: rawRefresh,
      refreshExpiresAt,
    };
  }

  private publicUser(user: User): AuthTokensResponse['user'] {
    return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, totpEnabled: user.totpEnabled };
  }
}
