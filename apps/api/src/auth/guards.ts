import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@ktrade/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ALLOW_VIEWER_WRITE, type AuthedRequest, IS_PUBLIC, REQUIRE_STEP_UP, ROLES } from './decorators.js';
import { TokenService } from './token.service.js';

const unauthorized = (code = 'UNAUTHENTICATED') => new UnauthorizedException({ message: 'Authentication required', code });

/**
 * Global guard order: Throttler → JwtAuth → Roles → StepUp.
 * JwtAuth verifies the Ed25519 access token AND that its session (refresh family) is still live,
 * so "revoke session" / "destroy all" take effect immediately, not after token expiry.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    let claims;
    try {
      claims = await this.tokens.verifyAccess(header.slice(7));
    } catch {
      throw unauthorized('INVALID_TOKEN');
    }
    const live = await this.prisma.refreshToken.findFirst({
      where: { familyId: claims.sid, userId: claims.sub, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, user: { select: { isActive: true } } },
    });
    if (!live?.user.isActive) throw unauthorized('SESSION_REVOKED');
    req.user = { id: claims.sub, role: claims.role, sessionId: claims.sid };
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = req.user;
    if (!user) throw unauthorized();
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.includes(user.role)) throw new ForbiddenException({ message: 'Insufficient role', code: 'FORBIDDEN' });
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const viewerWrite = this.reflector.getAllAndOverride<boolean>(ALLOW_VIEWER_WRITE, [ctx.getHandler(), ctx.getClass()]);
    if (!isRead && user.role !== 'OWNER' && !viewerWrite) {
      throw new ForbiddenException({ message: 'Read-only role', code: 'FORBIDDEN' });
    }
    return true;
  }
}

@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.reflector.getAllAndOverride<boolean>(REQUIRE_STEP_UP, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = req.headers['x-step-up-token'];
    if (!req.user || typeof token !== 'string' || !(await this.tokens.verifyStepUp(token, req.user.id))) {
      throw new ForbiddenException({ message: 'Fresh second-factor verification required', code: 'STEP_UP_REQUIRED' });
    }
    return true;
  }
}
