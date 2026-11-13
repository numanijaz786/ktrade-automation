import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { d, round, roundPaisa } from '../decimal.js';
import { computeTradeFees, FeeScheduleError, ktradeDefaultSchedule, selectFeeSchedule } from './engine.js';
import { type FeeScheduleItemSpec } from './types.js';

const KT = ktradeDefaultSchedule('2025-01-01');
const amt = (b: ReturnType<typeof computeTradeFees>, c: string) =>
  b.lines.find((l) => l.component === c)?.amount.toFixed(2);

describe('KTrade default schedule — docs/06 §3 worked example', () => {
  it('row 1: BUY 100 @ 250 → commission 75.00, SST 11.25, fees 86.25', () => {
    const b = computeTradeFees(KT, { side: 'BUY', quantity: '100', price: '250' });
    expect(amt(b, 'COMMISSION')).toBe('75.00');
    expect(amt(b, 'SST_ON_COMMISSION')).toBe('11.25');
    expect(b.capitalisedFees.toFixed(2)).toBe('86.25');
    expect(b.taxes.toFixed(2)).toBe('0.00');
    expect(b.grossValue.toFixed(4)).toBe('25000.0000');
    expect(b.netAmount.toFixed(2)).toBe('-25086.25');
  });

  it('row 2: BUY 50 @ 270 → commission 40.50, SST 6.075 rounds half-up to 6.08', () => {
    const b = computeTradeFees(KT, { side: 'BUY', quantity: '50', price: '270' });
    expect(amt(b, 'COMMISSION')).toBe('40.50');
    expect(amt(b, 'SST_ON_COMMISSION')).toBe('6.08');
    expect(b.capitalisedFees.toFixed(2)).toBe('46.58');
  });

  it('row 3: SELL 60 @ 280 → 50.40 + 7.56; net proceeds 16742.04', () => {
    const b = computeTradeFees(KT, { side: 'SELL', quantity: '60', price: '280' });
    expect(amt(b, 'COMMISSION')).toBe('50.40');
    expect(amt(b, 'SST_ON_COMMISSION')).toBe('7.56');
    expect(b.netAmount.toFixed(2)).toBe('16742.04');
  });

  it('6.075 rounds to 6.07 under HALF_EVEN, 6.08 under HALF_UP', () => {
    const even = computeTradeFees(
      KT,
      { side: 'BUY', quantity: '50', price: '270' },
      { rounding: 'HALF_EVEN' },
    );
    expect(amt(even, 'SST_ON_COMMISSION')).toBe('6.08'); // 6.075 → nearest even paisa is 6.08
    const down = computeTradeFees(KT, { side: 'BUY', quantity: '50', price: '270' }, { rounding: 'DOWN' });
    expect(amt(down, 'SST_ON_COMMISSION')).toBe('6.07');
  });

  it('per-share floor applies to low-priced stocks: max(0.3% × value, 0.06 × qty)', () => {
    // 1000 @ 10 → 0.3% = 30.00, per share = 60.00 → 60.00; SST 9.00
    const b = computeTradeFees(KT, { side: 'BUY', quantity: '1000', price: '10' });
    expect(amt(b, 'COMMISSION')).toBe('60.00');
    expect(amt(b, 'SST_ON_COMMISSION')).toBe('9.00');
    // crossover exactly at price 20: both legs equal
    expect(amt(computeTradeFees(KT, { side: 'BUY', quantity: '10', price: '20' }), 'COMMISSION')).toBe(
      '0.60',
    );
  });

  it('flags AT_ACTUAL components as 0 with atActual', () => {
    const b = computeTradeFees(KT, { side: 'BUY', quantity: '100', price: '250' });
    const cdc = b.lines.find((l) => l.component === 'CDC_CHARGES');
    expect(cdc?.amount.isZero()).toBe(true);
    expect(cdc?.atActual).toBe(true);
    expect(b.hasAtActual).toBe(true);
    expect(b.lines.every((l) => l.source === 'ESTIMATED')).toBe(true);
    expect(b.lines.map((l) => l.component)).toEqual([
      'COMMISSION',
      'SST_ON_COMMISSION',
      'CDC_CHARGES',
      'NCCPL_CHARGES',
      'SECP_LEVY',
      'PSX_LEVY',
      'CVT',
    ]);
  });

  it('day trade: second leg pays no commission and no SST', () => {
    const b = computeTradeFees(KT, {
      side: 'SELL',
      quantity: '100',
      price: '250',
      isDayTradeSecondLeg: true,
    });
    expect(amt(b, 'COMMISSION')).toBe('0.00');
    expect(amt(b, 'SST_ON_COMMISSION')).toBe('0.00');
    expect(b.lines.find((l) => l.component === 'COMMISSION')?.dayTradeWaived).toBe(true);
    expect(b.lines.find((l) => l.component === 'SST_ON_COMMISSION')?.dayTradeWaived).toBe(true);
    expect(b.netAmount.toFixed(2)).toBe('25000.00');
  });

  it('rejects non-positive quantity and negative price', () => {
    expect(() => computeTradeFees(KT, { side: 'BUY', quantity: '0', price: '1' })).toThrow(RangeError);
    expect(() => computeTradeFees(KT, { side: 'BUY', quantity: '1', price: '-1' })).toThrow(RangeError);
  });

  it('property: commission ≥ 0.3% value and ≥ 0.06/share (to the paisa); SST = 15% of commission', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (q, paisa) => {
          const price = d(paisa.toString()).div(100);
          const b = computeTradeFees(KT, { side: 'BUY', quantity: q.toString(), price });
          const comm = b.lines[0]?.amount ?? d('0');
          const sst = b.lines[1]?.amount ?? d('0');
          const value = d(q.toString()).times(price);
          expect(comm.gte(round(value.times('0.003'), 2, 'DOWN'))).toBe(true);
          expect(comm.gte(round(d(q.toString()).times('0.06'), 2, 'DOWN'))).toBe(true);
          expect(sst.eq(roundPaisa(comm.times('0.15')))).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

const item = (
  over: Partial<FeeScheduleItemSpec> & Pick<FeeScheduleItemSpec, 'component' | 'method'>,
): FeeScheduleItemSpec => ({
  appliesTo: 'BOTH',
  capitalise: true,
  sortOrder: 0,
  ...over,
});

describe('fee methods', () => {
  const trade = { side: 'BUY' as const, quantity: '200', price: '12.5' }; // value 2500

  it('PCT_OF_VALUE, PER_SHARE, FIXED', () => {
    const b = computeTradeFees(
      [
        item({ component: 'PSX_LEVY', method: 'PCT_OF_VALUE', rate: d('0.0000277') }),
        item({ component: 'CDC_CHARGES', method: 'PER_SHARE', perShare: d('0.005') }),
        item({ component: 'OTHER', method: 'FIXED', fixedAmount: d('25') }),
      ],
      trade,
    );
    expect(amt(b, 'PSX_LEVY')).toBe('0.07'); // 0.06925 → 0.07
    expect(amt(b, 'CDC_CHARGES')).toBe('1.00');
    expect(amt(b, 'OTHER')).toBe('25.00');
    expect(b.hasAtActual).toBe(false);
  });

  it('minAmount floors a component', () => {
    const b = computeTradeFees(
      [item({ component: 'COMMISSION', method: 'PCT_OF_VALUE', rate: d('0.001'), minAmount: d('10') })],
      trade,
    );
    expect(amt(b, 'COMMISSION')).toBe('10.00');
  });

  it('minAmount does not override the day-trade waiver', () => {
    const b = computeTradeFees(
      [item({ component: 'COMMISSION', method: 'PCT_OF_VALUE', rate: d('0.001'), minAmount: d('10') })],
      { ...trade, isDayTradeSecondLeg: true },
    );
    expect(amt(b, 'COMMISSION')).toBe('0.00');
  });

  it('non-capitalised components count as taxes', () => {
    const b = computeTradeFees(
      [
        item({ component: 'COMMISSION', method: 'FIXED', fixedAmount: d('10') }),
        item({
          component: 'CGT',
          method: 'PCT_OF_VALUE',
          rate: d('0.01'),
          capitalise: false,
          appliesTo: 'SELL',
        }),
      ],
      { ...trade, side: 'SELL' },
    );
    expect(b.capitalisedFees.toFixed(2)).toBe('10.00');
    expect(b.taxes.toFixed(2)).toBe('25.00');
    expect(b.netAmount.toFixed(2)).toBe('2465.00');
  });

  it('side-specific items apply only to their side and override BOTH', () => {
    const items = [
      item({ component: 'COMMISSION', method: 'FIXED', fixedAmount: d('10') }),
      item({ component: 'COMMISSION', method: 'FIXED', fixedAmount: d('20'), appliesTo: 'SELL' }),
      item({ component: 'ZAKAT', method: 'FIXED', fixedAmount: d('5'), appliesTo: 'DIVIDEND' }),
    ];
    expect(amt(computeTradeFees(items, trade), 'COMMISSION')).toBe('10.00');
    expect(amt(computeTradeFees(items, { ...trade, side: 'SELL' }), 'COMMISSION')).toBe('20.00');
    expect(computeTradeFees(items, trade).lines).toHaveLength(1);
  });

  it('throws on duplicate component for the same side', () => {
    const items = [
      item({ component: 'COMMISSION', method: 'FIXED', fixedAmount: d('10') }),
      item({ component: 'COMMISSION', method: 'FIXED', fixedAmount: d('20') }),
    ];
    expect(() => computeTradeFees(items, trade)).toThrow(FeeScheduleError);
  });

  it('PCT_OF_COMPONENT: missing base, cycle, missing baseComponent, missing rate', () => {
    const missing = [
      item({
        component: 'SST_ON_COMMISSION',
        method: 'PCT_OF_COMPONENT',
        rate: d('0.15'),
        baseComponent: 'COMMISSION',
      }),
    ];
    expect(() => computeTradeFees(missing, trade)).toThrow(
      expect.objectContaining({ code: 'MISSING_BASE_COMPONENT' }),
    );
    const cyclic = [
      item({ component: 'OTHER', method: 'PCT_OF_COMPONENT', rate: d('0.1'), baseComponent: 'CVT' }),
      item({ component: 'CVT', method: 'PCT_OF_COMPONENT', rate: d('0.1'), baseComponent: 'OTHER' }),
    ];
    expect(() => computeTradeFees(cyclic, trade)).toThrow(
      expect.objectContaining({ code: 'CYCLIC_COMPONENTS' }),
    );
    const self = [
      item({ component: 'OTHER', method: 'PCT_OF_COMPONENT', rate: d('0.1'), baseComponent: 'OTHER' }),
    ];
    expect(() => computeTradeFees(self, trade)).toThrow(
      expect.objectContaining({ code: 'CYCLIC_COMPONENTS' }),
    );
    const noBase = [item({ component: 'OTHER', method: 'PCT_OF_COMPONENT', rate: d('0.1') })];
    expect(() => computeTradeFees(noBase, trade)).toThrow(
      expect.objectContaining({ code: 'MISSING_PARAMETER' }),
    );
    const noRate = [item({ component: 'COMMISSION', method: 'PCT_OF_VALUE' })];
    expect(() => computeTradeFees(noRate, trade)).toThrow(
      expect.objectContaining({ code: 'MISSING_PARAMETER' }),
    );
    const negRate = [item({ component: 'COMMISSION', method: 'PCT_OF_VALUE', rate: d('-0.1') })];
    expect(() => computeTradeFees(negRate, trade)).toThrow(
      expect.objectContaining({ code: 'INVALID_PARAMETER' }),
    );
  });

  it('PCT_OF_COMPONENT is evaluated after its base regardless of item order; chains work', () => {
    const items = [
      item({
        component: 'CVT',
        method: 'PCT_OF_COMPONENT',
        rate: d('0.5'),
        baseComponent: 'SST_ON_COMMISSION',
        sortOrder: 3,
      }),
      item({
        component: 'SST_ON_COMMISSION',
        method: 'PCT_OF_COMPONENT',
        rate: d('0.1'),
        baseComponent: 'COMMISSION',
        sortOrder: 2,
      }),
      item({ component: 'COMMISSION', method: 'FIXED', fixedAmount: d('100'), sortOrder: 1 }),
    ];
    const b = computeTradeFees(items, trade);
    expect(b.lines.map((l) => [l.component, l.amount.toFixed(2)])).toEqual([
      ['COMMISSION', '100.00'],
      ['SST_ON_COMMISSION', '10.00'],
      ['CVT', '5.00'],
    ]);
  });

  it('a component derived from an AT_ACTUAL base is itself flagged atActual', () => {
    const items = [
      item({ component: 'CDC_CHARGES', method: 'AT_ACTUAL' }),
      item({
        component: 'OTHER',
        method: 'PCT_OF_COMPONENT',
        rate: d('0.15'),
        baseComponent: 'CDC_CHARGES',
        minAmount: d('1'),
      }),
    ];
    const b = computeTradeFees(items, trade);
    const other = b.lines.find((l) => l.component === 'OTHER');
    expect(other?.atActual).toBe(true);
    expect(other?.amount.isZero()).toBe(true);
  });
});

describe('selectFeeSchedule', () => {
  const a = { ...ktradeDefaultSchedule('2024-01-01'), effectiveTo: '2024-12-31' };
  const b = ktradeDefaultSchedule('2025-01-01');
  it('picks the schedule effective on the date (effectiveTo inclusive)', () => {
    expect(selectFeeSchedule([a, b], '2024-12-31')).toBe(a);
    expect(selectFeeSchedule([a, b], '2025-01-01')).toBe(b);
    expect(selectFeeSchedule([a, b], '2030-06-01')).toBe(b);
  });
  it('throws when none applies or two collide', () => {
    expect(() => selectFeeSchedule([a, b], '2023-12-31')).toThrow(FeeScheduleError);
    expect(() => selectFeeSchedule([b, ktradeDefaultSchedule('2025-01-01')], '2025-02-01')).toThrow(
      expect.objectContaining({ code: 'AMBIGUOUS_SCHEDULE' }),
    );
  });
  it('validates ISO dates', () => {
    expect(() => ktradeDefaultSchedule('2025-02-30')).toThrow(RangeError);
    expect(() => selectFeeSchedule([b], '01/02/2025')).toThrow(RangeError);
  });
});
