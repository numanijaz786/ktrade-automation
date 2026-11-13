/**
 * Cost-basis engine (docs/06 §3–4, §7). Pure functions over the ordered ledger of one (portfolio, symbol).
 *
 * WEIGHTED_AVERAGE (default):
 *   BUY  q@p, fees f:  totalCost += round4(q·p + f); qty += q
 *   SELL q@p, fees f:  costRemoved = round4(totalCost × q / qty); realized = (round4(q·p) − f) − costRemoved
 *                      when the sell closes the position costRemoved = totalCost (residue → realized)
 * FIFO: costRemoved is taken from the oldest lots first; holding totalCost = Σ open lot costs.
 *
 * Lots are ALWAYS maintained and consumed FIFO (for holding periods and the FIFO comparison view),
 * regardless of the method used for the holding's totalCost.
 */
import { type Decimal, type DecimalInput, d, MONEY_DP, ONE, roundMoney, roundPrice, sum, ZERO } from '../decimal.js';
import { assertIsoDate } from '../fees/isoDate.js';
import {
  type CostBasisMethod,
  type HoldingLotOrigin,
  type HoldingLotState,
  type LedgerBonusEvent,
  type LedgerEvent,
  type LedgerEventResult,
  type LedgerOptions,
  type LedgerSplitEvent,
  type LedgerState,
  type LotChange,
  LedgerError,
  LedgerOversellError,
} from './types.js';

export const EMPTY_LEDGER_STATE: LedgerState = Object.freeze({
  quantity: ZERO,
  totalCost: ZERO,
  avgCost: ZERO,
  realizedPnl: ZERO,
  lots: Object.freeze([]) as readonly HoldingLotState[],
  firstAcquiredDate: null,
  lastEventDate: null,
});

export function createLedgerState(): LedgerState {
  return EMPTY_LEDGER_STATE;
}

export interface LedgerStep {
  state: LedgerState;
  result: LedgerEventResult;
}

export interface LedgerReplayResult {
  state: LedgerState;
  results: LedgerEventResult[];
}

const avgOf = (totalCost: Decimal, qty: Decimal): Decimal => (qty.isZero() ? ZERO : roundPrice(totalCost.div(qty)));

function quantityOf(value: DecimalInput, eventId: string): Decimal {
  const q = d(value);
  if (!q.gt(ZERO)) throw new LedgerError('INVALID_QUANTITY', `Event ${eventId}: quantity must be > 0`, eventId);
  if (q.decimalPlaces() > MONEY_DP) {
    throw new LedgerError('INVALID_QUANTITY', `Event ${eventId}: quantity has more than ${MONEY_DP} dp`, eventId);
  }
  return q;
}

function nonNegative(value: DecimalInput | undefined, eventId: string, code: 'INVALID_PRICE' | 'INVALID_FEES' | 'INVALID_COST'): Decimal {
  const v = value === undefined ? ZERO : d(value);
  if (v.isNeg()) throw new LedgerError(code, `Event ${eventId}: ${code.slice(8).toLowerCase()} must be ≥ 0`, eventId);
  return v;
}

function makeLot(
  lotId: string,
  eventId: string,
  date: string,
  holdingPeriodStart: string,
  origin: HoldingLotOrigin,
  qty: Decimal,
  cost: Decimal,
): HoldingLotState {
  return {
    lotId,
    openEventId: eventId,
    openDate: date,
    holdingPeriodStart,
    origin,
    originalQty: qty,
    remainingQty: qty,
    remainingCost: cost,
    unitCost: avgOf(cost, qty),
  };
}

/** Consume `qty` shares from lots oldest-first. Partial lots release cost proportionally (4 dp). */
function consumeLots(
  lots: readonly HoldingLotState[],
  qty: Decimal,
): { lots: HoldingLotState[]; cost: Decimal; changes: LotChange[] } {
  let need = qty;
  let cost = ZERO;
  const out: HoldingLotState[] = [];
  const changes: LotChange[] = [];
  for (const lot of lots) {
    if (need.isZero()) {
      out.push(lot);
      continue;
    }
    if (need.gte(lot.remainingQty)) {
      need = need.minus(lot.remainingQty);
      cost = cost.plus(lot.remainingCost);
      changes.push({
        lotId: lot.lotId,
        kind: 'CLOSED',
        quantityDelta: lot.remainingQty.neg(),
        costDelta: lot.remainingCost.neg(),
        remainingQtyAfter: ZERO,
        remainingCostAfter: ZERO,
      });
      continue;
    }
    const take = need;
    const takeCost = roundMoney(lot.remainingCost.times(take).div(lot.remainingQty));
    const remainingQty = lot.remainingQty.minus(take);
    const remainingCost = lot.remainingCost.minus(takeCost);
    need = ZERO;
    cost = cost.plus(takeCost);
    out.push({ ...lot, remainingQty, remainingCost, unitCost: avgOf(remainingCost, remainingQty) });
    changes.push({
      lotId: lot.lotId,
      kind: 'REDUCED',
      quantityDelta: take.neg(),
      costDelta: takeCost.neg(),
      remainingQtyAfter: remainingQty,
      remainingCostAfter: remainingCost,
    });
  }
  if (!need.isZero()) throw new Error('Lot quantities out of sync with holding quantity'); // invariant
  return { lots: out, cost, changes };
}

/**
 * Integer allocation by largest remainder: floors each exact share, then hands the leftover units
 * (so the parts sum to `total`) to the largest fractional parts, ties to the older lot.
 */
function allocateLargestRemainder(exacts: readonly Decimal[], total: Decimal): Decimal[] {
  const parts = exacts.map((e) => e.floor());
  let leftover = total.minus(sum(parts));
  const order = exacts
    .map((e, i) => ({ i, frac: e.minus(e.floor()) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  for (const { i } of order) {
    if (!leftover.gt(ZERO)) break;
    parts[i] = (parts[i] as Decimal).plus(ONE);
    leftover = leftover.minus(ONE);
  }
  return parts;
}

function ratioOf(event: LedgerBonusEvent | LedgerSplitEvent): { n: Decimal; m: Decimal } {
  const n = d(event.ratioNew);
  const m = d(event.ratioOld);
  if (!n.gt(ZERO) || !m.gt(ZERO)) {
    throw new LedgerError('INVALID_RATIO', `Event ${event.id}: ratio terms must be > 0`, event.id);
  }
  if (event.type === 'SPLIT' && !n.gt(m)) {
    throw new LedgerError('INVALID_RATIO', `Event ${event.id}: SPLIT a:b requires a > b`, event.id);
  }
  if (event.type === 'REVERSE_SPLIT' && !n.lt(m)) {
    throw new LedgerError('INVALID_RATIO', `Event ${event.id}: REVERSE_SPLIT a:b requires a < b`, event.id);
  }
  return { n, m };
}

interface Draft {
  quantity: Decimal;
  totalCost: Decimal;
  realizedDelta: Decimal | null;
  lots: readonly HoldingLotState[];
  grossAmount: Decimal | null;
  costAdded: Decimal;
  costRemoved: Decimal;
  proceeds: Decimal | null;
  fractionalQty: Decimal | null;
  lotChanges: LotChange[];
  acquired: boolean;
}

/** Apply one ledger event. Returns the new state and the per-event audit result. Never mutates `state`. */
export function applyEvent(
  state: LedgerState,
  event: LedgerEvent,
  method: CostBasisMethod = 'WEIGHTED_AVERAGE',
  options: LedgerOptions = {},
): LedgerStep {
  if (method !== 'WEIGHTED_AVERAGE' && method !== 'FIFO') throw new RangeError(`Unknown cost-basis method ${String(method)}`);
  assertIsoDate(event.date, `event ${event.id} date`);
  if (state.lastEventDate !== null && event.date < state.lastEventDate) {
    throw new LedgerError(
      'OUT_OF_ORDER',
      `Event ${event.id} dated ${event.date} precedes last posted event (${state.lastEventDate}); replay instead`,
      event.id,
    );
  }

  const base: Draft = {
    quantity: state.quantity,
    totalCost: state.totalCost,
    realizedDelta: null,
    lots: state.lots,
    grossAmount: null,
    costAdded: ZERO,
    costRemoved: ZERO,
    proceeds: null,
    fractionalQty: null,
    lotChanges: [],
    acquired: false,
  };
  let draft: Draft;

  switch (event.type) {
    case 'BUY':
    case 'RIGHTS_SUBSCRIPTION': {
      const q = quantityOf(event.quantity, event.id);
      const p = nonNegative(event.price, event.id, 'INVALID_PRICE');
      const f = nonNegative(event.fees, event.id, 'INVALID_FEES');
      const gross = roundMoney(q.times(p));
      const cost = roundMoney(q.times(p).plus(f));
      const lot = makeLot(event.id, event.id, event.date, event.date, event.type === 'BUY' ? 'PURCHASE' : 'RIGHTS', q, cost);
      draft = {
        ...base,
        quantity: state.quantity.plus(q),
        totalCost: state.totalCost.plus(cost),
        lots: [...state.lots, lot],
        grossAmount: gross,
        costAdded: cost,
        lotChanges: [opened(lot)],
        acquired: true,
      };
      break;
    }
    case 'TRANSFER_IN': {
      const q = quantityOf(event.quantity, event.id);
      const cost = roundMoney(nonNegative(event.totalCost, event.id, 'INVALID_COST'));
      const hp = event.acquiredDate === undefined ? event.date : assertIsoDate(event.acquiredDate, 'acquiredDate');
      const lot = makeLot(event.id, event.id, event.date, hp, 'TRANSFER_IN', q, cost);
      draft = {
        ...base,
        quantity: state.quantity.plus(q),
        totalCost: state.totalCost.plus(cost),
        lots: [...state.lots, lot],
        costAdded: cost,
        lotChanges: [opened(lot)],
        acquired: true,
      };
      break;
    }
    case 'SELL':
    case 'TRANSFER_OUT': {
      const q = quantityOf(event.quantity, event.id);
      if (q.gt(state.quantity)) throw new LedgerOversellError(event.id, q, state.quantity);
      const consumed = consumeLots(state.lots, q);
      const closes = q.eq(state.quantity);
      let costRemoved: Decimal;
      if (closes) costRemoved = state.totalCost;
      else if (method === 'FIFO') costRemoved = consumed.cost;
      else costRemoved = roundMoney(state.totalCost.times(q).div(state.quantity));
      draft = {
        ...base,
        quantity: state.quantity.minus(q),
        totalCost: closes ? ZERO : state.totalCost.minus(costRemoved),
        lots: consumed.lots,
        costRemoved,
        lotChanges: consumed.changes,
      };
      if (event.type === 'SELL') {
        const p = nonNegative(event.price, event.id, 'INVALID_PRICE');
        const f = nonNegative(event.fees, event.id, 'INVALID_FEES');
        const gross = roundMoney(q.times(p));
        const proceeds = gross.minus(f);
        draft.grossAmount = gross;
        draft.proceeds = proceeds;
        draft.realizedDelta = proceeds.minus(costRemoved);
      }
      break;
    }
    case 'BONUS':
      draft = applyBonus(state, event, base, options);
      break;
    case 'SPLIT':
    case 'REVERSE_SPLIT':
      draft = applySplit(state, event, base);
      break;
  }

  const realizedPnl = draft.realizedDelta === null ? state.realizedPnl : state.realizedPnl.plus(draft.realizedDelta);
  const next: LedgerState = {
    quantity: draft.quantity,
    totalCost: draft.totalCost,
    avgCost: avgOf(draft.totalCost, draft.quantity),
    realizedPnl,
    lots: draft.lots,
    firstAcquiredDate: draft.quantity.isZero()
      ? null
      : (state.firstAcquiredDate ?? (draft.acquired ? event.date : null)),
    lastEventDate: event.date,
  };
  const result: LedgerEventResult = {
    eventId: event.id,
    type: event.type,
    date: event.date,
    quantityBefore: state.quantity,
    quantityAfter: next.quantity,
    totalCostBefore: state.totalCost,
    totalCostAfter: next.totalCost,
    avgCostBefore: state.avgCost,
    avgCostAfter: next.avgCost,
    grossAmount: draft.grossAmount,
    costAdded: draft.costAdded,
    costRemoved: draft.costRemoved,
    proceeds: draft.proceeds,
    realizedPnl: draft.realizedDelta,
    fractionalQty: draft.fractionalQty,
    lotChanges: draft.lotChanges,
  };
  return { state: next, result };
}

function opened(lot: HoldingLotState): LotChange {
  return {
    lotId: lot.lotId,
    kind: 'OPENED',
    quantityDelta: lot.remainingQty,
    costDelta: lot.remainingCost,
    remainingQtyAfter: lot.remainingQty,
    remainingCostAfter: lot.remainingCost,
  };
}

/** Bonus n-for-m: qty += floor(qty × n/m); totalCost unchanged; bonus lots at cost 0. */
function applyBonus(state: LedgerState, event: LedgerBonusEvent, base: Draft, options: LedgerOptions): Draft {
  const { n, m } = ratioOf(event);
  const exactTotal = state.quantity.times(n).div(m);
  const bonusQty = exactTotal.floor();
  const fractionalQty = exactTotal.minus(bonusQty);
  if (bonusQty.isZero()) return { ...base, fractionalQty };

  const parts = allocateLargestRemainder(
    state.lots.map((l) => l.remainingQty.times(n).div(m)),
    bonusQty,
  );
  const dating = options.bonusLotDating ?? 'ORIGINAL_LOT_DATE';
  const lots: HoldingLotState[] = [];
  const appended: HoldingLotState[] = [];
  const changes: LotChange[] = [];
  state.lots.forEach((parent, i) => {
    lots.push(parent);
    const qty = parts[i] as Decimal;
    if (qty.isZero()) return;
    const hp = dating === 'ORIGINAL_LOT_DATE' ? parent.holdingPeriodStart : event.date;
    const lot = makeLot(`${event.id}#${parent.lotId}`, event.id, event.date, hp, 'BONUS', qty, ZERO);
    (dating === 'ORIGINAL_LOT_DATE' ? lots : appended).push(lot);
    changes.push(opened(lot));
  });
  return {
    ...base,
    quantity: state.quantity.plus(bonusQty),
    lots: [...lots, ...appended],
    fractionalQty,
    lotChanges: changes,
  };
}

/**
 * Split / reverse split a:b: qty → floor(qty × a/b); totalCost unchanged; lots rescaled proportionally
 * (integer shares by largest remainder). A lot rescaled to 0 shares hands its cost to the next surviving
 * lot so no cost is orphaned. If the whole position rounds to 0 shares, the remaining cost is written off
 * to realized P&L (any cash-in-lieu is booked separately).
 */
function applySplit(state: LedgerState, event: LedgerSplitEvent, base: Draft): Draft {
  const { n, m } = ratioOf(event);
  const exactTotal = state.quantity.times(n).div(m);
  const newQty = exactTotal.floor();
  const fractionalQty = exactTotal.minus(newQty);
  if (state.quantity.isZero()) return { ...base, fractionalQty };

  if (newQty.isZero()) {
    const changes = state.lots.map<LotChange>((l) => ({
      lotId: l.lotId,
      kind: 'CLOSED',
      quantityDelta: l.remainingQty.neg(),
      costDelta: l.remainingCost.neg(),
      remainingQtyAfter: ZERO,
      remainingCostAfter: ZERO,
    }));
    return {
      ...base,
      quantity: ZERO,
      totalCost: ZERO,
      lots: [],
      costRemoved: state.totalCost,
      realizedDelta: state.totalCost.neg(),
      fractionalQty,
      lotChanges: changes,
    };
  }

  const parts = allocateLargestRemainder(
    state.lots.map((l) => l.remainingQty.times(n).div(m)),
    newQty,
  );
  // Move cost of lots that vanish onto the next surviving lot (or the previous one, for the last lots).
  const costs = state.lots.map((l) => l.remainingCost);
  let carry = ZERO;
  for (let i = 0; i < costs.length; i++) {
    if ((parts[i] as Decimal).isZero()) {
      carry = carry.plus(costs[i] as Decimal);
      costs[i] = ZERO;
    } else if (!carry.isZero()) {
      costs[i] = (costs[i] as Decimal).plus(carry);
      carry = ZERO;
    }
  }
  if (!carry.isZero()) {
    for (let i = costs.length - 1; i >= 0; i--) {
      if (!(parts[i] as Decimal).isZero()) {
        costs[i] = (costs[i] as Decimal).plus(carry);
        break;
      }
    }
  }

  const lots: HoldingLotState[] = [];
  const changes: LotChange[] = [];
  state.lots.forEach((lot, i) => {
    const qty = parts[i] as Decimal;
    const cost = costs[i] as Decimal;
    if (qty.isZero()) {
      changes.push({
        lotId: lot.lotId,
        kind: 'CLOSED',
        quantityDelta: lot.remainingQty.neg(),
        costDelta: lot.remainingCost.neg(),
        remainingQtyAfter: ZERO,
        remainingCostAfter: ZERO,
      });
      return;
    }
    lots.push({
      ...lot,
      originalQty: roundMoney(lot.originalQty.times(n).div(m)),
      remainingQty: qty,
      remainingCost: cost,
      unitCost: avgOf(cost, qty),
    });
    changes.push({
      lotId: lot.lotId,
      kind: 'ADJUSTED',
      quantityDelta: qty.minus(lot.remainingQty),
      costDelta: cost.minus(lot.remainingCost),
      remainingQtyAfter: qty,
      remainingCostAfter: cost,
    });
  });
  return { ...base, quantity: newQty, lots, fractionalQty, lotChanges: changes };
}

/** Rebuild state from scratch over an ordered ledger. replay(events) ≡ events.reduce(applyEvent). */
export function replay(
  events: readonly LedgerEvent[],
  method: CostBasisMethod = 'WEIGHTED_AVERAGE',
  options: LedgerOptions = {},
): LedgerReplayResult {
  let state = createLedgerState();
  const results: LedgerEventResult[] = [];
  for (const event of events) {
    const step = applyEvent(state, event, method, options);
    state = step.state;
    results.push(step.result);
  }
  return { state, results };
}

const CORPORATE_ACTIONS: ReadonlySet<LedgerEvent['type']> = new Set(['BONUS', 'SPLIT', 'REVERSE_SPLIT']);

/**
 * Order events per docs/06 §7: by date; within a date corporate actions first, then trades/transfers
 * by `sequence` (execution time rank / contract-note line order). Stable for equal keys.
 */
export function orderLedgerEvents<E extends LedgerEvent>(events: readonly E[]): E[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.date !== b.e.date) return a.e.date < b.e.date ? -1 : 1;
      const ca = CORPORATE_ACTIONS.has(a.e.type) ? 0 : 1;
      const cb = CORPORATE_ACTIONS.has(b.e.type) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const sa = a.e.sequence;
      const sb = b.e.sequence;
      if (sa !== undefined && sb !== undefined && sa !== sb) return sa - sb;
      return a.i - b.i;
    })
    .map(({ e }) => e);
}
