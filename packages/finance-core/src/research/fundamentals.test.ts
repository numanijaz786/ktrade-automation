import { describe, expect, it } from 'vitest';
import { d } from '../decimal.js';
import {
  annualEps,
  computeFundamentalRatios,
  debtToEquity,
  dividendYield,
  epsGrowthYoY,
  freeCashFlow,
  grossMargin,
  netMargin,
  operatingMargin,
  payoutRatio,
  pbRatio,
  peRatio,
  type PriceInput,
  RATIO_KEYS,
  ratioValue,
  revenueGrowthQoQ,
  revenueGrowthYoY,
  roa,
  roe,
  type FundamentalsContext,
  type RatioResult,
} from './fundamentals.js';
import { prior, statement } from './fixtures.js';

const ctx: FundamentalsContext = { asOf: '2025-06-01T00:00:00.000Z', maxAgeDays: 200 };
const price: PriceInput = {
  value: d('120'),
  currency: 'PKR',
  source: 'PROVIDER',
  asOf: '2025-05-30T00:00:00.000Z',
};

const ok = (r: RatioResult): string => {
  if (r.status !== 'OK') throw new Error(`expected OK, got UNAVAILABLE: ${r.reason}`);
  return r.value.toString();
};
const refused = (r: RatioResult): { missing: readonly string[]; reason: string } => {
  if (r.status !== 'UNAVAILABLE') throw new Error('expected UNAVAILABLE');
  return r;
};

describe('fundamental ratios (hand-computed, synthetic inputs)', () => {
  const s = statement();
  it('margins', () => {
    expect(ok(grossMargin(s, ctx))).toBe('40');
    expect(ok(operatingMargin(s, ctx))).toBe('20');
    expect(ok(netMargin(s, ctx))).toBe('12');
  });
  it('growth YoY and EPS growth', () => {
    expect(ok(revenueGrowthYoY(s, prior(), ctx))).toBe('25');
    expect(ok(epsGrowthYoY(s, prior(), ctx))).toBe('20');
  });
  it('valuation ratios', () => {
    expect(ok(peRatio(s, price, ctx))).toBe('10'); // 120 / 12
    expect(ok(pbRatio(s, price, ctx))).toBe('1.5'); // 120 / (800 / 10)
  });
  it('returns, leverage, cash flow, payout', () => {
    expect(ok(roe(s, ctx))).toBe('15'); // 120 / 800
    expect(ok(roa(s, ctx))).toBe('6'); // 120 / 2000
    expect(ok(debtToEquity(s, ctx))).toBe('0.5');
    expect(ok(freeCashFlow(s, ctx))).toBe('120'); // 180 - 60
    expect(ok(payoutRatio(s, ctx))).toBe('50'); // 6 / 12
  });
  it('dividend yield from trailing-12-month history', () => {
    const hist = [
      {
        exDate: '2025-03-01T00:00:00.000Z',
        amountPerShare: d('4'),
        currency: 'PKR',
        source: 'USER_REPORTED' as const,
      },
      {
        exDate: '2024-09-01T00:00:00.000Z',
        amountPerShare: d('2'),
        currency: 'PKR',
        source: 'USER_REPORTED' as const,
      },
      {
        exDate: '2023-01-01T00:00:00.000Z',
        amountPerShare: d('50'),
        currency: 'PKR',
        source: 'USER_REPORTED' as const,
      }, // outside window
    ];
    expect(ok(dividendYield(hist, price, ctx))).toBe('5'); // (4+2)/120
  });
  it('every OK ratio cites its inputs with provenance', () => {
    const r = peRatio(s, price, ctx);
    if (r.status !== 'OK') throw new Error('x');
    expect(r.inputs.map((i) => i.name)).toEqual(['price', 'eps']);
    expect(r.inputs.every((i) => i.currency === 'PKR' && i.source && i.publishedAt)).toBe(true);
    expect(r.formula).toBe('price / annual EPS');
  });
});

describe('refusals: never estimate', () => {
  it('missing input names are reported', () => {
    const r = refused(grossMargin(statement({ grossProfit: null }), ctx));
    expect(r.missing).toEqual(['grossProfit']);
    const m = refused(debtToEquity(statement({ totalDebt: undefined, totalEquity: null }), ctx));
    expect(m.missing).toEqual(['totalDebt', 'totalEquity']);
    expect(refused(peRatio(statement(), null, ctx)).missing).toEqual(['price']);
    expect(refused(revenueGrowthYoY(statement(), null, ctx)).missing).toEqual(['comparison statement']);
    expect(refused(revenueGrowthYoY(statement({ revenue: null }), prior(), ctx)).missing).toEqual([
      'revenue@FY2024',
    ]);
  });
  it('zero or non-positive denominators', () => {
    expect(refused(netMargin(statement({ revenue: d('0') }), ctx)).reason).toContain('revenue is zero');
    expect(refused(roe(statement({ totalEquity: d('0') }), ctx)).reason).toContain('not positive');
    expect(refused(pbRatio(statement({ sharesOutstanding: d('0') }), price, ctx)).reason).toContain(
      'shares outstanding',
    );
    expect(refused(revenueGrowthYoY(statement(), prior({ revenue: d('0') }), ctx)).reason).toContain(
      'must be > 0',
    );
    expect(refused(peRatio(statement({ eps: d('-1') }), price, ctx)).reason).toContain('not meaningful');
    expect(refused(payoutRatio(statement({ eps: d('0') }), ctx)).reason).toContain('payout');
  });
  it('incompatible currencies', () => {
    expect(refused(peRatio(statement(), { ...price, currency: 'USD' }, ctx)).reason).toContain(
      'incompatible currencies',
    );
    expect(refused(revenueGrowthYoY(statement(), prior({ currency: 'USD' }), ctx)).reason).toContain(
      'incompatible currencies',
    );
    const hist = [
      { exDate: '2025-03-01', amountPerShare: d('4'), currency: 'USD', source: 'USER_REPORTED' as const },
    ];
    expect(refused(dividendYield(hist, price, ctx)).reason).toContain('currency');
  });
  it('incompatible or non-adjacent periods', () => {
    expect(refused(revenueGrowthYoY(statement(), prior({ periodType: 'QUARTERLY' }), ctx)).reason).toContain(
      'period types',
    );
    expect(refused(revenueGrowthYoY(statement(), prior({ periodEnd: '2023-06-30' }), ctx)).reason).toContain(
      '18 months apart',
    );
    expect(refused(revenueGrowthQoQ(statement(), prior(), ctx)).reason).toContain('12 months apart');
  });
  it('QoQ works for adjacent quarters', () => {
    const q2 = statement({
      period: '2025-Q1',
      periodType: 'QUARTERLY',
      periodEnd: '2025-03-31',
      publishedAt: '2025-04-20T00:00:00.000Z',
      revenue: d('330'),
    });
    const q1 = statement({
      period: '2024-Q4',
      periodType: 'QUARTERLY',
      periodEnd: '2024-12-31',
      publishedAt: '2025-01-20T00:00:00.000Z',
      revenue: d('300'),
    });
    expect(ok(revenueGrowthQoQ(q2, q1, ctx))).toBe('10');
  });
  it('stale statements and statements published after the decision date', () => {
    expect(refused(netMargin(statement(), { ...ctx, asOf: '2026-06-01T00:00:00.000Z' })).reason).toContain(
      'stale',
    );
    expect(refused(netMargin(statement(), { ...ctx, asOf: '2025-01-01T00:00:00.000Z' })).reason).toContain(
      'after the decision date',
    );
    expect(refused(netMargin(statement(), { ...ctx, maxAgeDays: 100 })).reason).toContain(
      'stale, published 106 days ago (limit 100)',
    );
  });
  it('stale price', () => {
    expect(
      refused(peRatio(statement(), { ...price, asOf: '2025-04-01T00:00:00.000Z' }, ctx)).reason,
    ).toContain('price is 61 days old');
  });
  it('dividend history missing vs empty', () => {
    expect(refused(dividendYield(null, price, ctx)).missing).toEqual(['dividend history']);
    const r = dividendYield([], price, ctx);
    expect(ok(r)).toBe('0');
    if (r.status === 'OK') expect(r.flags).toContain('NO_DIVIDENDS_IN_SUPPLIED_HISTORY');
  });
});

describe('quarterly annualisation is explicit and flagged', () => {
  const q = statement({
    period: '2025-Q1',
    periodType: 'QUARTERLY',
    periodEnd: '2025-03-31',
    publishedAt: '2025-04-20T00:00:00.000Z',
    eps: d('3'),
    netIncome: d('30'),
  });
  it('is refused unless enabled', () => {
    expect(refused(peRatio(q, price, ctx)).reason).toContain('annualiseQuarterly was not enabled');
    expect(refused(roe(q, ctx)).reason).toContain('quarterly');
  });
  it('multiplies by 4 and carries the flag when enabled', () => {
    const c2 = { ...ctx, annualiseQuarterly: true };
    const pe = peRatio(q, price, c2);
    expect(ok(pe)).toBe('10'); // 120 / (3 x 4)
    if (pe.status === 'OK') expect(pe.flags[0]).toContain('ANNUALISED_FROM_QUARTERLY');
    const r = roe(q, c2);
    expect(ok(r)).toBe('15'); // 30 x 4 / 800
    if (r.status === 'OK') expect(r.flags[0]).toContain('x4');
    const e = annualEps(q, c2);
    expect(ok(e)).toBe('12');
  });
  it('annual and TTM statements are never multiplied', () => {
    expect(ok(annualEps(statement({ periodType: 'TTM' }), ctx))).toBe('12');
  });
});

describe('aggregate report', () => {
  it('reports coverage, available and unavailable ratios with missing names', () => {
    const rep = computeFundamentalRatios(
      { current: statement({ operatingCashFlow: null }), priorYear: prior(), price, dividendHistory: null },
      ctx,
    );
    expect(rep.available).toContain('pe');
    expect(rep.available).not.toContain('freeCashFlow');
    const fcf = rep.unavailable.find((u) => u.key === 'freeCashFlow');
    expect(fcf?.missing).toEqual(['operatingCashFlow']);
    expect(rep.unavailable.find((u) => u.key === 'dividendYield')?.missing).toEqual(['dividend history']);
    expect(rep.unavailable.find((u) => u.key === 'revenueGrowthQoQ')?.missing).toEqual([
      'comparison statement',
    ]);
    expect(rep.available.length + rep.unavailable.length).toBe(RATIO_KEYS.length);
    expect(rep.coverage.toString()).toBe(d(String(rep.available.length)).div(RATIO_KEYS.length).toString());
    expect(ratioValue(rep, 'pe')?.toString()).toBe('10');
    expect(ratioValue(rep, 'freeCashFlow')).toBeNull();
  });
});
