import { describe, expect, it } from 'vitest';
import { d } from '../decimal.js';
import { annualEps, type FundamentalsContext } from './fundamentals.js';
import {
  earningsFairValue,
  gordonGrowth,
  marginOfSafetyPct,
  peerMedianMultiples,
  relativeToPeers,
  simpleDcf,
  summariseValuation,
  type PeerInput,
  type ReportedFact,
} from './valuation.js';
import { statement } from './fixtures.js';

const ctx: FundamentalsContext = { asOf: '2025-06-01T00:00:00.000Z', maxAgeDays: 200 };
const fact = (name: string, v: string, currency = 'PKR'): ReportedFact => ({
  name,
  value: d(v),
  period: 'FY2024',
  currency,
  source: 'USER_REPORTED',
});
const peer = (symbol: string, pe: string | null, pb: string | null = null): PeerInput => ({
  symbol,
  pe: pe === null ? null : d(pe),
  pb: pb === null ? null : d(pb),
  asOf: '2025-05-30',
  source: 'USER_REPORTED',
});

describe('peer comparison', () => {
  it('refuses with fewer than 3 peers', () => {
    const r = peerMedianMultiples([peer('A', '8'), peer('B', '10')]);
    expect(r.pe.status).toBe('UNAVAILABLE');
    if (r.pe.status === 'UNAVAILABLE') expect(r.pe.reason).toContain('needs >= 3 peers');
  });
  it('ignores non-positive or missing multiples when counting', () => {
    const r = peerMedianMultiples([peer('A', '8'), peer('B', '10'), peer('C', '-3'), peer('D', null)]);
    expect(r.pe.status).toBe('UNAVAILABLE');
  });
  it('median of odd and even sets (hand-computed)', () => {
    const odd = peerMedianMultiples([peer('A', '8', '1'), peer('B', '12', '2'), peer('C', '10', '3')]);
    expect(odd.pe.status === 'OK' && odd.pe.median.toString()).toBe('10');
    expect(odd.pb.status === 'OK' && odd.pb.median.toString()).toBe('2');
    const even = peerMedianMultiples([peer('A', '8'), peer('B', '12'), peer('C', '10'), peer('D', '20')]);
    expect(even.pe.status === 'OK' && even.pe.median.toString()).toBe('11'); // (10+12)/2
    expect(even.pb.status).toBe('UNAVAILABLE');
  });
  it('premium / discount vs the median', () => {
    const m = peerMedianMultiples([peer('A', '8'), peer('B', '12'), peer('C', '10')]).pe;
    if (m.status !== 'OK') throw new Error('x');
    expect(relativeToPeers(d('12'), m).toString()).toBe('20');
  });
});

describe('earnings-based fair value', () => {
  it('EPS x justified P/E; facts and assumptions are separated', () => {
    const r = earningsFairValue({
      annualEps: annualEps(statement(), ctx),
      justifiedPe: { value: d('10'), basis: 'median P/E of 3 supplied peers' },
      priceCurrency: 'PKR',
    });
    if (r.status !== 'OK') throw new Error(r.reason);
    expect(r.fairValue.toString()).toBe('120');
    expect(r.facts.map((f) => f.name)).toEqual(['annualEps']);
    expect(r.assumptions).toEqual([
      { name: 'justifiedPe', value: '10.00', basis: 'median P/E of 3 supplied peers' },
    ]);
  });
  it('lists the annualisation assumption for a quarterly EPS', () => {
    const q = statement({
      period: '2025-Q1',
      periodType: 'QUARTERLY',
      periodEnd: '2025-03-31',
      publishedAt: '2025-04-20T00:00:00.000Z',
      eps: d('3'),
    });
    const r = earningsFairValue({
      annualEps: annualEps(q, { ...ctx, annualiseQuarterly: true }),
      justifiedPe: { value: d('10'), basis: 'x' },
      priceCurrency: 'PKR',
    });
    if (r.status !== 'OK') throw new Error(r.reason);
    expect(r.fairValue.toString()).toBe('120');
    expect(r.assumptions.some((a) => a.name === 'epsAnnualisation')).toBe(true);
  });
  it('refuses without a justified multiple, with unavailable EPS, with a currency mismatch', () => {
    expect(
      earningsFairValue({ annualEps: annualEps(statement(), ctx), justifiedPe: null, priceCurrency: 'PKR' })
        .status,
    ).toBe('UNAVAILABLE');
    expect(
      earningsFairValue({
        annualEps: annualEps(statement({ eps: null }), ctx),
        justifiedPe: { value: d('10'), basis: 'x' },
        priceCurrency: 'PKR',
      }),
    ).toMatchObject({ status: 'UNAVAILABLE', missing: ['eps'] });
    expect(
      earningsFairValue({
        annualEps: annualEps(statement(), ctx),
        justifiedPe: { value: d('10'), basis: 'x' },
        priceCurrency: 'USD',
      }),
    ).toMatchObject({ status: 'UNAVAILABLE' });
    expect(
      earningsFairValue({
        annualEps: annualEps(statement({ eps: d('-2') }), ctx),
        justifiedPe: { value: d('10'), basis: 'x' },
        priceCurrency: 'PKR',
      }),
    ).toMatchObject({ status: 'UNAVAILABLE' });
  });
});

describe('Gordon growth (DDM)', () => {
  it('V = D0(1+g)/(r-g): 10 x 1.05 / 0.10 = 105', () => {
    const r = gordonGrowth({
      lastAnnualDps: fact('dps', '10'),
      growthPct: d('5'),
      requiredReturnPct: d('15'),
      growthBasis: 'owner input',
    });
    if (r.status !== 'OK') throw new Error(r.reason);
    expect(r.fairValue.toString()).toBe('105');
    expect(r.assumptions.map((a) => a.name)).toEqual(['dividendGrowthPct', 'requiredReturnPct']);
  });
  it('requires g < r', () => {
    for (const [g, rr] of [
      ['15', '15'],
      ['16', '15'],
    ] as const) {
      const r = gordonGrowth({ lastAnnualDps: fact('dps', '10'), growthPct: d(g), requiredReturnPct: d(rr) });
      expect(r).toMatchObject({ status: 'UNAVAILABLE' });
      if (r.status === 'UNAVAILABLE') expect(r.reason).toContain('g < r');
    }
  });
  it('refuses on missing or non-positive inputs', () => {
    expect(gordonGrowth({ lastAnnualDps: null, growthPct: d('5'), requiredReturnPct: null })).toMatchObject({
      status: 'UNAVAILABLE',
      missing: ['lastAnnualDps', 'requiredReturnPct'],
    });
    expect(
      gordonGrowth({ lastAnnualDps: fact('dps', '0'), growthPct: d('5'), requiredReturnPct: d('15') }).status,
    ).toBe('UNAVAILABLE');
  });
});

describe('simple DCF', () => {
  const base = {
    baseFcf: fact('freeCashFlow', '100'),
    growthPct: d('0'),
    years: 2,
    terminalGrowthPct: d('0'),
    discountRatePct: d('10'),
    netDebt: fact('netDebt', '0'),
    sharesOutstanding: fact('shares', '10'),
  };
  it('zero growth perpetuity: EV = FCF / r = 1000, so 100 per share', () => {
    const r = simpleDcf(base);
    if (r.status !== 'OK') throw new Error(r.reason);
    expect(r.fairValue.toDecimalPlaces(20).toString()).toBe('100');
    expect(r.assumptions.map((a) => a.name)).toEqual([
      'fcfGrowthPct',
      'explicitYears',
      'terminalGrowthPct',
      'discountRatePct',
    ]);
    expect(r.facts).toHaveLength(3);
  });
  it('net debt reduces equity value (hand-computed)', () => {
    const r = simpleDcf({ ...base, netDebt: fact('netDebt', '200') });
    if (r.status !== 'OK') throw new Error(r.reason);
    expect(r.fairValue.toDecimalPlaces(20).toString()).toBe('80'); // (1000-200)/10
  });
  it('growth case (hand-computed): FCF0 100, g 10%, 1 year, gT 0, r 10%', () => {
    // FCF1 = 110, PV1 = 100; TV = 110 / 0.10 = 1100, PV = 1000; EV = 1100; /10 = 110
    const r = simpleDcf({ ...base, growthPct: d('10'), years: 1 });
    if (r.status !== 'OK') throw new Error(r.reason);
    expect(r.fairValue.toDecimalPlaces(20).toString()).toBe('110');
  });
  it('refuses unless every assumption is explicit', () => {
    expect(simpleDcf({ ...base, netDebt: null, years: undefined })).toMatchObject({
      status: 'UNAVAILABLE',
      missing: ['years', 'netDebt'],
    });
  });
  it('refuses r <= terminal growth, non-positive FCF, currency mismatch, absurd horizon', () => {
    expect(simpleDcf({ ...base, terminalGrowthPct: d('10') })).toMatchObject({ status: 'UNAVAILABLE' });
    expect(simpleDcf({ ...base, baseFcf: fact('freeCashFlow', '-5') })).toMatchObject({
      status: 'UNAVAILABLE',
    });
    expect(simpleDcf({ ...base, netDebt: fact('netDebt', '0', 'USD') })).toMatchObject({
      status: 'UNAVAILABLE',
    });
    expect(simpleDcf({ ...base, years: 60 })).toMatchObject({ status: 'UNAVAILABLE' });
  });
});

describe('margin of safety and summary', () => {
  it('(fair - price) / fair', () => {
    expect(marginOfSafetyPct(d('120'), d('90'))?.toString()).toBe('25');
    expect(marginOfSafetyPct(d('100'), d('125'))?.toString()).toBe('-25');
    expect(marginOfSafetyPct(d('0'), d('1'))).toBeNull();
  });
  it('uses the lowest fair value, lists deduplicated assumptions and every refused method', () => {
    const eps = earningsFairValue({
      annualEps: annualEps(statement(), ctx),
      justifiedPe: { value: d('10'), basis: 'peers' },
      priceCurrency: 'PKR',
    });
    const ddm = gordonGrowth({
      lastAnnualDps: fact('dps', '10'),
      growthPct: d('5'),
      requiredReturnPct: d('15'),
    });
    const dcf = simpleDcf({
      baseFcf: null,
      growthPct: null,
      years: null,
      terminalGrowthPct: null,
      discountRatePct: null,
      netDebt: null,
      sharesOutstanding: null,
    });
    const s = summariseValuation(d('90'), 'PKR', [eps, ddm, dcf]);
    expect(s.status).toBe('OK');
    expect(s.fairValueLow?.toString()).toBe('105');
    expect(s.fairValueHigh?.toString()).toBe('120');
    expect(s.marginOfSafetyPct?.toDecimalPlaces(4).toString()).toBe('14.2857'); // (105 - 90) / 105
    expect(s.explanation.some((e) => e.startsWith('DCF unavailable'))).toBe(true);
    expect(s.assumptions.map((a) => a.name)).toEqual([
      'justifiedPe',
      'dividendGrowthPct',
      'requiredReturnPct',
    ]);
    expect(s.reportedFacts.map((f) => f.name)).toEqual(['annualEps', 'dps']);
  });
  it('unavailable when no method is OK', () => {
    const s = summariseValuation(d('90'), 'PKR', [
      gordonGrowth({ lastAnnualDps: null, growthPct: null, requiredReturnPct: null }),
    ]);
    expect(s.status).toBe('UNAVAILABLE');
    expect(s.marginOfSafetyPct).toBeNull();
    expect(s.explanation[0]).toContain('DDM unavailable');
  });
});
