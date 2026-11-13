import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisHealth } from '../src/redis/redis.module.js';

/** HTTP pipeline tests with infrastructure stubbed (no Docker needed). Real-DB tests live in *.int.test.ts. */
describe('API pipeline (e2e, stubbed infra)', () => {
  let app: INestApplication;
  const deps = { db: true, redis: true };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        ping: async () => deps.db,
        $disconnect: async () => undefined,
        onModuleDestroy: async () => undefined,
      })
      .overrideProvider(RedisHealth)
      .useValue({ ping: async () => deps.redis, onModuleDestroy: async () => undefined })
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health is live without dependencies', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /ready reports 503 when a dependency is down, without leaking details', async () => {
    deps.redis = false;
    const res = await request(app.getHttpServer()).get('/ready').expect(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { database: true, redis: false } });
    deps.redis = true;
    await request(app.getHttpServer()).get('/ready').expect(200);
  });

  it('unknown routes return RFC 9457 problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND', instance: '/api/v1/does-not-exist' });
  });

  it('sets security headers (helmet)', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('serves the OpenAPI document', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(res.body.info.title).toBe('KTrade Smart Trading Platform API');
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining(['/health', '/ready']));
  });

  it('rate-limits login attempts (5/min) before any auth work happens', async () => {
    const attempt = () => request(app.getHttpServer()).post('/api/v1/auth/login').send({});
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(422); // throttle passes, validation rejects
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects unauthenticated access to protected routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('echoes a well-formed inbound request id and rejects malformed ones', async () => {
    const ok = await request(app.getHttpServer()).get('/health').set('x-request-id', 'abc12345-req');
    expect(ok.headers['x-request-id']).toBe('abc12345-req');
    const bad = await request(app.getHttpServer()).get('/health').set('x-request-id', '<script>');
    expect(bad.headers['x-request-id']).not.toBe('<script>');
  });
});
