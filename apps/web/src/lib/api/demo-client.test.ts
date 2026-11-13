import { describe, expect, it } from 'vitest';
import { Dec } from '../decimal';
import { estimateFees } from '../fees';
import { DemoApiClient, LIVE_PORTFOLIO_ID, PAPER_PORTFOLIO_ID } from './demo-client';
import { ApiError } from './errors';

const NOW = Date.parse('2026-11-13T07:15:00Z');

function client(now = () => NOW) {
  return new DemoApiClient({ latencyMs: 0, tickMs: 0, now });
}

describe('fee estimate maths', () => {
  it('matches the docs/07 preview example (HUBC 100 @ 150.00)', () => {
    const e = estimateFees('BUY', '100', '150.00');
    expect(e.notional).toBe('15000.0000');
    expect(e.fees.map((f) => [f.component, f.amount])).toEqual([
      ['COMMISSION', '45.00'],
      ['SST_ON_COMMISSION', '6.75'],
      ['CDC_CHARGES', '0.00'],
    ]);
    expect(e.total).toBe('15051.7500');
    expect(e.fees.every((f) => f.source === 'ESTIMATED')).toBe(true);
    expect(e.fees[2].note).toMatch(/at actual/i);
  });

  it('uses the Rs 0.06/share floor for low-priced shares', () => {
    // 10,000 KEL @ 4.50 → 0.3% = 135.00; 0.06 × 10,000 = 600.00 → commission 600.00
    const e = estimateFees('BUY', '10000', '4.50');
    expect(e.fees[0].amount).toBe('600.00');
    expect(e.fees[1].amount).toBe('90.00');
    expect(e.totalFees).toBe('690.00');
  });

  it('nets fees off proceeds for sells and rounds to paisa without float artifacts', () => {
    // 33 @ 101.17 = 3338.61; 0.3% = 10.01583 → 10.02; SST 1.503 → 1.50
    const e = estimateFees('SELL', '33', '101.17');
    expect(e.notional).toBe('3338.6100');
    expect(e.fees[0].amount).toBe('10.02');
    expect(e.fees[1].amount).toBe('1.50');
    expect(e.total).toBe('3327.0900');
  });

  it('DemoApiClient.orders.feeEstimate returns the same breakdown', async () => {
    const c = client();
    const e = await c.orders.feeEstimate({ symbol: 'HUBC', side: 'BUY', quantity: '100', price: '150.00' });
    expect(e.total).toBe('15051.7500');
  });
});

describe('DemoApiClient data', () => {
  it('labels market data SIMULATED and keeps every money field a decimal string', async () => {
    const c = client();
    const [q] = await c.market.quotes(['OGDC']);
    expect(q.source).toBe('SIMULATED');
    expect(q.last).toMatch(/^\d+\.\d{2}$/);
    const holdings = await c.portfolios.holdings(LIVE_PORTFOLIO_ID);
    expect(holdings.length).toBeGreaterThan(5);
    for (const h of holdings) {
      expect(typeof h.marketValue).toBe('string');
      expect(h.marketValue).toMatch(/^-?\d+\.\d{2}$/);
    }
    const weights = Dec.sum(holdings.map((h) => h.weight));
    expect(weights.round(3).toString()).toBe('1');
  });

  it('shows the intentional non-simulated demo provenance items', async () => {
    const c = client();
    const holdings = await c.portfolios.holdings(LIVE_PORTFOLIO_ID);
    expect(holdings.find((h) => h.symbol === 'MARI')?.source).toBe('BROKER_CONFIRMED');
    const txns = await c.portfolios.transactions(LIVE_PORTFOLIO_ID);
    expect(txns.some((t) => t.source === 'USER_REPORTED')).toBe(true);
    const summary = await c.dashboard.summary(LIVE_PORTFOLIO_ID);
    expect(summary.cash.broker?.source).toBe('BROKER_CONFIRMED');
    expect(summary.feesPaid.source).toBe('ESTIMATED');
    expect(Dec.of(summary.cash.ledger.value).gt(0)).toBe(true);
  });

  it('is deterministic across instances', async () => {
    const a = await client().market.candles('LUCK');
    const b = await client().market.candles('LUCK');
    expect(a.candles.slice(0, 50)).toEqual(b.candles.slice(0, 50));
  });

  it('ticks the simulated quote stream to subscribers', async () => {
    const c = client();
    await c.market.quotes();
    const seen: string[] = [];
    const unsub = c.market.subscribeQuotes(['OGDC', 'PPL', 'HUBC', 'LUCK', 'MCB', 'UBL', 'SYS', 'TRG'], (t) =>
      seen.push(t.symbol),
    );
    for (let i = 0; i < 5; i++) c.tickOnce();
    unsub();
    expect(seen.length).toBeGreaterThan(0);
  });
});

/** Live trading is OFF by default (same as the real API); enabling it requires step-up. */
async function enableLiveTrading(c: ReturnType<typeof client>) {
  const { token } = await c.auth.stepUp('123456');
  await c.system.setKillSwitch({ liveTradingEnabled: true, reason: 'test', stepUpToken: token });
}

describe('order preview → approval → manual ticket → fill', () => {
  it('rejects live previews while the kill switch is OFF (the default)', async () => {
    const c = client();
    expect((await c.system.killSwitch()).liveTradingEnabled).toBe(false);
    const order = await c.orders.preview({
      portfolioId: LIVE_PORTFOLIO_ID,
      symbol: 'HUBC',
      side: 'BUY',
      type: 'MARKET',
      quantity: '10',
      origin: 'MANUAL',
    });
    expect(order.status).toBe('REJECTED_BY_RISK');
    expect(order.riskChecks.find((r) => r.rule === 'KILL_SWITCH')?.passed).toBe(false);
  });

  it('previews with risk checks, approves with step-up and never fills without a recorded fill', async () => {
    const c = client();
    await enableLiveTrading(c);
    const order = await c.orders.preview({
      portfolioId: LIVE_PORTFOLIO_ID,
      symbol: 'HUBC',
      side: 'BUY',
      type: 'MARKET',
      quantity: '10',
      origin: 'MANUAL',
    });
    expect(order.status).toBe('PREVIEWED');
    expect(order.executionPath).toBe('MANUAL_TICKET');
    expect(order.riskChecks).toHaveLength(12);
    expect(order.riskChecks.every((r) => r.passed)).toBe(true);
    expect(order.warnings[0]).toMatch(/manual/i);
    expect(order.previewExpiresAt).toBe('2026-11-13T07:20:00.000Z');

    await expect(
      c.orders.approve(order.id, { previewHash: order.previewHash, stepUpToken: 'nope' }),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(c.auth.stepUp('000000')).rejects.toBeInstanceOf(ApiError);
    const { token } = await c.auth.stepUp('123456');
    await expect(
      c.orders.approve(order.id, { previewHash: 'sha256:wrong', stepUpToken: token }),
    ).rejects.toMatchObject({ code: 'PREVIEW_MISMATCH' });

    const approved = await c.orders.approve(order.id, { previewHash: order.previewHash, stepUpToken: token });
    expect(approved.status).toBe('AWAITING_MANUAL_PLACEMENT');
    expect(approved.filledQuantity).toBe('0');
    expect(approved.executions).toHaveLength(0);

    const placed = await c.orders.markPlaced(order.id, { brokerOrderRef: 'KT-1' });
    expect(placed.status).toBe('PLACED_BY_USER');
    expect(placed.executions).toHaveLength(0);

    await expect(
      c.orders.recordFill(order.id, { quantity: '11', price: '150.00', executedAt: '2026-11-13T07:30:00Z' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const partial = await c.orders.recordFill(order.id, {
      quantity: '4',
      price: '150.00',
      executedAt: '2026-11-13T07:30:00Z',
    });
    expect(partial.status).toBe('PARTIALLY_FILLED');
    const filled = await c.orders.recordFill(order.id, {
      quantity: '6',
      price: '151.00',
      executedAt: '2026-11-13T07:31:00Z',
    });
    expect(filled.status).toBe('FILLED');
    expect(filled.avgFillPrice).toBe('150.6000');
    expect(filled.executions.every((e) => e.source === 'USER_REPORTED')).toBe(true);
  });

  it('rejects by risk when a limit is breached', async () => {
    const c = client();
    const o = await c.orders.preview({
      portfolioId: LIVE_PORTFOLIO_ID,
      symbol: 'KEL',
      side: 'BUY',
      type: 'MARKET',
      quantity: '50000',
      origin: 'MANUAL',
    });
    expect(o.status).toBe('REJECTED_BY_RISK');
    expect(o.riskChecks.find((r) => r.rule === 'MAX_ORDER_QTY')?.passed).toBe(false);
  });

  it('expires previews after 5 minutes', async () => {
    let now = NOW;
    const c = client(() => now);
    await enableLiveTrading(c);
    const o = await c.orders.preview({
      portfolioId: LIVE_PORTFOLIO_ID,
      symbol: 'OGDC',
      side: 'BUY',
      type: 'MARKET',
      quantity: '5',
      origin: 'MANUAL',
    });
    now += 6 * 60 * 1000;
    const { token } = await c.auth.stepUp('123456');
    await expect(
      c.orders.approve(o.id, { previewHash: o.previewHash, stepUpToken: token }),
    ).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });
  });

  it('auto-fills paper orders with a SIMULATED execution', async () => {
    const c = client();
    const o = await c.orders.preview({
      portfolioId: PAPER_PORTFOLIO_ID,
      symbol: 'UBL',
      side: 'BUY',
      type: 'MARKET',
      quantity: '10',
      origin: 'MANUAL',
    });
    const { token } = await c.auth.stepUp('654321');
    const done = await c.orders.approve(o.id, { previewHash: o.previewHash, stepUpToken: token });
    expect(done.status).toBe('FILLED');
    expect(done.executions[0].source).toBe('SIMULATED');
  });
});

describe('backtests', () => {
  it('returns metrics, curve and the mandatory disclaimer', async () => {
    const c = client();
    const bt = await c.backtests.run({
      strategyType: 'MA_CROSSOVER',
      parameters: { fastPeriod: 9, slowPeriod: 21, maType: 'EMA' },
      symbol: 'OGDC',
      interval: 'D1',
      from: '2025-01-01',
      to: '2026-11-13',
      initialCapital: '1000000.00',
      slippageBps: 10,
    });
    expect(bt.status).toBe('SUCCEEDED');
    expect(bt.metrics?.totalReturnPct).toMatch(/^-?\d+\.\d{2}$/);
    expect(bt.equityCurve.length).toBeGreaterThan(100);
    expect(bt.disclaimer).toContain('Past simulated performance does not guarantee future returns');
    expect(bt.source).toBe('SIMULATED');
  });
});

describe('statement import (demo mirrors the real pipeline rules)', () => {
  const CSV = [
    'date,symbol,side,quantity,price,commission',
    '2026-11-02,OGDC,BUY,"1,000",250.00,750.00',
    '2026-11-03,NOPE,BUY,5,10,',
    '2026-11-04,HUBC,SELL,10,150.25,',
  ].join('\n');

  it('stages rows, flags invalid ones, blocks commit until skipped, then commits; rejects the same file twice', async () => {
    const c = client();
    await expect(
      c.broker.upload({ portfolioId: 'pf-paper', fileName: 'x.csv', content: CSV }),
    ).rejects.toMatchObject({ code: 'IMPORT_REQUIRES_LIVE_PORTFOLIO' });

    const batch = await c.broker.upload({
      portfolioId: LIVE_PORTFOLIO_ID,
      fileName: 'trades.csv',
      content: CSV,
    });
    expect(batch).toMatchObject({
      status: 'AWAITING_REVIEW',
      source: 'USER_REPORTED',
      rowCounts: { VALID: 2, INVALID: 1 },
    });
    const rows = await c.broker.importRows(batch.id);
    expect(rows.map((r) => [r.status, r.feeSource])).toEqual([
      ['VALID', 'FILE'],
      ['INVALID', 'ESTIMATED_ON_COMMIT'],
      ['VALID', 'ESTIMATED_ON_COMMIT'],
    ]);
    expect(rows[0]!.quantity).toBe('1000');
    expect(rows[1]!.errors.join()).toMatch(/unknown symbol NOPE/);

    await expect(c.broker.commitImport(batch.id)).rejects.toMatchObject({ code: 'IMPORT_HAS_INVALID_ROWS' });
    await expect(c.broker.updateImportRow(batch.id, rows[1]!.id, 'include')).rejects.toMatchObject({
      code: 'ROW_NOT_INCLUDABLE',
    });
    await c.broker.updateImportRow(batch.id, rows[1]!.id, 'skip');
    const done = await c.broker.commitImport(batch.id);
    expect(done).toMatchObject({ status: 'COMMITTED', rowCounts: { COMMITTED: 2, SKIPPED: 1 } });

    await expect(
      c.broker.upload({ portfolioId: LIVE_PORTFOLIO_ID, fileName: 'copy.csv', content: CSV }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_IMPORT' });
    const overlap = await c.broker.upload({
      portfolioId: LIVE_PORTFOLIO_ID,
      fileName: 'next.csv',
      content: CSV.split('\n').slice(0, 2).join('\n') + '\n',
    });
    expect(overlap.rowCounts).toEqual({ DUPLICATE: 1 });
  });
});
