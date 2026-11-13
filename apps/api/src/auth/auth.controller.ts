import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  type AuthTokensResponse,
  changePasswordSchema,
  type ChangePasswordInput,
  loginSchema,
  type LoginInput,
  registerSchema,
  type RegisterInput,
  totpCodeSchema,
  totpConfirmSchema,
  type TotpConfirmInput,
} from '@ktrade/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { AppConfig } from '../config/config.module.js';
import { AuthService, type IssuedSession } from './auth.service.js';
import {
  AllowViewerWrite,
  type AuthUser,
  CurrentUser,
  Public,
  ReqMeta,
  type RequestMeta,
  RequireStepUp,
} from './decorators.js';

export const REFRESH_COOKIE = 'ktrade_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
const AUTH_LIMIT = { default: { limit: 5, ttl: 60_000 } };

const stepUpSchema = z
  .object({ totpCode: totpCodeSchema.optional(), password: z.string().min(1).max(128).optional() })
  .refine((v) => v.totpCode || v.password, 'totpCode or password is required');

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Throttle(AUTH_LIMIT)
  @Post('register')
  @ApiOperation({ summary: 'Create the single OWNER account (closed once an owner exists)' })
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokensResponse> {
    return this.respond(res, await this.auth.register(body, meta));
  }

  @Public()
  @Throttle(AUTH_LIMIT)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Password (+ TOTP when enabled) login; sets the httpOnly refresh cookie' })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokensResponse> {
    return this.respond(res, await this.auth.login(body, meta));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token (reuse revokes the whole session)' })
  async refresh(
    @Req() req: Request,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokensResponse> {
    try {
      return this.respond(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE] as string | undefined, meta));
    } catch (err) {
      this.clearCookie(res);
      throw err;
    }
  }

  @AllowViewerWrite()
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(user.sessionId, user.id, meta);
    this.clearCookie(res);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<AuthTokensResponse['user']> {
    return this.auth.me(user.id);
  }

  @AllowViewerWrite()
  @ApiBearerAuth()
  @Throttle(AUTH_LIMIT)
  @Post('step-up')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Prove a fresh second factor; returns a short-lived X-Step-Up-Token' })
  stepUp(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(stepUpSchema)) body: z.infer<typeof stepUpSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ stepUpToken: string; expiresIn: number }> {
    return this.auth.stepUp(user.id, body, meta);
  }

  @ApiBearerAuth()
  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user.id, user.sessionId);
  }

  @AllowViewerWrite()
  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeSession(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @ReqMeta() meta: RequestMeta) {
    return this.auth.revokeSession(user.id, id, meta);
  }

  @AllowViewerWrite()
  @ApiBearerAuth()
  @Delete('sessions')
  @HttpCode(HttpStatus.OK)
  async revokeAll(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const revoked = await this.auth.revokeAllSessions(user.id, meta);
    this.clearCookie(res);
    return { revoked };
  }

  @ApiBearerAuth()
  @Post('2fa/setup')
  @ApiOperation({ summary: 'Begin TOTP enrolment: returns the secret/otpauth URI once' })
  setupTotp(@CurrentUser() user: AuthUser) {
    return this.auth.beginTotpEnrolment(user.id);
  }

  @ApiBearerAuth()
  @Post('2fa/enable')
  @HttpCode(HttpStatus.NO_CONTENT)
  enableTotp(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(totpConfirmSchema)) body: TotpConfirmInput, @ReqMeta() meta: RequestMeta) {
    return this.auth.confirmTotpEnrolment(user.id, body.code, meta);
  }

  @ApiBearerAuth()
  @RequireStepUp()
  @Post('2fa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  disableTotp(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.auth.disableTotp(user.id, meta);
  }

  @ApiBearerAuth()
  @RequireStepUp()
  @Put('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.changePassword(user.id, body.currentPassword, body.newPassword, meta);
    this.clearCookie(res);
  }

  // ── cookie handling: refresh token only ever travels in an httpOnly, SameSite=Strict, path-scoped cookie ──

  private respond(res: Response, s: IssuedSession): AuthTokensResponse {
    res.cookie(REFRESH_COOKIE, s.refreshToken, {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: s.refreshExpiresAt,
    });
    res.setHeader('Cache-Control', 'no-store');
    return { accessToken: s.accessToken, expiresIn: s.expiresIn, user: s.user };
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH, httpOnly: true, sameSite: 'strict', secure: this.config.get('COOKIE_SECURE') });
  }
}
