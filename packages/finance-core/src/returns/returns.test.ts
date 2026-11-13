import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { d } from '../decimal.js';
import { aggregateMonthlyPnl, dailyPerformance, maxDrawdown, timeWeightedReturn, twrIndex } from './performance.js';
import {
  accountValue,
  dailyPnl,
  holdingValuation,
  liquidationValue,
  marketValue,
  portfolioWeights,
  simpleReturn,
  unrealizedPnl,
} from './valuation.js';
import { xirr, XirrError, xnpv } from './xirr.js';

describe('valuation', () => {
  it('holding valuation on the wac-basic end state (99 sh, cost 23179.698) at 260', () => {
    const v = holdingValuation({ quantity: '99', totalCost: '23179.698', lastPrice: '260' });
    expect(v.marketValue.toFixed(4)).toBe('25740.0000');
    expect(v.unrealizedPnl.toFixed(4)).toBe('2560.3020');
    expect(v.unrealizedReturn?.toFixed(6)).toBe('0.110455');
  });
  it('unrealized return is null at zero cost (e.g. a pure bonus lot)', () => {
    expect(holdingValuation({ quantity: '10', totalCost: '0', lastPrice: '5' }).unrealizedReturn).toBeNull();
  });
  it('market value, P&L, liquidation and account value helpers', () => {
    expect(marketValue('3', '0.333333').toFixed(4)).toBe('1.0000');
    expect(unrealizedPnl('100', '120').toString()).toBe('-20');
    expect(liquidationValue('1000', '3.45').toString()).toBe('996.55');
    expect(accountValue('500', ['100', '250.5']).toString()).toBe('850.5');
    expect(dailyPnl('10500', '10000', '400').toString()).toBe('100');
  });
  it('weights sum to 1 and are null when the portfolio is empty', () => {
    const w = portfolioWeights([
      { key: 'OGDC', marketValue: '300' },
      { key: 'HBL', marketValue: '100' },
    ]);
    expect(w.map((x) => x.weight?.toString())).toEqual(['0.75', '0.25']);
    expect(portfolioWeights([{ key: 'X', marketValue: '0' }])[0]?.weight).toBeNull();
  });
  it('simple return; null when contributions ≤ 0', () => {
    expect(simpleReturn('11000', '10000')?.toString()).toBe('0.1');
    expect(simpleReturn('500', '0')).toBeNull();
    expect(simpleReturn('500', '-100')).toBeNull();
  });
});

describe('daily performance & TWR', () => {
  const pts = [
    { date: '2025-01-01', value: '0' },
    { date: '2025-01-02', value: '10000', netFlow: '10000' }, // deposit at end of day: no exposure yet
    { date: '2025-01-03', value: '11000' }, // +10%
    { date: '2025-01-06', value: '16500', netFlow: '5000' }, // +5% then deposit 5000
    { date: '2025-02-03', value: '14850', netFlow: '-1650' }, // 0% then withdraw
  ];

  it('daily P&L and returns with flows at end of day', () => {
    const days = dailyPerformance(pts);
    expect(days.map((x) => x.pnl.toString())).toEqual(['0', '1000', '500', '0']);
    expect(days.map((x) => x.dailyReturn?.toFixed(10) ?? null)).toEqual([null, '0.1000000000', '0.0454545455', '0.0000000000']);
  });

  it('TWR links daily returns and is unaffected by flow timing', () => {
    // 1.1 × (11500/11000) × 1 − 1 = 0.15
    expect(timeWeightedReturn(pts)?.toFixed(10)).toBe('0.1500000000');
    const idx = twrIndex(pts);
    expect(idx?.[0]?.index.toString()).toBe('1');
    expect(idx).toHaveLength(5);
  });

  it('TWR is null when undefined (too short, or gain on zero capital)', () => {
    expect(timeWeightedReturn([{ date: '2025-01-01', value: '1' }])).toBeNull();
    expect(timeWeightedReturn([{ date: '2025-01-01', value: '0' }, { date: '2025-01-02', value: '5' }])).toBeNull();
  });

  it('rejects unordered dates', () => {
    expect(() => dailyPerformance([{ date: '2025-01-02', value: '1' }, { date: '2025-01-02', value: '1' }])).toThrow(RangeError);
  });

  it('property: with no flows, TWR = V_end / V_start − 1', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 10_000_000 }), { minLength: 2, maxLength: 30 }), (vals) => {
        const series = vals.map((v, i) => ({ date: `2025-01-${String(i + 1).padStart(2, '0')}`, value: v.toString() }));
        const twr = timeWeightedReturn(series)!;
        const expected = d(vals[vals.length - 1]!.toString()).div(vals[0]!.toString()).minus(1);
        // r_t near −100% carries ~1e-34 absolute error, amplified by 1/(1+r_t) ≤ 1e7 per step
        expect(twr.minus(expected).abs().lte(expected.abs().plus(1).times('1e-24'))).toBe(true);
      }),
    );
  });

  it('monthly P&L aggregates daily P&L', () => {
    const months = aggregateMonthlyPnl(dailyPerformance(pts));
    expect(months.map((m) => [m.month, m.pnl.toString(), m.days])).toEqual([
      ['2025-01', '1500', 3],
      ['2025-02', '0', 1],
    ]);
  });
});

describe('maxDrawdown', () => {
  it('finds peak, trough and recovery', () => {
    const r = maxDrawdown([
      { date: '2025-01-01', value: '100' },
      { date: '2025-01-02', value: '120' },
      { date: '2025-01-03', value: '90' },
      { date: '2025-01-04', value: '110' },
      { date: '2025-01-05', value: '121' },
    ]);
    expect(r?.maxDrawdown.toString()).toBe('0.25');
    expect(r?.peakDate).toBe('2025-01-02');
    expect(r?.troughDate).toBe('2025-01-03');
    expect(r?.recoveryDate).toBe('2025-01-05');
  });
  it('0 for a rising series; null for empty / non-positive series', () => {
    expect(maxDrawdown([{ date: '2025-01-01', value: '1' }, { date: '2025-01-02', value: '2' }])?.maxDrawdown.isZero()).toBe(true);
    expect(maxDrawdown([])).toBeNull();
    expect(maxDrawdown([{ date: '2025-01-01', value: '0' }])).toBeNull();
  });
  it('unrecovered drawdown has null recoveryDate', () => {
    const r = maxDrawdown([
      { date: '2025-01-01', value: '100' },
      { date: '2025-01-02', value: '50' },
      { date: '2025-01-03', value: '99' },
    ]);
    expect(r?.maxDrawdown.toString()).toBe('0.5');
    expect(r?.recoveryDate).toBeNull();
  });
});

describe('xirr', () => {
  it('one year, +10%', () => {
    const r = xirr([
      { date: '2024-01-01', amount: '-1000' },
      { date: '2024-12-31', amount: '1100' }, // 365 days (2024 is a leap year)
    ]);
    expect(r.toFixed(10)).toBe('0.1000000000');
  });

  it('matches the spreadsheet XIRR reference example (≈ 0.373362535)', () => {
    const flows = [
      { date: '2008-01-01', amount: '-10000' },
      { date: '2008-03-01', amount: '2750' },
      { date: '2008-10-30', amount: '4250' },
      { date: '2009-02-15', amount: '3250' },
      { date: '2009-04-01', amount: '2750' },
    ];
    const r = xirr(flows);
    // Spreadsheets stop at ~1e-8 and print 0.373362535; the exact root is 0.37336253…
    expect(r.toFixed(6)).toBe('0.373363');
    expect(xnpv(r, flows).abs().lt('1e-12')).toBe(true);
  });

  it('handles losses and unordered input', () => {
    const r = xirr([
      { date: '2025-07-01', amount: '800' },
      { date: '2025-01-01', amount: '-1000' },
    ]);
    expect(r.lt(0)).toBe(true);
    expect(xnpv(r, [{ date: '2025-01-01', amount: '-1000' }, { date: '2025-07-01', amount: '800' }]).abs().lt('1e-6')).toBe(true);
  });

  it('falls back to bisection when Newton cannot start (guess ≤ −1)', () => {
    const r = xirr(
      [
        { date: '2024-01-01', amount: '-1000' },
        { date: '2024-12-31', amount: '1100' },
      ],
      { guess: '-5' },
    );
    expect(r.toFixed(9)).toBe('0.100000000');
  });

  it('a −99.9% loss over one day converges; annualised (1+r = 1e-1095) it rounds to exactly −1', () => {
    const r = xirr([
      { date: '2024-01-01', amount: '-1000' },
      { date: '2024-01-02', amount: '1' },
    ]);
    expect(r.eq(-1)).toBe(true);
  });

  it('extreme loss (−99%) converges', () => {
    const r = xirr([
      { date: '2024-01-01', amount: '-1000' },
      { date: '2024-12-31', amount: '10' },
    ]);
    expect(r.toFixed(6)).toBe('-0.990000');
  });

  it('throws typed errors on invalid cash flows', () => {
    expect(() => xirr([{ date: '2025-01-01', amount: '-1' }])).toThrow(XirrError);
    expect(() =>
      xirr([
        { date: '2025-01-01', amount: '-1' },
        { date: '2025-02-01', amount: '-2' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CASHFLOWS' }));
  });

  it('property: solved rate reproduces the growth of a deposit followed by a payoff (incl. extreme losses)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 10_000_000 }),
        fc.integer({ min: 1, max: 3000 }), // payoff as ‰ of deposit: −99.9% … +200%
        fc.integer({ min: 1, max: 2000 }),
        (dep, permille, days) => {
          // keep 1 + r representable at 34 significant digits (else r rounds to −1, tested above)
          fc.pre(Math.pow(permille / 1000, 365 / days) > 1e-25);
          const payoff = d(dep.toString()).times(permille).div(1000);
          const end = new Date(Date.UTC(2020, 0, 1) + days * 86_400_000).toISOString().slice(0, 10);
          const flows = [
            { date: '2020-01-01', amount: `-${dep}` },
            { date: end, amount: payoff },
          ];
          const r = xirr(flows);
          expect(r.gt(-1)).toBe(true);
          // the root satisfies (1 + r)^(days/365) = payoff / deposit
          const growth = d('1').plus(r).pow(d(days.toString()).div(365));
          expect(growth.minus(payoff.div(dep)).abs().lte(payoff.div(dep).times('1e-10'))).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});
