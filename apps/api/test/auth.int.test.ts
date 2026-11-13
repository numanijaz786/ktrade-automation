import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARGON2_OPTIONS } from '../src/auth/password-policy.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { base32Decode, hotp, timeStep } from '../src/security/totp.js';

/**
 * Full auth lifecycle against a real PostgreSQL 16 with the real migrations applied.
 * Opt-in (needs Docker): RUN_INTEGRATION=1 pnpm test
 */
describe('auth (integration, real PostgreSQL)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  const OWNER = { email: 'owner@example.com', password: 'correct horse battery staple', displayName: 'Owner' };

  const cookieFrom = (res: request.Response): string => {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    const c = raw?.find((x) => x.startsWith('ktrade_rt='));
    if (!c) throw new Error('no refresh cookie');
    return c.split(';')[0]!;
  };

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', { env: process.env, stdio: 'pipe' });
    // ConfigModule captures env when app.module is imported → import only after DATABASE_URL points at the container.
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/bootstrap.js');
    const { RedisHealth } = await import('../src/redis/redis.module.js');
    const { PrismaService: PrismaServiceClass } = await import('../src/prisma/prisma.service.js');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisHealth)
      .useValue({ ping: async () => true, onModuleInit: () => undefined, onModuleDestroy: async () => undefined })
      // Rate limiting is covered by the stubbed e2e suite; here it would throttle the scenario itself.
      // (overrideGuard cannot reach APP_GUARD-registered guards, so skip via the module options instead.)
      .overrideProvider(getOptionsToken())
      .useValue({ throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }], skipIf: () => true })
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaServiceClass);
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  let accessToken = '';
  let refreshCookie = '';

  it('registers the single owner, then closes registration', async () => {
    const res = await http().post('/api/v1/auth/register').send(OWNER).expect(201);
    expect(res.body.user).toMatchObject({ email: OWNER.email, role: 'OWNER', totpEnabled: false });
    expect(res.body).not.toHaveProperty('refreshToken');
    const setCookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/v1\/auth/);
    accessToken = res.body.accessToken;
    refreshCookie = cookieFrom(res);

    const again = await http().post('/api/v1/auth/register').send({ ...OWNER, email: 'x@example.com' }).expect(403);
    expect(again.body.code).toBe('REGISTRATION_CLOSED');
  });

  it('stores only an Argon2id hash and only refresh-token hashes', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: OWNER.email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    const tokens = await prisma.refreshToken.findMany();
    const raw = refreshCookie.split('=')[1]!;
    expect(tokens.every((t) => t.tokenHash !== raw && /^[0-9a-f]{64}$/.test(t.tokenHash))).toBe(true);
  });

  it('validates input with field-level problem details', async () => {
    const res = await http().post('/api/v1/auth/login').send({ email: 'not-an-email', password: '' }).expect(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('protects routes by default and accepts a valid access token', async () => {
    await http().get('/api/v1/auth/me').expect(401);
    await http().get('/api/v1/auth/me').set('Authorization', 'Bearer not.a.jwt').expect(401);
    const me = await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(me.body.email).toBe(OWNER.email);
  });

  it('does not reveal whether an email exists', async () => {
    const unknown = await http().post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'whatever-long-pw' }).expect(401);
    const wrong = await http().post('/api/v1/auth/login').send({ email: OWNER.email, password: 'wrong-password-123' }).expect(401);
    expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.code).toBe(unknown.body.code);
    expect(wrong.body.detail).toBe(unknown.body.detail);
  });

  it('rotates refresh tokens and revokes the whole session on reuse', async () => {
    const r1 = await http().post('/api/v1/auth/refresh').set('Cookie', refreshCookie).expect(200);
    const rotatedCookie = cookieFrom(r1);
    expect(rotatedCookie).not.toBe(refreshCookie);

    // Replaying the old (already rotated) token = theft signal → family revoked.
    const replay = await http().post('/api/v1/auth/refresh').set('Cookie', refreshCookie).expect(401);
    expect(replay.body.code).toBe('SESSION_REVOKED');
    // …which also kills the legitimate successor and its access token.
    await http().post('/api/v1/auth/refresh').set('Cookie', rotatedCookie).expect(401);
    await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${r1.body.accessToken}`).expect(401);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'auth.refresh_reuse_detected' } });
    expect(audit).not.toBeNull();
  });

  it('logs in again; logout revokes the session immediately', async () => {
    const login = await http().post('/api/v1/auth/login').send({ email: OWNER.email, password: OWNER.password }).expect(200);
    accessToken = login.body.accessToken;
    refreshCookie = cookieFrom(login);
    await http().post('/api/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`).expect(204);
    const after = await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
    expect(after.body.code).toBe('SESSION_REVOKED');
    await http().post('/api/v1/auth/refresh').set('Cookie', refreshCookie).expect(401);
  });

  it('requires a step-up token for sensitive routes', async () => {
    const login = await http().post('/api/v1/auth/login').send({ email: OWNER.email, password: OWNER.password }).expect(200);
    accessToken = login.body.accessToken;
    const auth = { Authorization: `Bearer ${accessToken}` };
    const body = { currentPassword: OWNER.password, newPassword: 'an even longer new passphrase' };

    const denied = await http().put('/api/v1/auth/password').set(auth).send(body).expect(403);
    expect(denied.body.code).toBe('STEP_UP_REQUIRED');
    await http().post('/api/v1/auth/step-up').set(auth).send({ password: 'wrong' }).expect(403);
    const su = await http().post('/api/v1/auth/step-up').set(auth).send({ password: OWNER.password }).expect(200);
    expect(su.body.stepUpToken).toEqual(expect.any(String));
    // A step-up token is not an access token.
    await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${su.body.stepUpToken}`).expect(401);

    await http().put('/api/v1/auth/password').set(auth).set('X-Step-Up-Token', su.body.stepUpToken).send(body).expect(204);
    OWNER.password = body.newPassword;
    // Changing the password revokes every session.
    await http().get('/api/v1/auth/me').set(auth).expect(401);
  });

  it('enrols TOTP (secret encrypted at rest), then requires and validates it at login, rejecting replay', async () => {
    const login = await http().post('/api/v1/auth/login').send({ email: OWNER.email, password: OWNER.password }).expect(200);
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    const setup = await http().post('/api/v1/auth/2fa/setup').set(auth).expect(201);
    const secret: string = setup.body.secret;
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: OWNER.email } });
    expect(Buffer.from(stored.totpPendingEnc!).toString('latin1')).not.toContain(secret);

    const codeAt = (ms: number) => hotp(base32Decode(secret), timeStep(ms));
    await http().post('/api/v1/auth/2fa/enable').set(auth).send({ code: '000000' }).expect(403);
    await http().post('/api/v1/auth/2fa/enable').set(auth).send({ code: codeAt(Date.now()) }).expect(204);

    const noCode = await http().post('/api/v1/auth/login').send({ email: OWNER.email, password: OWNER.password }).expect(401);
    expect(noCode.body.code).toBe('TOTP_REQUIRED');
    // The enrolment code's step is now "used": the next valid code is from a later step.
    const next = codeAt(Date.now() + 30_000);
    await http().post('/api/v1/auth/login').send({ email: OWNER.email, password: OWNER.password, totpCode: next }).expect(200);
    const replay = await http().post('/api/v1/auth/login').send({ email: OWNER.email, password: OWNER.password, totpCode: next }).expect(401);
    expect(replay.body.code).toBe('INVALID_TOTP');
  });

  it('locks the account after 5 failed attempts', async () => {
    const email = 'locktest@example.com';
    await prisma.user.create({ data: { email, passwordHash: await argon2.hash('the-right-password', ARGON2_OPTIONS), displayName: 'L' } });
    for (let i = 0; i < 5; i++) await http().post('/api/v1/auth/login').send({ email, password: 'wrong-password-x' }).expect(401);
    const locked = await http().post('/api/v1/auth/login').send({ email, password: 'the-right-password' }).expect(423);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('VIEWER role is read-only by default', async () => {
    const email = 'viewer@example.com';
    await prisma.user.create({
      data: { email, passwordHash: await argon2.hash('viewer-password-1', ARGON2_OPTIONS), displayName: 'V', role: 'VIEWER' },
    });
    const login = await http().post('/api/v1/auth/login').send({ email, password: 'viewer-password-1' }).expect(200);
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    await http().get('/api/v1/auth/me').set(auth).expect(200);
    const denied = await http().post('/api/v1/auth/2fa/setup').set(auth).expect(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    await http().post('/api/v1/auth/logout').set(auth).expect(204); // explicitly allowed for viewers
  });

  it('writes an audit trail without secrets, and the trail is append-only', async () => {
    const logs = await prisma.auditLog.findMany();
    const actions = new Set(logs.map((l) => l.action));
    for (const a of ['auth.registered', 'auth.login', 'auth.login_failed', 'auth.logout', 'auth.step_up', 'auth.totp_enabled', 'auth.account_locked', 'auth.password_changed']) {
      expect(actions, a).toContain(a);
    }
    const dump = JSON.stringify(logs, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(dump).not.toContain(OWNER.password);
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
  });
});
