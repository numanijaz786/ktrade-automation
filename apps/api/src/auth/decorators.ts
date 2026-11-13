import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '@ktrade/shared';

export const IS_PUBLIC = 'auth:isPublic';
export const ROLES = 'auth:roles';
export const ALLOW_VIEWER_WRITE = 'auth:allowViewerWrite';
export const REQUIRE_STEP_UP = 'auth:requireStepUp';

/** Route needs no authentication (login, refresh, health…). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Restrict to roles. Without it: any authenticated user may READ; writes need OWNER (default-deny). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
/** Opt-in for the rare non-GET route a VIEWER may call (e.g. logout, mark notification read). */
export const AllowViewerWrite = () => SetMetadata(ALLOW_VIEWER_WRITE, true);
/** Requires a fresh second factor via the `X-Step-Up-Token` header (docs/07 §1 🔐). */
export const RequireStepUp = () => SetMetadata(REQUIRE_STEP_UP, true);

export interface AuthUser {
  id: string;
  role: Role;
  sessionId: string;
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export type AuthedRequest = Request & { user?: AuthUser; id?: string };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new Error('CurrentUser used on an unauthenticated route');
  return user;
});

export const ReqMeta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return { ip: req.ip, userAgent: req.headers['user-agent'], requestId: req.id ? String(req.id) : undefined };
});
