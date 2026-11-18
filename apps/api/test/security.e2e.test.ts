import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Real client IP through the trusted proxy only (ADR-032 follow-up), stubbed infra. supertest always connects
 * from loopback, so "trusted BFF" = TRUST_PROXY_ADDRESSES=loopback and "untrusted source" = a list that does not
 * contain loopback. ConfigModule validates env at import time, hence a fresh module graph per configuration.
 */
async function boot(trust: string): Promise<INestApplication> {
  process.env.TRUST_PROXY_ADDRESSES = trust;
  vi.resetModules();
  const [
    { AppModule },
    { configureApp },
    { PrismaService },
    { RedisHealth },
    { Controller, Get, Req },
    { Public, ReqMeta },
  ] = await Promise.all([
    import('../src/app.module.js'),
    import('../src/bootstrap.js'),
    import('../src/prisma/prisma.service.js'),
    import('../src/redis/redis.module.js'),
    import('@nestjs/common'),
    import('../src/auth/decorators.js'),
  ]);

  // Echoes what every IP consumer sees: req.ip (throttler tracker) and the ReqMeta decorator (audit `ip`).
  @Controller('test-ip')
  class IpEchoController {
    @Public()
    @Get()
    echo(@Req() req: { ip?: string }, @ReqMeta() meta: { ip?: string }) {
      return { ip: req.ip, auditIp: meta.ip };
    }
  }

  const { Module } = await import('@nestjs/common');
  @Module({ imports: [AppModule], controllers: [IpEchoController] })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] })
    .overrideProvider(PrismaService)
    .useValue({
      ping: async () => true,
      $disconnect: async () => undefined,
      onModuleDestroy: async () => undefined,
    })
    .overrideProvider(RedisHealth)
    .useValue({ ping: async () => true, onModuleDestroy: async () => undefined })
    .compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app);
  await app.init();
  return app;
}

const login = (app: INestApplication, xff?: string) => {
  const r = request(app.getHttpServer()).post('/api/v1/auth/login').send({});
  return xff ? r.set('X-Forwarded-For', xff) : r;
};

describe('client IP and per-client throttling', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    delete process.env.TRUST_PROXY_ADDRESSES;
  });

  it('from a trusted proxy, req.ip is the forwarded client (right-most untrusted hop)', async () => {
    app = await boot('loopback');
    const echo = (xff: string) =>
      request(app!.getHttpServer()).get('/api/v1/test-ip').set('X-Forwarded-For', xff);
    expect((await echo('203.0.113.7')).body).toEqual({ ip: '203.0.113.7', auditIp: '203.0.113.7' });
    // A client-forged left-most entry is ignored: only the hop the BFF appended counts.
    expect((await echo('6.6.6.6, 203.0.113.7')).body.ip).toBe('203.0.113.7');
  });

  it('from a trusted proxy, login rate limits are per forwarded client IP', async () => {
    app = await boot('loopback');
    for (let i = 0; i < 5; i++) expect((await login(app, '203.0.113.1')).status).toBe(422);
    expect((await login(app, '203.0.113.1')).status).toBe(429);
    // A different client behind the same proxy has its own bucket.
    expect((await login(app, '203.0.113.2')).status).toBe(422);
  });

  it('from an untrusted source, a spoofed X-Forwarded-For is ignored (req.ip = socket address)', async () => {
    app = await boot('172.30.250.10');
    const res = await request(app.getHttpServer())
      .get('/api/v1/test-ip')
      .set('X-Forwarded-For', '203.0.113.7');
    expect(res.body.ip).not.toBe('203.0.113.7');
    expect(res.body.auditIp).toBe(res.body.ip);
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
  });

  it('from an untrusted source, rotating spoofed X-Forwarded-For values cannot escape the rate limit', async () => {
    app = await boot('172.30.250.10');
    for (let i = 0; i < 5; i++) expect((await login(app, `198.51.100.${i}`)).status).toBe(422);
    expect((await login(app, '198.51.100.99')).status).toBe(429);
  });

  it('with an empty trust list nothing is trusted', async () => {
    app = await boot('');
    const res = await request(app.getHttpServer())
      .get('/api/v1/test-ip')
      .set('X-Forwarded-For', '203.0.113.7');
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
  });
});

describe('hardening (ASVS V7/V14)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    delete process.env.TRUST_PROXY_ADDRESSES;
  });

  it('body-parser rejections carry security headers, no X-Powered-By and a terse problem+json', async () => {
    app = await boot('loopback');
    const bad = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{"email":');
    expect(bad.status).toBe(400);
    expect(bad.headers['x-powered-by']).toBeUndefined();
    expect(bad.headers['x-content-type-options']).toBe('nosniff');
    expect(bad.headers['content-type']).toContain('application/problem+json');
    expect(bad.text).not.toMatch(/at \w+ \(|node_modules|stack/i);

    const big = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ a: 'x'.repeat(3 * 1024 * 1024 + 1) }));
    expect(big.status).toBe(413);
    expect(big.headers['x-powered-by']).toBeUndefined();
    expect(big.body).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE', title: 'Payload Too Large' });
  });
});
