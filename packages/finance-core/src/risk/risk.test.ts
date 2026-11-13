import { describe, expect, it } from 'vitest';
import { d } from '../decimal.js';
import {
  canonicalPreviewString,
  evaluateRisk,
  previewHash,
  RISK_RULES,
  type RiskEngineInput,
  type RiskRule,
} from './index.js';

const base = (): RiskEngineInput => ({
  order: {
    side: 'BUY',
    type: 'LIMIT',
    qty: d('100'),
    limitPrice: d('101'),
    refPrice: d('100'),
    estimatedTotal: d('10130'),
  },
  portfolio: {
    cash: d('50000'),
    pendingBuyValue: d('5000'),
    heldQty: d('0'),
    pendingSellQty: d('0'),
    positionValue: d('0'),
    portfolioValue: d('100000'),
    todayTradedValue: d('0'),
    todayOrderCount: 0,
    todayPnlPct: d('0'),
  },
  limits: {
    maxOrderValue: d('20000'),
    maxOrderQty: d('1000'),
    maxDailyTradedValue: d('100000'),
    maxDailyOrders: 10,
    maxPositionPct: d('20'),
    priceBandPct: d('5'),
    maxDailyLossPct: d('3'),
    allowMarketOrders: false,
  },
  flags: {
    mode: 'LIVE',
    killSwitchOn: true,
    capabilityUsable: true,
    marketOpen: true,
    priceIsSimulated: false,
    priceIsStale: false,
  },
});

type Patch = { order?: object; portfolio?: object; limits?: object; flags?: object };
const run = (patch: Patch = {}) => {
  const b = base();
  return evaluateRisk({
    order: { ...b.order, ...patch.order },
    portfolio: { ...b.portfolio, ...patch.portfolio },
    limits: { ...b.limits, ...patch.limits },
    flags: { ...b.flags, ...patch.flags },
  } as RiskEngineInput);
};
const rule = (r: ReturnType<typeof run>, name: RiskRule) => r.results.find((x) => x.rule === name)!;

describe('risk engine', () => {
  it('returns every rule, in order, and passes a clean order', () => {
    const r = run();
    expect(r.results.map((x) => x.rule)).toEqual([...RISK_RULES]);
    expect(r.results).toHaveLength(14);
    expect(r.passed).toBe(true);
    expect(r.failedRules).toEqual([]);
  });

  it.each<[RiskRule, Patch]>([
    ['KILL_SWITCH', { flags: { killSwitchOn: false } }],
    ['CAPABILITY', { flags: { capabilityUsable: false } }],
    ['MARKET_HOURS', { flags: { marketOpen: false } }],
    ['BUYING_POWER', { order: { estimatedTotal: d('45000.01') } }],
    ['HOLDING_QTY', { order: { side: 'SELL' }, portfolio: { heldQty: d('150'), pendingSellQty: d('60') } }],
    ['MAX_ORDER_VALUE', { limits: { maxOrderValue: d('10099.99') } }],
    ['MAX_ORDER_QTY', { limits: { maxOrderQty: d('99') } }],
    ['PRICE_BAND', { order: { limitPrice: d('105.01') } }],
    ['DAILY_VALUE', { portfolio: { todayTradedValue: d('89900.01') } }],
    ['DAILY_COUNT', { portfolio: { todayOrderCount: 10 } }],
    ['CONCENTRATION', { portfolio: { positionValue: d('9900.01') } }],
    ['DAILY_LOSS', { portfolio: { todayPnlPct: d('-3.01') } }],
    ['MARKET_ORDERS_ALLOWED', { order: { type: 'MARKET', limitPrice: null } }],
    ['PRICE_SOURCE', { flags: { priceIsSimulated: true } }],
    ['PRICE_SOURCE', { flags: { priceIsStale: true } }],
  ])('%s fails exactly when its limit is breached', (name, patch) => {
    const r = run(patch);
    expect(r.passed).toBe(false);
    expect(r.failedRules).toEqual([name]);
    expect(rule(r, name).message.length).toBeGreaterThan(0);
  });

  it('boundaries are inclusive', () => {
    expect(run({ order: { estimatedTotal: d('45000') } }).passed).toBe(true);
    expect(run({ order: { limitPrice: d('105') } }).passed).toBe(true); // exactly 5%
    expect(run({ portfolio: { todayPnlPct: d('-3') } }).passed).toBe(true);
    expect(run({ portfolio: { positionValue: d('9900') } }).passed).toBe(true); // exactly 20%
    expect(run({ portfolio: { todayOrderCount: 9 } }).passed).toBe(true);
  });

  it('reports observed and limit values', () => {
    const r = run({ order: { limitPrice: d('110') } });
    expect(rule(r, 'PRICE_BAND')).toMatchObject({ passed: false, observed: '10', limit: '5' });
    expect(rule(r, 'MAX_ORDER_VALUE')).toMatchObject({ observed: '11000', limit: '20000' });
    expect(rule(run(), 'BUYING_POWER')).toMatchObject({ observed: '10130', limit: '45000' });
  });

  it('PAPER: kill switch & capability not applicable; simulated prices allowed', () => {
    const r = run({
      flags: { mode: 'PAPER', killSwitchOn: false, capabilityUsable: false, priceIsSimulated: true },
    });
    expect(r.passed).toBe(true);
    expect(rule(r, 'KILL_SWITCH').message).toBe('not applicable (paper)');
    expect(rule(r, 'CAPABILITY').message).toBe('not applicable (paper)');
    expect(rule(r, 'PRICE_SOURCE').message).toBe('not applicable (paper)');
  });

  it('sells: buying power, concentration and daily loss do not block', () => {
    const r = run({
      order: { side: 'SELL', estimatedTotal: d('999999') },
      portfolio: { heldQty: d('100'), todayPnlPct: d('-50'), positionValue: d('99999'), cash: d('0') },
    });
    expect(r.passed).toBe(true);
    expect(rule(r, 'BUYING_POWER').message).toBe('not applicable (sell)');
  });

  it('unset limits pass with "no limit configured"; market orders priced at ref', () => {
    const r = run({
      order: { type: 'MARKET', limitPrice: null },
      limits: {
        maxOrderValue: null,
        maxOrderQty: undefined,
        maxDailyTradedValue: null,
        maxDailyOrders: null,
        maxPositionPct: null,
        priceBandPct: null,
        maxDailyLossPct: null,
        allowMarketOrders: true,
      },
    });
    expect(r.passed).toBe(true);
    expect(rule(r, 'MAX_ORDER_VALUE')).toMatchObject({ observed: '10000', message: 'no limit configured' });
    expect(rule(r, 'PRICE_BAND').passed).toBe(true);
  });

  it('fails closed on zero reference price / zero portfolio value', () => {
    expect(run({ order: { refPrice: d('0') } }).failedRules).toEqual(['PRICE_BAND']);
    expect(run({ portfolio: { portfolioValue: d('0') } }).failedRules).toEqual(['CONCENTRATION']);
  });

  it('rejects malformed orders', () => {
    expect(() => run({ order: { qty: d('1.5') } })).toThrow(RangeError);
    expect(() => run({ order: { qty: d('0') } })).toThrow(RangeError);
    expect(() => run({ order: { limitPrice: null } })).toThrow(RangeError);
    expect(() => run({ order: { type: 'STOP_LIMIT' } })).toThrow(RangeError);
  });
});

describe('previewHash', () => {
  const f = {
    symbol: 'OGDC',
    side: 'BUY',
    type: 'LIMIT',
    qty: '100',
    limitPrice: '101.50',
    stopPrice: null,
    portfolioId: 'p1',
    mode: 'LIVE',
  } as const;
  it('is deterministic, hex sha256, and normalizes decimals', () => {
    const h = previewHash(f);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(previewHash({ ...f, limitPrice: d('101.5'), qty: d('100.00') })).toBe(h);
    expect(canonicalPreviewString(f)).toBe(
      '["ktrade-preview-v1",["symbol","OGDC"],["side","BUY"],["type","LIMIT"],["qty","100"],["limitPrice","101.5"],["stopPrice",null],["portfolioId","p1"],["mode","LIVE"]]',
    );
  });
  it('changes when any bound field changes', () => {
    const h = previewHash(f);
    const variants = [
      { symbol: 'PPL' },
      { side: 'SELL' },
      { type: 'MARKET' },
      { qty: '101' },
      { limitPrice: '101.51' },
      { stopPrice: '99' },
      { portfolioId: 'p2' },
      { mode: 'PAPER' },
    ];
    const hashes = variants.map((v) => previewHash({ ...f, ...v } as typeof f));
    hashes.forEach((x) => expect(x).not.toBe(h));
    expect(new Set(hashes).size).toBe(variants.length);
  });
});
