import { describe, expect, it } from 'vitest';
import { DATA_SOURCES, weakestSource } from './enums.js';
import { decimalString, positiveDecimalString } from './decimal-string.js';

describe('weakestSource', () => {
  it('returns the least-trusted provenance', () => {
    expect(weakestSource(['BROKER_CONFIRMED', 'ESTIMATED', 'PROVIDER'])).toBe('ESTIMATED');
    expect(weakestSource(['BROKER_CONFIRMED'])).toBe('BROKER_CONFIRMED');
    expect(weakestSource([...DATA_SOURCES])).toBe('SIMULATED');
  });
});

describe('decimal string schemas', () => {
  it.each(['0', '1234.50', '-12.0001', '0.0000000001'])('accepts %s', (v) => {
    expect(decimalString.parse(v)).toBe(v);
  });

  it.each(['1e5', '12.', '.5', 'NaN', '1,000', '', '12.12345678901'])('rejects %j', (v) => {
    expect(decimalString.safeParse(v).success).toBe(false);
  });

  it('positive rejects zero and negatives', () => {
    expect(positiveDecimalString.safeParse('0.00').success).toBe(false);
    expect(positiveDecimalString.safeParse('-1').success).toBe(false);
    expect(positiveDecimalString.safeParse('0.01').success).toBe(true);
  });
});
