import { describe, expect, it } from 'vitest';
import { parsePrefill } from '@/app/(app)/trade/order-ticket';
import { DemoApiClient } from './demo-client';

describe('demo advisor', () => {
  const demo = () => new DemoApiClient({ latencyMs: 0, tickMs: 0 });

  it('gives the same honest "not enough verified data" answer, with no levels', async () => {
    const c = demo();
    const pfs = await c.portfolios.list();
    const r = await c.advisor.dailyReport({ portfolioId: pfs[0]!.id, horizon: 'SWING' });
    expect(r.headline).toBe('Not enough verified data to recommend anything');
    expect(r.notEnoughData?.reasons[0]?.reason).toMatch(/simulated data/);
    expect(r.topBuys).toEqual([]);
    expect(r.opportunities).toEqual([]);
    expect(r.avoidOrSell).toEqual([]);
    for (const h of r.holdingsAdvice) {
      expect(h.advice).toBeNull();
      expect(h.stop).toBeNull();
      expect(h.targets).toEqual([]);
      expect(h.price?.source).toBe('SIMULATED');
      expect(h.price?.verified).toBe(false);
    }
  });

  it('scanner is empty and the stock report has no recommendation or technicals', async () => {
    const c = demo();
    expect((await c.advisor.scanner({ filter: 'breakout', horizon: 'SWING' })).results).toEqual([]);
    const s = await c.advisor.stock('OGDC');
    expect(s.recommendations).toEqual({});
    expect(s.technicals).toBeNull();
    expect(s.ratios).toBeNull();
  });

  it('validates the risk setting like the API (0 < r <= 5)', async () => {
    const c = demo();
    await expect(c.advisor.updateSettings('0')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(c.advisor.updateSettings('5.01')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await c.advisor.updateSettings('2')).riskPerTradePct).toBe('2');
    expect((await c.advisor.settings()).isDefault).toBe(false);
  });
});

describe('trade prefill', () => {
  it('accepts valid advisor params and ignores invalid ones', () => {
    const p = (q: string) => parsePrefill(new URLSearchParams(q));
    expect(p('symbol=ogdc&side=BUY&qty=200&type=LIMIT&limit=101.5')).toEqual({
      symbol: 'OGDC',
      side: 'BUY',
      quantity: '200',
      limitPrice: '101.5',
    });
    expect(p('symbol=<script>&side=HACK&qty=-1&type=LIMIT&limit=abc')).toEqual({});
    expect(p('qty=0')).toEqual({});
  });
});
