import { describe, expect, it } from 'vitest';
import { d } from '@ktrade/finance-core';
import { PsxCalendar } from '../market-data/calendar.js';
import { eligibleShares, type ShareDelta } from './eligibility.js';
import { lookupDividendWht } from './wht.js';

// November 2026: Mon 16, Tue 17, Wed 18, Thu 19, Fri 20, Mon 23, Tue 24, Wed 25.
const BOOK_CLOSURE = '2026-11-25'; // Wednesday
const cal = new PsxCalendar();
const buy = (date: string, qty: string): ShareDelta => ({ date, quantity: d(qty), settles: 'T_PLUS_N' });
const sell = (date: string, qty: string): ShareDelta => ({
  date,
  quantity: d(qty).neg(),
  settles: 'T_PLUS_N',
});

describe('dividend eligibility (T+1, settled strictly before book closure)', () => {
  it('a buy two trading days before book closure (T-2) is eligible', () => {
    expect(eligibleShares([buy('2026-11-23', '100')], BOOK_CLOSURE, 1, cal).toFixed()).toBe('100');
  });

  it('a buy one trading day before book closure (T-1) is not eligible: it settles on the first closure day', () => {
    expect(eligibleShares([buy('2026-11-24', '100')], BOOK_CLOSURE, 1, cal).toFixed()).toBe('0');
  });

  it('trades on or after book-closure start never count', () => {
    expect(
      eligibleShares([buy('2026-11-25', '100'), buy('2026-11-30', '5')], BOOK_CLOSURE, 1, cal).toFixed(),
    ).toBe('0');
  });

  it('a sell that settles before book closure reduces the entitlement; a T-1 sell does not', () => {
    const deltas = [buy('2026-11-02', '1000'), sell('2026-11-20', '200'), sell('2026-11-24', '300')];
    // the T-1 sell settles on 25th → the seller is still the holder of record for those 300.
    expect(eligibleShares(deltas, BOOK_CLOSURE, 1, cal).toFixed()).toBe('800');
  });

  it('a Friday trade settles on Monday (weekends skipped)', () => {
    // Book closure Tue 24: Fri 20 settles Mon 23 < 24 → eligible; Mon 23 settles Tue 24 → not.
    expect(
      eligibleShares([buy('2026-11-20', '10'), buy('2026-11-23', '7')], '2026-11-24', 1, cal).toFixed(),
    ).toBe('10');
  });

  it('holidays push settlement out (a holiday on T+1 makes a T-2 calendar buy ineligible)', () => {
    const holidayCal = new PsxCalendar(['2026-11-24']); // Tuesday holiday
    // Mon 23 would settle Tue 24 → holiday → Wed 25 = book closure → not eligible.
    expect(eligibleShares([buy('2026-11-23', '100')], BOOK_CLOSURE, 1, holidayCal).toFixed()).toBe('0');
    // Fri 20 settles Mon 23 → eligible.
    expect(eligibleShares([buy('2026-11-20', '100')], BOOK_CLOSURE, 1, holidayCal).toFixed()).toBe('100');
  });

  it('bonus shares credited before book closure count from their event date (no settlement cycle)', () => {
    const deltas: ShareDelta[] = [
      buy('2026-11-02', '1000'),
      { date: '2026-11-24', quantity: d('100'), settles: 'EVENT_DATE' }, // 1-for-10 bonus credited on 24th
    ];
    expect(eligibleShares(deltas, BOOK_CLOSURE, 1, cal).toFixed()).toBe('1100');
    // credited on book-closure start → not counted
    const late: ShareDelta[] = [
      deltas[0]!,
      { date: BOOK_CLOSURE, quantity: d('100'), settles: 'EVENT_DATE' },
    ];
    expect(eligibleShares(late, BOOK_CLOSURE, 1, cal).toFixed()).toBe('1000');
  });

  it('T+2 moves the last cum date one trading day earlier', () => {
    expect(eligibleShares([buy('2026-11-20', '1')], BOOK_CLOSURE, 2, cal).toFixed()).toBe('1'); // settles Tue 24
    expect(eligibleShares([buy('2026-11-23', '1')], BOOK_CLOSURE, 2, cal).toFixed()).toBe('0'); // settles Wed 25
  });

  it('no movements → zero', () => {
    expect(eligibleShares([], BOOK_CLOSURE, 1, cal).toFixed()).toBe('0');
  });
});

describe('dividend WHT lookup never invents a rate', () => {
  const row = (filerStatus: 'FILER' | 'NON_FILER', rate: string, verified = true) => ({
    taxType: 'DIVIDEND_WITHHOLDING' as const,
    filerStatus,
    rate: d(rate),
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
    verified,
  });

  it('UNKNOWN filer is NOT_CONFIGURED even when a NON_FILER rate exists', () => {
    expect(lookupDividendWht([row('NON_FILER', '0.3')], 'UNKNOWN', '2026-12-01')).toMatchObject({
      status: 'NOT_CONFIGURED',
      reason: 'FILER_STATUS_UNKNOWN',
    });
  });

  it('no rows or only unverified rows → NOT_CONFIGURED', () => {
    expect(lookupDividendWht([], 'FILER', '2026-12-01')).toMatchObject({ reason: 'NO_VERIFIED_RATE' });
    expect(lookupDividendWht([row('FILER', '0.15', false)], 'FILER', '2026-12-01')).toMatchObject({
      reason: 'NO_VERIFIED_RATE',
    });
  });

  it('a verified rate in effect is used; before its effective date it is not', () => {
    const hit = lookupDividendWht([row('FILER', '0.15')], 'FILER', '2026-12-01');
    expect(hit.status).toBe('CONFIGURED');
    expect(hit.status === 'CONFIGURED' && hit.rate.toFixed()).toBe('0.15');
    expect(lookupDividendWht([row('FILER', '0.15')], 'FILER', '2026-06-30').status).toBe('NOT_CONFIGURED');
  });

  it('overlapping verified rates → AMBIGUOUS_RATES (no guess)', () => {
    expect(
      lookupDividendWht([row('FILER', '0.15'), row('FILER', '0.25')], 'FILER', '2026-12-01'),
    ).toMatchObject({
      reason: 'AMBIGUOUS_RATES',
    });
  });
});
