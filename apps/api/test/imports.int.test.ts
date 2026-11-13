import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Statement import pipeline on real PostgreSQL: upload → review → atomic commit through LedgerService.
 * Opt-in: RUN_INTEGRATION=1 (needs Docker).
 */
describe('imports (integration, real PostgreSQL)', () => {
  let pg: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: Record<string, string>;
  let liveId: string;
  let paperId: string;
  const http = () => request(app.getHttpServer());

  /** docs/06 §3 worked example as a user-made CSV (no charges → fees ESTIMATED by the fee engine). */
  const WORKED_EXAMPLE = [
    'date,symbol,side,quantity,price',
    '2026-11-02,OGDC,BUY,100,250.00',
    '2026-11-03,OGDC,BUY,50,270.00',
    '2026-11-04,OGDC,SELL,60,280.00',
    '05/11/2026,HUBC,BUY,"1,000",150.25',
  ].join('\n');

  const upload = (fileName: string, content: string, portfolioId = liveId) =>
    http().post('/api/v1/imports').set(auth).send({ portfolioId, fileName, content });
  const rowsOf = async (id: string) =>
    (await http().get(`/api/v1/imports/${id}/rows`).set(auth).expect(200)).body as {
      id: string;
      rowNo: number;
      status: string;
      symbol: string;
      errors: string[];
      warnings: string[];
      feeSource: string;
      duplicateOf: { kind: string } | null;
    }[];
  const holding = async (symbol: string) => {
    const stock = await prisma.stock.findUniqueOrThrow({ where: { symbol } });
    return prisma.holding.findUnique({
      where: { portfolioId_stockId: { portfolioId: liveId, stockId: stock.id } },
    });
  };

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = pg.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', { env: process.env, stdio: 'pipe' });
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/bootstrap.js');
    const { RedisHealth } = await import('../src/redis/redis.module.js');
    const { PrismaService: PS } = await import('../src/prisma/prisma.service.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisHealth)
      .useValue({
        ping: async () => true,
        onModuleInit: () => undefined,
        onModuleDestroy: async () => undefined,
      })
      .overrideProvider(getOptionsToken())
      .useValue({ throttlers: [{ name: 'default', ttl: 60_000, limit: 1000 }], skipIf: () => true })
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PS);

    const reg = await http()
      .post('/api/v1/auth/register')
      .send({ email: 'o@example.com', password: 'a long owner passphrase', displayName: 'O' })
      .expect(201);
    auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    await prisma.stock.createMany({
      data: [
        { symbol: 'OGDC', name: 'Oil & Gas Development Company' },
        { symbol: 'HUBC', name: 'Hub Power Company' },
      ],
    });

    const acct = await http()
      .post('/api/v1/broker/accounts')
      .set(auth)
      .send({ displayName: 'My KTrade', clientCodeLast4: '1234' })
      .expect(201);
    expect(acct.body.clientCodeMasked).toBe('****1234');
    expect(
      acct.body.connections.find((c: { adapter: string }) => c.adapter === 'KTRADE_BROWSER').status,
    ).toBe('PENDING_AUTHORIZATION');
    liveId = acct.body.portfolios[0].id;
    paperId = (
      await http()
        .post('/api/v1/portfolios')
        .set(auth)
        .send({ name: 'Paper', initialCash: '100000' })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  let firstImportId = '';

  it('stages a valid CSV for review without touching the ledger', async () => {
    const res = await upload('trades-nov.csv', WORKED_EXAMPLE).expect(201);
    firstImportId = res.body.id;
    expect(res.body).toMatchObject({
      status: 'AWAITING_REVIEW',
      kind: 'GENERIC_TRANSACTIONS_CSV',
      source: 'USER_REPORTED',
      periodFrom: '2026-11-02',
      periodTo: '2026-11-05',
    });
    expect(res.body.rowCounts).toEqual({ VALID: 4 });
    const rows = await rowsOf(firstImportId);
    expect(rows.map((r) => r.feeSource)).toEqual(Array(4).fill('ESTIMATED_ON_COMMIT'));
    expect(rows[0]!.warnings[0]).toMatch(/ESTIMATED/);
    expect(await prisma.transaction.count()).toBe(0);
  });

  it('commits atomically through the ledger and reproduces the docs/06 worked example exactly', async () => {
    const res = await http().post(`/api/v1/imports/${firstImportId}/commit`).set(auth).expect(200);
    expect(res.body.status).toBe('COMMITTED');
    expect(res.body.rowCounts).toEqual({ COMMITTED: 4 });

    const ogdc = await holding('OGDC');
    expect(ogdc!.quantity.toString()).toBe('90');
    expect(ogdc!.totalCost.toFixed(4)).toBe('23179.6980');
    expect(ogdc!.avgCost.toFixed(6)).toBe('257.552200');
    expect(ogdc!.realizedPnl.toFixed(4)).toBe('1288.9080');
    expect((await holding('HUBC'))!.quantity.toString()).toBe('1000');

    const txs = await prisma.transaction.findMany({
      where: { portfolioId: liveId },
      include: { fees: true },
    });
    expect(txs).toHaveLength(4);
    expect(txs.every((t) => t.source === 'USER_REPORTED' && t.importedStmtId === firstImportId)).toBe(true);
    expect(txs.flatMap((t) => t.fees).every((f) => f.source === 'ESTIMATED')).toBe(true); // clearly labelled estimates
    expect(
      await prisma.cashMovement.count({ where: { portfolioId: liveId, transactionId: { not: null } } }),
    ).toBe(4);
  });

  it('rejects the exact same file again (sha256), pointing at the original import', async () => {
    const res = await upload('renamed-copy.csv', WORKED_EXAMPLE).expect(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'DUPLICATE_IMPORT', existingImportId: firstImportId });
  });

  it('flags trades already imported or already in the ledger as DUPLICATE; review can skip or include them', async () => {
    // A manually recorded trade that a statement later also contains.
    const hubc = await prisma.stock.findUniqueOrThrow({ where: { symbol: 'HUBC' } });
    await prisma.transaction.create({
      data: {
        portfolioId: liveId,
        stockId: hubc.id,
        type: 'BUY',
        tradeDate: new Date('2026-11-10T00:00:00Z'),
        quantity: '10',
        price: '151',
        grossAmount: '1510',
        netAmount: '-1510',
        source: 'USER_REPORTED',
      },
    });
    const csv = [
      'date,symbol,side,quantity,price,commission,sst,contract_no',
      '2026-11-02,OGDC,BUY,100,250.00,,,', // already imported earlier
      '2026-11-10,HUBC,BUY,10,151,,,', // already in the ledger (manual entry)
      '2026-11-12,HUBC,SELL,200,160.00,96.00,14.40,CN-77', // new, with broker-stated charges
    ].join('\n');
    const res = await upload('trades-update.csv', csv).expect(201);
    expect(res.body.rowCounts).toEqual({ DUPLICATE: 2, VALID: 1 });
    const rows = await rowsOf(res.body.id);
    expect(rows[0]!.duplicateOf!.kind).toBe('IMPORT_ROW');
    expect(rows[1]!.duplicateOf!.kind).toBe('TRANSACTION');
    expect(rows[2]!.feeSource).toBe('FILE');

    // Override: include the first duplicate, then change our mind and skip it again.
    await http()
      .patch(`/api/v1/imports/${res.body.id}/rows/${rows[0]!.id}`)
      .set(auth)
      .send({ action: 'include' })
      .expect(200);
    const skipped = await http()
      .patch(`/api/v1/imports/${res.body.id}/rows/${rows[0]!.id}`)
      .set(auth)
      .send({ action: 'skip' })
      .expect(200);
    expect(skipped.body.status).toBe('SKIPPED');

    await http().post(`/api/v1/imports/${res.body.id}/commit`).set(auth).expect(200);
    const sell = await prisma.transaction.findFirstOrThrow({
      where: { portfolioId: liveId, externalRef: 'CN-77' },
      include: { fees: true },
    });
    expect(sell.fees.map((f) => [f.component, f.amount.toFixed(2), f.source]).sort()).toEqual([
      ['COMMISSION', '96.00', 'USER_REPORTED'], // stated in the file: not estimated
      ['SST_ON_COMMISSION', '14.40', 'USER_REPORTED'],
    ]);
    expect(sell.netAmount.toFixed(4)).toBe('31889.6000'); // 200 × 160 − 96 − 14.40
    expect((await holding('HUBC'))!.quantity.toString()).toBe('810'); // 1000 + 10 − 200
  });

  it('marks invalid rows, blocks commit until they are skipped, and never lets them be included', async () => {
    const csv = [
      'date,symbol,side,quantity,price',
      '2026-11-13,NOPE,BUY,5,10',
      '31/02/2026,OGDC,BUY,5,10',
      '2026-11-13,OGDC,BUY,5,255.50',
    ].join('\n');
    const res = await upload('mixed.csv', csv).expect(201);
    expect(res.body.rowCounts).toEqual({ INVALID: 2, VALID: 1 });
    const rows = await rowsOf(res.body.id);
    expect(rows[0]!.errors.join()).toMatch(/unknown symbol NOPE/);
    expect(rows[1]!.errors.join()).toMatch(/invalid date/);

    const blocked = await http().post(`/api/v1/imports/${res.body.id}/commit`).set(auth).expect(409);
    expect(blocked.body.code).toBe('IMPORT_HAS_INVALID_ROWS');
    const notIncludable = await http()
      .patch(`/api/v1/imports/${res.body.id}/rows/${rows[0]!.id}`)
      .set(auth)
      .send({ action: 'include' })
      .expect(409);
    expect(notIncludable.body.code).toBe('ROW_NOT_INCLUDABLE');

    for (const r of rows.slice(0, 2))
      await http()
        .patch(`/api/v1/imports/${res.body.id}/rows/${r.id}`)
        .set(auth)
        .send({ action: 'skip' })
        .expect(200);
    await http().post(`/api/v1/imports/${res.body.id}/commit`).set(auth).expect(200);
    expect((await holding('OGDC'))!.quantity.toString()).toBe('95');
  });

  it('rolls back the WHOLE import when any row fails in the ledger (oversell), naming the row', async () => {
    const before = {
      txs: await prisma.transaction.count(),
      cash: await prisma.cashMovement.count(),
      ogdc: (await holding('OGDC'))!.quantity.toString(),
      hubc: (await holding('HUBC'))!.quantity.toString(),
    };
    const csv = [
      'date,symbol,side,quantity,price',
      '2026-11-13,HUBC,BUY,10,150',
      '2026-11-13,OGDC,SELL,500,260',
    ].join('\n'); // holds 95 OGDC
    const res = await upload('oversell.csv', csv).expect(201);
    const fail = await http().post(`/api/v1/imports/${res.body.id}/commit`).set(auth).expect(409);
    expect(fail.body).toMatchObject({ code: 'IMPORT_OVERSELL', rowNo: 3 });
    expect(fail.body.detail).toMatch(/rolled back/);

    expect(await prisma.transaction.count()).toBe(before.txs); // the valid HUBC row was NOT posted either
    expect(await prisma.cashMovement.count()).toBe(before.cash);
    expect((await holding('OGDC'))!.quantity.toString()).toBe(before.ogdc);
    expect((await holding('HUBC'))!.quantity.toString()).toBe(before.hubc);
    const after = await http().get(`/api/v1/imports/${res.body.id}`).set(auth).expect(200);
    expect(after.body).toMatchObject({ status: 'AWAITING_REVIEW', rowCounts: { VALID: 2 } }); // fixable: user can skip/reject

    await http().post(`/api/v1/imports/${res.body.id}/reject`).set(auth).expect(200);
    const again = await http().post(`/api/v1/imports/${res.body.id}/commit`).set(auth).expect(409);
    expect(again.body.code).toBe('INVALID_IMPORT_STATE');
  });

  it('validates uploads: live portfolio only, recognisable format, size cap, parse errors', async () => {
    expect((await upload('a.csv', WORKED_EXAMPLE + '\n', paperId).expect(422)).body.code).toBe(
      'IMPORT_REQUIRES_LIVE_PORTFOLIO',
    );
    expect((await upload('notes.txt', 'hello').expect(422)).body.code).toBe('UNSUPPORTED_FILE');
    expect(
      (await upload('ragged.csv', 'date,symbol,side,quantity,price\n2026-11-01,OGDC,BUY\n').expect(422)).body
        .code,
    ).toBe('PARSE_FAILED');
    expect((await upload('empty.csv', 'date,symbol,side,quantity,price\n').expect(422)).body.code).toBe(
      'EMPTY_FILE',
    );
    const huge = 'date,symbol,side,quantity,price\n' + '2026-11-01,OGDC,BUY,1,1\n'.repeat(110_000); // > 2 MB, < 3 MB body limit
    expect((await upload('huge.csv', huge).expect(422)).body.code).toBe('VALIDATION_FAILED');
  });

  it('audits every step', async () => {
    const actions = new Set(
      (await prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action),
    );
    for (const a of [
      'integration.account_registered',
      'import.uploaded',
      'import.row_include',
      'import.row_skip',
      'import.committed',
      'import.rejected',
    ]) {
      expect(actions, a).toContain(a);
    }
  });
});
