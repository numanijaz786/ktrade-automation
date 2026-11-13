import { describe, expect, it } from 'vitest';
import { Dec } from './decimal';
import { formatNumber, formatPKR, formatPercent, formatQty, humanize, MINUS, toneClass, toneOf } from './format';

describe('Dec', () => {
  it('adds without float artifacts', () => {
    expect(Dec.of('0.1').add('0.2').toString()).toBe('0.3');
    expect(Dec.of('1.005').round(2).toFixed(2)).toBe('1.01');
    expect(Dec.of('-1.005').round(2).toFixed(2)).toBe('-1.01');
  });

  it('multiplies and divides exactly to 10 dp', () => {
    expect(Dec.of('15000').mul('0.003').toFixed(2)).toBe('45.00');
    expect(Dec.of('1').div('3').toFixed(10)).toBe('0.3333333333');
    expect(Dec.of('2').div('3').toFixed(4)).toBe('0.6667');
  });

  it('floors toward −∞', () => {
    expect(Dec.of('12.9').floor().toString()).toBe('12');
    expect(Dec.of('-12.1').floor().toString()).toBe('-13');
  });

  it('rejects non-decimal input', () => {
    expect(() => Dec.of('1e5')).toThrow();
    expect(() => Dec.of(0.1)).toThrow();
  });
});

describe('formatPKR', () => {
  it('groups thousands and keeps 2 dp', () => {
    expect(formatPKR('1254300.5')).toBe('Rs 1,254,300.50');
    expect(formatPKR('0')).toBe('Rs 0.00');
  });

  it('uses a typographic minus and optional plus', () => {
    expect(formatPKR('-1234')).toBe(`${MINUS}Rs 1,234.00`);
    expect(formatPKR('12.3', { signed: true })).toBe('+Rs 12.30');
    expect(formatPKR('-0.001', { signed: true })).toBe('Rs 0.00');
  });

  it('compacts large amounts using exact decimal division', () => {
    expect(formatPKR('1254300.50', { compact: true })).toBe('Rs 1.25M');
    expect(formatPKR('-12500', { compact: true, dp: 1 })).toBe(`${MINUS}Rs 12.5K`);
    expect(formatPKR('999', { compact: true })).toBe('Rs 999.00');
  });

  it('renders an em dash for missing or invalid values', () => {
    expect(formatPKR(null)).toBe('—');
    expect(formatPKR('abc')).toBe('—');
  });
});

describe('formatNumber / formatQty / formatPercent', () => {
  it('formats numbers', () => {
    expect(formatNumber('1234567.891')).toBe('1,234,567.89');
    expect(formatNumber('5', { signed: true, dp: 0 })).toBe('+5');
  });

  it('formats quantities as whole shares', () => {
    expect(formatQty('12500')).toBe('12,500');
    expect(formatQty('10.5')).toBe('10.5000');
  });

  it('formats percents from percent or fraction inputs', () => {
    expect(formatPercent('2.345')).toBe('2.35%');
    expect(formatPercent('0.0235', { fraction: true })).toBe('2.35%');
    expect(formatPercent('-1.2', { signed: true })).toBe(`${MINUS}1.20%`);
    expect(formatPercent('1.2', { signed: true })).toBe('+1.20%');
  });
});

describe('P&L tone', () => {
  it('maps sign to tone and class', () => {
    expect(toneOf('12.00')).toBe('gain');
    expect(toneOf('-0.01')).toBe('loss');
    expect(toneOf('0.00')).toBe('flat');
    expect(toneClass('gain')).toBe('text-gain');
    expect(toneClass('loss')).toBe('text-loss');
  });
});

describe('humanize', () => {
  it('turns enum values into sentence case', () => {
    expect(humanize('AWAITING_MANUAL_PLACEMENT')).toBe('Awaiting manual placement');
  });
});
