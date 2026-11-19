import { describe, expect, it } from 'vitest';
import { priceLabel, riskAmount, tradePrefillHref, validateRiskPct, whenToBuy } from './advisor-rules';
import type { AdvisorPlan, AdvisorPrice } from './types-advisor';

const plan = {
  entry: { low: '98', high: '101', basis: '' },
  stopLoss: { price: '94', basis: '', downsidePct: '7' },
  targets: [],
  holdingPeriod: '',
  size: {
    quantity: '200',
    allocationPct: '4',
    binding: '',
    estimatedCost: '',
    estimatedBuyFees: '',
    maxLossAtStop: '',
  },
} as AdvisorPlan;
const price = (value: string): AdvisorPrice => ({
  value,
  source: 'PROVIDER',
  asOfBar: '',
  barTs: '',
  verified: true,
});

describe('validateRiskPct (0 < r <= 5)', () => {
  it.each(['0.5', '1', '5', '5.00', '2.25'])('accepts %s', (v) => expect(validateRiskPct(v)).toBeNull());
  it.each(['', '0', '0.00', '-1', '5.01', '6', 'abc', '1.234', '1e2'])('rejects %s', (v) =>
    expect(validateRiskPct(v)).not.toBeNull(),
  );
});

describe('whenToBuy', () => {
  it('says to wait and not chase when the price is above the range', () => {
    const t = whenToBuy({ plan, price: price('105') });
    expect(t.kind).toBe('wait');
    expect(t.text).toMatch(/do not chase/i);
  });
  it('says it is in range, or below it', () => {
    expect(whenToBuy({ plan, price: price('100') }).kind).toBe('now');
    expect(whenToBuy({ plan, price: price('90') }).kind).toBe('below');
  });
  it('gives no timing without a plan', () => {
    expect(whenToBuy({ plan: null, price: price('100') }).kind).toBe('unknown');
  });
});

describe('tradePrefillHref', () => {
  it('prefills symbol, BUY, quantity and a limit at the entry high', () => {
    expect(tradePrefillHref({ symbol: 'OGDC', plan })).toBe(
      '/trade?symbol=OGDC&side=BUY&qty=200&type=LIMIT&limit=101',
    );
  });
  it('gives no link without a plan or a whole quantity', () => {
    expect(tradePrefillHref({ symbol: 'A', plan: null })).toBeNull();
    expect(
      tradePrefillHref({ symbol: 'A', plan: { ...plan, size: { ...plan.size, quantity: '0' } } }),
    ).toBeNull();
    expect(
      tradePrefillHref({ symbol: 'A', plan: { ...plan, size: { ...plan.size, quantity: '' } } }),
    ).toBeNull();
  });
});

describe('priceLabel', () => {
  it('never calls simulated or estimated prices live or verified', () => {
    expect(priceLabel({ source: 'SIMULATED', verified: false }).text).toBe('Simulated');
    expect(priceLabel({ source: 'ESTIMATED', verified: false }).text).toBe('Estimated');
  });
  it('labels imported, delayed and stale prices', () => {
    expect(priceLabel({ source: 'USER_REPORTED', verified: true }).text).toBe('Imported');
    expect(priceLabel({ source: 'PROVIDER', verified: true }).text).toMatch(/Delayed/);
    expect(priceLabel({ source: 'PROVIDER', verified: false }).text).toMatch(/stale/i);
  });
});

describe('riskAmount', () => {
  it('is equity times the saved percentage, in decimal arithmetic', () => {
    expect(riskAmount('1000000', '1.5')).toBe('15000');
    expect(riskAmount('333.33', '0.5')).toBe('1.67');
  });
});
