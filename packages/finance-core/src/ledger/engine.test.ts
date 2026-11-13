import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Decimal, d, sum } from '../decimal.js';
import { computeTradeFees, ktradeDefaultSchedule } from '../fees/engine.js';
import { applyEvent, createLedgerState, orderLedgerEvents, replay } from './engine.js';
import { type CostBasisMethod, type LedgerEvent, type LedgerState, LedgerError, LedgerOversellError } from './types.js';

const KT = ktradeDefaultSchedule('2025-01-01');
const fees = (side: 'BUY' | 'SELL', quantity: string, price: string) =>
  computeTradeFees(KT, { side, quantity, price }).capitalisedFees;

/** docs/06 §3 fixture `wac-basic`, fees computed by the real fee engine. */
const wacBasic: LedgerEvent[] = [
  { id: 't1', date: '2025-03-03', type: 'BUY', quantity: '100', price: '250.00', fees: fees('BUY', '100', '250') },
  { id: 't2', date: '2025-03-04', type: 'BUY', quantity: '50', price: '270.00', fees: fees('BUY', '50', '270') },
  { id: 't3', date: '2025-03-05', type: 'SELL', quantity: '60', price: '280.00', fees: fees('SELL', '60', '280') },
  { id: 'ca1', date: '2025-03-06', type: 'BONUS', ratioNew: '1', ratioOld: '10' },
];

const s4 = (x: Decimal) => x.toFixed(4);
const s6 = (x: Decimal) => x.toFixed(6);

describe('fixture wac-basic (docs/06 §3)', () => {
  const { state, results } = replay(wacBasic, 'WEIGHTED_AVERAGE');
  const [r1, r2, r3, r4] = results;

  it('row 1: BUY 100 @ 250', () => {
    expect(s4(r1!.quantityAfter)).toBe('100.0000');
    expect(s4(r1!.totalCostAfter)).toBe('25086.2500');
    expect(s6(r1!.avgCostAfter)).toBe('250.862500');
    expect(r1!.realizedPnl).toBeNull();
  });

  it('row 2: BUY 50 @ 270 (fees 46.58)', () => {
    expect(s4(r2!.costAdded)).toBe('13546.5800');
    expect(s4(r2!.quantityAfter)).toBe('150.0000');
    expect(s4(r2!.totalCostAfter)).toBe('38632.8300');
    expect(s6(r2!.avgCostAfter)).toBe('257.552200');
  });

  it('row 3: SELL 60 @ 280', () => {
    expect(s4(r3!.proceeds!)).toBe('16742.0400');
    expect(s4(r3!.costRemoved)).toBe('15453.1320');
    expect(s4(r3!.realizedPnl!)).toBe('1288.9080');
    expect(s4(r3!.quantityAfter)).toBe('90.0000');
    expect(s4(r3!.totalCostAfter)).toBe('23179.6980');
    expect(s6(r3!.avgCostBefore)).toBe('257.552200');
    expect(s6(r3!.avgCostAfter)).toBe('257.552200');
  });

  it('row 4: BONUS 1 for 10', () => {
    expect(s4(r4!.quantityAfter)).toBe('99.0000');
    expect(s4(r4!.totalCostAfter)).toBe('23179.6980');
    expect(s6(r4!.avgCostAfter)).toBe('234.138364');
    expect(r4!.fractionalQty!.isZero()).toBe(true);
  });

  it('final state: holding + lots (bonus lots at cost 0, dated on parent lot)', () => {
    expect(s4(state.realizedPnl)).toBe('1288.9080');
    expect(state.firstAcquiredDate).toBe('2025-03-03');
    expect(state.lots.map((l) => [l.lotId, l.remainingQty.toString(), l.remainingCost.toFixed(4), l.holdingPeriodStart, l.origin])).toEqual([
      ['t1', '40', '10034.5000', '2025-03-03', 'PURCHASE'],
      ['ca1#t1', '4', '0.0000', '2025-03-03', 'BONUS'],
      ['t2', '50', '13546.5800', '2025-03-04', 'PURCHASE'],
      ['ca1#t2', '5', '0.0000', '2025-03-04', 'BONUS'],
    ]);
    expect(sum(state.lots.map((l) => l.remainingQty)).eq(state.quantity)).toBe(true);
  });

  it('FIFO view of the same ledger', () => {
    const fifo = replay(wacBasic, 'FIFO');
    // 60 from lot t1 (cost 25086.25 × 60/100 = 15051.75)
    expect(s4(fifo.results[2]!.costRemoved)).toBe('15051.7500');
    expect(s4(fifo.results[2]!.realizedPnl!)).toBe('1690.2900');
    expect(s4(fifo.state.totalCost)).toBe('23581.0800');
    expect(sum(fifo.state.lots.map((l) => l.remainingCost)).eq(fifo.state.totalCost)).toBe(true);
  });
});

describe('ledger edge cases', () => {
  const buy = (id: string, date: string, quantity: string, price: string, f = '0'): LedgerEvent => ({ id, date, type: 'BUY', quantity, price, fees: f });
  const sell = (id: string, date: string, quantity: string, price: string, f = '0'): LedgerEvent => ({ id, date, type: 'SELL', quantity, price, fees: f });

  it('rejects overselling with a typed error and never goes negative', () => {
    const { state } = replay([buy('b', '2025-01-01', '10', '100')]);
    expect(() => applyEvent(state, sell('s', '2025-01-02', '11', '100'))).toThrow(LedgerOversellError);
    expect(() => applyEvent(createLedgerState(), sell('s', '2025-01-02', '1', '100'))).toThrow(LedgerOversellError);
    expect(() => applyEvent(createLedgerState(), { id: 'x', date: '2025-01-02', type: 'TRANSFER_OUT', quantity: '1' })).toThrow(
      expect.objectContaining({ code: 'OVERSELL' }),
    );
  });

  it('rejects zero / negative / over-precise quantities, negative prices and fees', () => {
    const s = createLedgerState();
    expect(() => applyEvent(s, buy('b', '2025-01-01', '0', '1'))).toThrow(expect.objectContaining({ code: 'INVALID_QUANTITY' }));
    expect(() => applyEvent(s, buy('b', '2025-01-01', '-5', '1'))).toThrow(LedgerError);
    expect(() => applyEvent(s, buy('b', '2025-01-01', '1.00001', '1'))).toThrow(LedgerError);
    expect(() => applyEvent(s, buy('b', '2025-01-01', '1', '-1'))).toThrow(expect.objectContaining({ code: 'INVALID_PRICE' }));
    expect(() => applyEvent(s, buy('b', '2025-01-01', '1', '1', '-0.01'))).toThrow(expect.objectContaining({ code: 'INVALID_FEES' }));
  });

  it('rejects out-of-order events and invalid dates', () => {
    const { state } = replay([buy('b', '2025-01-05', '10', '100')]);
    expect(() => applyEvent(state, buy('c', '2025-01-04', '1', '1'))).toThrow(expect.objectContaining({ code: 'OUT_OF_ORDER' }));
    expect(() => applyEvent(state, buy('c', '2025-13-01', '1', '1'))).toThrow(RangeError);
  });

  it('closing sell sends rounding residue to realized and zeroes cost', () => {
    // 3 shares costing 100.0000 → avg 33.333333; sell 1, then 2
    const { state, results } = replay([
      buy('b', '2025-01-01', '3', '33', '1'),
      sell('s1', '2025-01-02', '1', '40'),
      sell('s2', '2025-01-03', '2', '40'),
    ]);
    expect(s4(results[1]!.costRemoved)).toBe('33.3333');
    expect(s4(results[2]!.costRemoved)).toBe('66.6667'); // residue included
    expect(state.quantity.isZero()).toBe(true);
    expect(state.totalCost.isZero()).toBe(true);
    expect(state.avgCost.isZero()).toBe(true);
    expect(state.lots).toHaveLength(0);
    expect(state.firstAcquiredDate).toBeNull();
    expect(s4(state.realizedPnl)).toBe('20.0000'); // 120 − 100
  });

  it('sell with fees exceeding gross yields a loss, not an error', () => {
    const { results } = replay([buy('b', '2025-01-01', '1', '1'), sell('s', '2025-01-02', '1', '0.5', '5')]);
    expect(s4(results[1]!.realizedPnl!)).toBe('-5.5000');
  });

  it('applyEvent never mutates its input state', () => {
    const { state } = replay(wacBasic);
    const snapshot = JSON.stringify(state);
    applyEvent(state, sell('s', '2025-04-01', '10', '300'), 'FIFO');
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('bonus with fractional entitlement floors and reports the fraction', () => {
    const { state, results } = replay([
      buy('b1', '2025-01-01', '7', '10'),
      buy('b2', '2025-01-02', '8', '10'),
      { id: 'bn', date: '2025-02-01', type: 'BONUS', ratioNew: '1', ratioOld: '10' },
    ]);
    // 15 × 1/10 = 1.5 → 1 bonus share, 0.5 fractional (cash in lieu)
    expect(results[2]!.fractionalQty!.toString()).toBe('0.5');
    expect(state.quantity.toString()).toBe('16');
    expect(state.totalCost.toFixed(4)).toBe('150.0000');
    // lot exacts 0.7 and 0.8 → the unit goes to the larger remainder (b2)
    expect(state.lots.map((l) => l.lotId)).toEqual(['b1', 'b2', 'bn#b2']);
  });

  it('bonus lot dating option BONUS_DATE appends lots dated on the bonus', () => {
    const { state } = replay(
      [buy('b1', '2025-01-01', '10', '10'), buy('b2', '2025-01-02', '10', '10'), { id: 'bn', date: '2025-02-01', type: 'BONUS', ratioNew: '1', ratioOld: '2' }],
      'FIFO',
      { bonusLotDating: 'BONUS_DATE' },
    );
    expect(state.lots.map((l) => [l.lotId, l.holdingPeriodStart])).toEqual([
      ['b1', '2025-01-01'],
      ['b2', '2025-01-02'],
      ['bn#b1', '2025-02-01'],
      ['bn#b2', '2025-02-01'],
    ]);
  });

  it('bonus / split on a flat position is a no-op', () => {
    const r = applyEvent(createLedgerState(), { id: 'bn', date: '2025-02-01', type: 'BONUS', ratioNew: '1', ratioOld: '5' });
    expect(r.state.quantity.isZero()).toBe(true);
    const s = applyEvent(createLedgerState(), { id: 'sp', date: '2025-02-01', type: 'SPLIT', ratioNew: '2', ratioOld: '1' });
    expect(s.state.quantity.isZero()).toBe(true);
  });

  it('split 2:1 doubles qty, halves avg, keeps cost; lots scale', () => {
    const { state, results } = replay(
      [buy('b1', '2025-01-01', '10', '100', '5'), buy('b2', '2025-01-02', '5', '110'), { id: 'sp', date: '2025-02-01', type: 'SPLIT', ratioNew: '2', ratioOld: '1' }],
      'FIFO',
    );
    expect(state.quantity.toString()).toBe('30');
    expect(s4(state.totalCost)).toBe('1555.0000');
    expect(s6(results[2]!.avgCostAfter)).toBe('51.833333');
    expect(state.lots.map((l) => [l.remainingQty.toString(), l.originalQty.toString(), l.remainingCost.toFixed(4)])).toEqual([
      ['20', '20', '1005.0000'],
      ['10', '10', '550.0000'],
    ]);
  });

  it('reverse split 1:10 floors, keeps cost on surviving lots, reports the fraction', () => {
    const { state, results } = replay(
      [buy('b1', '2025-01-01', '25', '10'), buy('b2', '2025-01-02', '3', '20'), { id: 'rs', date: '2025-02-01', type: 'REVERSE_SPLIT', ratioNew: '1', ratioOld: '10' }],
      'FIFO',
    );
    // 28 / 10 = 2.8 → 2 shares, 0.8 fractional. Lots exact 2.5 and 0.3 → [2, 0]; b2's cost moves to b1.
    expect(state.quantity.toString()).toBe('2');
    expect(results[2]!.fractionalQty!.toString()).toBe('0.8');
    expect(s4(state.totalCost)).toBe('310.0000');
    expect(state.lots).toHaveLength(1);
    expect(s4(state.lots[0]!.remainingCost)).toBe('310.0000');
    expect(sum(state.lots.map((l) => l.remainingCost)).eq(state.totalCost)).toBe(true);
  });

  it('reverse split that leaves 0 shares writes the cost off to realized', () => {
    const { state, results } = replay([buy('b1', '2025-01-01', '5', '10'), { id: 'rs', date: '2025-02-01', type: 'REVERSE_SPLIT', ratioNew: '1', ratioOld: '10' }]);
    expect(state.quantity.isZero()).toBe(true);
    expect(state.totalCost.isZero()).toBe(true);
    expect(s4(results[1]!.realizedPnl!)).toBe('-50.0000');
    expect(s4(state.realizedPnl)).toBe('-50.0000');
  });

  it('validates split direction and ratio sign', () => {
    const { state } = replay([buy('b1', '2025-01-01', '5', '10')]);
    expect(() => applyEvent(state, { id: 'x', date: '2025-02-01', type: 'SPLIT', ratioNew: '1', ratioOld: '2' })).toThrow(
      expect.objectContaining({ code: 'INVALID_RATIO' }),
    );
    expect(() => applyEvent(state, { id: 'x', date: '2025-02-01', type: 'REVERSE_SPLIT', ratioNew: '2', ratioOld: '1' })).toThrow(LedgerError);
    expect(() => applyEvent(state, { id: 'x', date: '2025-02-01', type: 'BONUS', ratioNew: '0', ratioOld: '1' })).toThrow(LedgerError);
  });

  it('rights subscription is a buy at the subscription price', () => {
    const { state, results } = replay([
      buy('b1', '2025-01-01', '100', '50'),
      { id: 'r1', date: '2025-03-01', type: 'RIGHTS_SUBSCRIPTION', quantity: '20', price: '10', fees: '1.50' },
    ]);
    expect(s4(results[1]!.costAdded)).toBe('201.5000');
    expect(s4(state.totalCost)).toBe('5201.5000');
    expect(state.lots[1]!.origin).toBe('RIGHTS');
  });

  it('transfers carry cost in and out without realizing P&L', () => {
    const { state, results } = replay([
      { id: 'ti', date: '2025-01-10', type: 'TRANSFER_IN', quantity: '100', totalCost: '9000', acquiredDate: '2023-05-01' },
      { id: 'to', date: '2025-01-20', type: 'TRANSFER_OUT', quantity: '40' },
    ]);
    expect(state.lots[0]!.holdingPeriodStart).toBe('2023-05-01');
    expect(s4(results[1]!.costRemoved)).toBe('3600.0000');
    expect(results[1]!.realizedPnl).toBeNull();
    expect(results[1]!.proceeds).toBeNull();
    expect(state.realizedPnl.isZero()).toBe(true);
    expect(s4(state.totalCost)).toBe('5400.0000');
  });

  it('orderLedgerEvents: by date, corporate actions first, then sequence, stable', () => {
    const evs: LedgerEvent[] = [
      sell('s', '2025-02-01', '1', '1'),
      { ...buy('b2', '2025-02-01', '1', '1'), sequence: 2 },
      { id: 'ca', date: '2025-02-01', type: 'BONUS', ratioNew: '1', ratioOld: '10' },
      buy('b0', '2025-01-01', '1', '1'),
    ];
    expect(orderLedgerEvents(evs).map((e) => e.id)).toEqual(['b0', 'ca', 's', 'b2']);
  });
});

// ---------- property tests ----------

type Op =
  | { k: 'BUY'; q: number; paisa: number; fee: number }
  | { k: 'SELL'; pct: number; paisa: number; fee: number }
  | { k: 'BONUS'; n: number; m: number }
  | { k: 'SPLIT'; a: number; b: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ k: fc.constant('BUY' as const), q: fc.integer({ min: 1, max: 5000 }), paisa: fc.integer({ min: 1, max: 500_000 }), fee: fc.integer({ min: 0, max: 50_000 }) }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('SELL' as const), pct: fc.integer({ min: 1, max: 100 }), paisa: fc.integer({ min: 1, max: 500_000 }), fee: fc.integer({ min: 0, max: 50_000 }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('BONUS' as const), n: fc.integer({ min: 1, max: 5 }), m: fc.integer({ min: 1, max: 20 }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('SPLIT' as const), a: fc.integer({ min: 1, max: 5 }), b: fc.integer({ min: 1, max: 5 }) }).filter((r) => r.a !== r.b) },
);

const paisa = (n: number) => d(n.toString()).div(100);

/** Turn random ops into a valid event list (sells sized from the running quantity). Optionally close out. */
function buildEvents(ops: Op[], closeOut: boolean): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  let state: LedgerState = createLedgerState();
  let day = 0;
  const date = () => `2025-${String(1 + Math.floor(day / 28)).padStart(2, '0')}-${String(1 + (day % 28)).padStart(2, '0')}`;
  const push = (e: LedgerEvent) => {
    state = applyEvent(state, e).state;
    events.push(e);
  };
  ops.slice(0, 300).forEach((op, i) => {
    day = i;
    const id = `e${i}`;
    if (op.k === 'BUY') push({ id, date: date(), type: 'BUY', quantity: op.q.toString(), price: paisa(op.paisa), fees: paisa(op.fee) });
    else if (op.k === 'SELL') {
      if (state.quantity.isZero()) return;
      const q = state.quantity.times(op.pct).div(100).ceil();
      push({ id, date: date(), type: 'SELL', quantity: q, price: paisa(op.paisa), fees: paisa(op.fee) });
    } else if (op.k === 'BONUS') push({ id, date: date(), type: 'BONUS', ratioNew: op.n.toString(), ratioOld: op.m.toString() });
    else push({ id, date: date(), type: op.a > op.b ? 'SPLIT' : 'REVERSE_SPLIT', ratioNew: op.a.toString(), ratioOld: op.b.toString() });
  });
  if (closeOut && state.quantity.gt(0)) {
    day = 300;
    push({ id: 'close', date: '2025-12-31', type: 'SELL', quantity: state.quantity, price: '123.45', fees: '7.89' });
  }
  return events;
}

const methods: CostBasisMethod[] = ['WEIGHTED_AVERAGE', 'FIFO'];

describe('ledger properties', () => {
  it('replay(events) == fold(applyEvent) and replay(prefix) + incremental == replay(all)', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), fc.nat(), fc.constantFrom(...methods), (ops, cut, method) => {
        const events = buildEvents(ops, false);
        const full = replay(events, method);
        const folded = events.reduce((s, e) => applyEvent(s, e, method).state, createLedgerState());
        expect(JSON.stringify(folded)).toBe(JSON.stringify(full.state));
        const k = events.length === 0 ? 0 : cut % (events.length + 1);
        let inc = replay(events.slice(0, k), method).state;
        for (const e of events.slice(k)) inc = applyEvent(inc, e, method).state;
        expect(JSON.stringify(inc)).toBe(JSON.stringify(full.state));
      }),
      { numRuns: 200 },
    );
  });

  it('invariants hold after every event: qty ≥ 0, Σ lot qty = qty, FIFO Σ lot cost = totalCost, cost ≥ 0', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), fc.constantFrom(...methods), (ops, method) => {
        const events = buildEvents(ops, false);
        let s = createLedgerState();
        for (const e of events) {
          s = applyEvent(s, e, method).state;
          expect(s.quantity.isNeg()).toBe(false);
          expect(s.totalCost.isNeg()).toBe(false);
          expect(sum(s.lots.map((l) => l.remainingQty)).eq(s.quantity)).toBe(true);
          if (method === 'FIFO') expect(sum(s.lots.map((l) => l.remainingCost)).eq(s.totalCost)).toBe(true);
          if (s.quantity.isZero()) expect(s.totalCost.isZero()).toBe(true);
          expect(s.totalCost.decimalPlaces()).toBeLessThanOrEqual(4);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a fully closed position: qty 0, cost 0, and total realized is method-independent (= Σ proceeds − Σ cost in)', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
        const events = buildEvents(ops, true);
        const wac = replay(events, 'WEIGHTED_AVERAGE');
        const fifo = replay(events, 'FIFO');
        for (const r of [wac, fifo]) {
          expect(r.state.quantity.isZero()).toBe(true);
          expect(r.state.totalCost.isZero()).toBe(true);
          expect(r.state.lots).toHaveLength(0);
        }
        const cashIn = sum(wac.results.map((r) => r.proceeds ?? d('0')));
        const costIn = sum(wac.results.map((r) => r.costAdded));
        expect(wac.state.realizedPnl.eq(fifo.state.realizedPnl)).toBe(true);
        expect(wac.state.realizedPnl.eq(cashIn.minus(costIn))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('bonus and split preserve totalCost (while shares remain) and never change realized', () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 1, max: 9 }),
        (ops, a, b) => {
          const events = buildEvents(ops, false);
          for (const method of methods) {
            const st = replay(events, method).state;
            const caType = a === b ? 'BONUS' : a > b ? 'SPLIT' : 'REVERSE_SPLIT';
            const ca: LedgerEvent = { id: 'ca', date: '2026-01-01', type: caType, ratioNew: a.toString(), ratioOld: b.toString() };
            const after = applyEvent(st, ca, method);
            if (after.state.quantity.gt(0)) {
              expect(after.state.totalCost.eq(st.totalCost)).toBe(true);
              expect(after.state.realizedPnl.eq(st.realizedPnl)).toBe(true);
            } else {
              expect(after.state.realizedPnl.eq(st.realizedPnl.minus(st.totalCost))).toBe(true);
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
