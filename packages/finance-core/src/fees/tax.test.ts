import { describe, expect, it } from 'vitest';
import { d } from '../decimal.js';
import { estimateDividendTax, findTaxRate, TaxRateNotFoundError, type TaxRateRow } from './tax.js';

// Placeholder rates for tests only — NOT real FBR rates.
const rows: TaxRateRow[] = [
  { taxType: 'DIVIDEND_WITHHOLDING', filerStatus: 'FILER', rate: d('0.15'), effectiveFrom: '2020-07-01', effectiveTo: '2024-06-30' },
  { taxType: 'DIVIDEND_WITHHOLDING', filerStatus: 'FILER', rate: d('0.25'), effectiveFrom: '2024-07-01', verified: true },
  { taxType: 'DIVIDEND_WITHHOLDING', filerStatus: 'NON_FILER', rate: d('0.30'), effectiveFrom: '2020-07-01' },
  { taxType: 'CAPITAL_GAINS', filerStatus: 'FILER', minHoldingDays: 0, maxHoldingDays: 364, rate: d('0.15'), effectiveFrom: '2020-07-01' },
  { taxType: 'CAPITAL_GAINS', filerStatus: 'FILER', minHoldingDays: 365, maxHoldingDays: null, rate: d('0.075'), effectiveFrom: '2020-07-01' },
];

describe('findTaxRate', () => {
  it('picks by type, filer status and effective date (effectiveTo inclusive)', () => {
    expect(findTaxRate(rows, { taxType: 'DIVIDEND_WITHHOLDING', filerStatus: 'FILER', date: '2024-06-30' }).rate.toString()).toBe('0.15');
    expect(findTaxRate(rows, { taxType: 'DIVIDEND_WITHHOLDING', filerStatus: 'FILER', date: '2024-07-01' }).rate.toString()).toBe('0.25');
  });

  it('latest effectiveFrom wins when ranges overlap', () => {
    const overlapping = [...rows, { ...rows[1]!, rate: d('0.2'), effectiveFrom: '2025-01-01' }];
    expect(findTaxRate(overlapping, { taxType: 'DIVIDEND_WITHHOLDING', filerStatus: 'FILER', date: '2025-03-01' }).rate.toString()).toBe('0.2');
  });

  it('selects CGT bands by holding days (both bounds inclusive)', () => {
    const q = { taxType: 'CAPITAL_GAINS' as const, filerStatus: 'FILER' as const, date: '2025-01-01' };
    expect(findTaxRate(rows, { ...q, holdingDays: 0 }).rate.toString()).toBe('0.15');
    expect(findTaxRate(rows, { ...q, holdingDays: 364 }).rate.toString()).toBe('0.15');
    expect(findTaxRate(rows, { ...q, holdingDays: 365 }).rate.toString()).toBe('0.075');
    expect(() => findTaxRate(rows, q)).toThrow(TaxRateNotFoundError); // banded rows need holdingDays
    expect(() => findTaxRate(rows, { ...q, holdingDays: -1 })).toThrow(RangeError);
  });

  it('throws AMBIGUOUS on overlapping bands with the same effectiveFrom', () => {
    const bad = [...rows, { ...rows[3]!, minHoldingDays: 300, maxHoldingDays: 400 }];
    expect(() => findTaxRate(bad, { taxType: 'CAPITAL_GAINS', filerStatus: 'FILER', date: '2025-01-01', holdingDays: 350 })).toThrow(
      expect.objectContaining({ code: 'AMBIGUOUS' }),
    );
  });

  it('UNKNOWN falls back to NON_FILER unless disabled', () => {
    const q = { taxType: 'DIVIDEND_WITHHOLDING' as const, filerStatus: 'UNKNOWN' as const, date: '2025-01-01' };
    expect(findTaxRate(rows, q).rate.toString()).toBe('0.3');
    expect(() => findTaxRate(rows, { ...q, unknownAsNonFiler: false })).toThrow(TaxRateNotFoundError);
  });

  it('throws a typed NOT_FOUND error before any rate is effective', () => {
    try {
      findTaxRate(rows, { taxType: 'DIVIDEND_WITHHOLDING', filerStatus: 'FILER', date: '2019-01-01' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TaxRateNotFoundError);
      expect((e as TaxRateNotFoundError).code).toBe('NOT_FOUND');
    }
  });
});

describe('estimateDividendTax', () => {
  it('computes WHT on gross at the payment-date rate, paisa-rounded', () => {
    const t = estimateDividendTax(rows, { gross: '1234.57', filerStatus: 'FILER', paymentDate: '2025-01-15' });
    expect(t.rate.toString()).toBe('0.25');
    expect(t.amount.toFixed(2)).toBe('308.64'); // 308.6425
    expect(t.verified).toBe(true);
    const nf = estimateDividendTax(rows, { gross: '100', filerStatus: 'NON_FILER', paymentDate: '2025-01-15' });
    expect(nf.amount.toFixed(2)).toBe('30.00');
    expect(nf.verified).toBe(false);
  });
  it('rejects negative gross', () => {
    expect(() => estimateDividendTax(rows, { gross: '-1', filerStatus: 'FILER', paymentDate: '2025-01-15' })).toThrow(RangeError);
  });
});
