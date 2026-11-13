import { describe, expect, it } from 'vitest';
import { d } from '../decimal.js';
import {
  computeDividendEntitlement,
  isTradeEligibleForBookClosure,
  latestEligibleTradeDate,
  settledQuantityBefore,
  settlementDateFor,
} from './dividends.js';

describe('computeDividendEntitlement', () => {
  it('gross, WHT, zakat, net with paisa rounding', () => {
    const r = computeDividendEntitlement({
      sharesEligible: '99',
      dividendPerShare: '2.75',
      whtRate: '0.15',
      zakatAmount: '1.005',
    });
    expect(r.gross.toFixed(2)).toBe('272.25');
    expect(r.wht.toFixed(2)).toBe('40.84'); // 40.8375 → 40.84
    expect(r.zakat.toFixed(2)).toBe('1.01');
    expect(r.net.toFixed(2)).toBe('230.40');
  });
  it('zero shares → all zero', () => {
    const r = computeDividendEntitlement({ sharesEligible: '0', dividendPerShare: '5', whtRate: '0.25' });
    expect(r.net.isZero()).toBe(true);
  });
  it('rejects invalid inputs', () => {
    expect(() =>
      computeDividendEntitlement({ sharesEligible: '-1', dividendPerShare: '1', whtRate: '0.1' }),
    ).toThrow(RangeError);
    expect(() =>
      computeDividendEntitlement({ sharesEligible: '1', dividendPerShare: '1', whtRate: '1.5' }),
    ).toThrow(RangeError);
    expect(() =>
      computeDividendEntitlement({
        sharesEligible: '10',
        dividendPerShare: '1',
        whtRate: '0.5',
        zakatAmount: '6',
      }),
    ).toThrow(RangeError);
  });
});

// Mon 2025-03-03 … Fri 2025-03-14, with Fri 2025-03-07 a holiday
const cal = [
  '2025-03-03',
  '2025-03-04',
  '2025-03-05',
  '2025-03-06',
  '2025-03-10',
  '2025-03-11',
  '2025-03-12',
  '2025-03-13',
  '2025-03-14',
];

describe('settlement & eligibility (T+2)', () => {
  it('settlementDateFor skips non-trading days', () => {
    expect(settlementDateFor('2025-03-05', 2, cal)).toBe('2025-03-10');
    expect(settlementDateFor('2025-03-08', 1, cal)).toBe('2025-03-10'); // trade date not in calendar
    expect(settlementDateFor('2025-03-05', 0, cal)).toBe('2025-03-05');
    expect(() => settlementDateFor('2025-03-13', 2, cal)).toThrow(RangeError);
    expect(() => settlementDateFor('2025-03-05', -1, cal)).toThrow(RangeError);
    expect(() => settlementDateFor('2025-03-05', 2, ['2025-03-06', '2025-03-05'])).toThrow(RangeError);
  });
  it('book closure starting Wed 2025-03-12: last cum date is Thu 2025-03-06', () => {
    expect(latestEligibleTradeDate('2025-03-12', 2, cal)).toBe('2025-03-06');
    expect(isTradeEligibleForBookClosure('2025-03-06', '2025-03-12', 2, cal)).toBe(true); // settles 03-11
    expect(isTradeEligibleForBookClosure('2025-03-10', '2025-03-12', 2, cal)).toBe(false); // settles 03-12
    expect(latestEligibleTradeDate('2025-03-04', 2, cal)).toBeNull();
  });
  it('settledQuantityBefore sums signed movements settled before book closure', () => {
    const q = settledQuantityBefore(
      [
        { settlementDate: '2025-03-05', quantity: '100' },
        { settlementDate: '2025-03-10', quantity: '-30' },
        { settlementDate: '2025-03-12', quantity: '50' },
      ],
      '2025-03-12',
    );
    expect(q.eq(d('70'))).toBe(true);
    expect(() =>
      settledQuantityBefore([{ settlementDate: '2025-03-05', quantity: '-1' }], '2025-03-12'),
    ).toThrow(RangeError);
  });
});
