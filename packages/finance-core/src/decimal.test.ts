import { describe, expect, it } from 'vitest';
import { d, fromInt, pct, roundMoney, roundPaisa, sum, toFixedString } from './decimal.js';

describe('decimal primitives', () => {
  it('is exact where binary floating point is not', () => {
    expect(d('0.1').plus(d('0.2')).eq(d('0.3'))).toBe(true);
    expect(sum([d('0.1'), d('0.2'), d('0.3')]).toString()).toBe('0.6');
  });

  it('rejects non-finite input', () => {
    expect(() => d('Infinity')).toThrow(RangeError);
    expect(() => d('NaN')).toThrow();
  });

  it('fromInt accepts only safe integers', () => {
    expect(fromInt(14).toString()).toBe('14');
    expect(() => fromInt(1.5)).toThrow(RangeError);
  });

  it('roundPaisa defaults to half-up; roundMoney is half-even', () => {
    expect(roundPaisa(d('6.075')).toString()).toBe('6.08');
    expect(roundPaisa(d('6.065')).toString()).toBe('6.07');
    expect(roundPaisa(d('6.065'), 'HALF_EVEN').toString()).toBe('6.06');
    expect(roundMoney(d('1.00005')).toString()).toBe('1');
    expect(roundMoney(d('1.00015')).toString()).toBe('1.0002');
  });

  it('serializes with fixed decimals', () => {
    expect(toFixedString(d('25086.25'), 4)).toBe('25086.2500');
  });

  it('pct returns null for a zero denominator', () => {
    expect(pct(d('5'), d('0'))).toBeNull();
    expect(pct(d('5'), d('20'))?.toString()).toBe('25');
  });
});
