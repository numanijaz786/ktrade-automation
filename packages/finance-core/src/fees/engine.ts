/**
 * Fee engine (docs/06 §2). Pure: schedule + trade → per-component breakdown.
 *
 * Rules:
 * - Each component is rounded to paisa (0.01 PKR) with a configurable mode (default HALF_UP).
 * - PCT_OF_COMPONENT is computed on the *rounded* amount of its base component
 *   (worked example: SST = 15% × 40.50 = 6.075 → 6.08).
 * - minAmount floors a computed component (not applied to AT_ACTUAL or a waived day-trade leg).
 * - Day trade: commission is charged on one side only; on the second leg COMMISSION = 0 and
 *   everything derived from it (SST) is therefore 0 as well.
 * - AT_ACTUAL components are estimated as 0 and flagged `atActual: true`; anything derived from an
 *   AT_ACTUAL base is flagged too, because it is equally unknown until the contract note arrives.
 */
import {
  type Decimal,
  type DecimalInput,
  type RoundingMode,
  d,
  max,
  roundMoney,
  roundPaisa,
  sum,
  ZERO,
} from '../decimal.js';
import { assertIsoDate, isWithinEffective } from './isoDate.js';
import {
  type FeeComponent,
  type FeeMethod,
  type FeeScheduleItemSpec,
  type FeeScheduleSpec,
  type FeeTradeSide,
} from './types.js';

export class FeeScheduleError extends Error {
  constructor(
    public readonly code:
      | 'MISSING_BASE_COMPONENT'
      | 'CYCLIC_COMPONENTS'
      | 'DUPLICATE_COMPONENT'
      | 'MISSING_PARAMETER'
      | 'INVALID_PARAMETER'
      | 'NO_SCHEDULE'
      | 'AMBIGUOUS_SCHEDULE',
    message: string,
  ) {
    super(message);
    this.name = 'FeeScheduleError';
  }
}

export interface FeeTradeInput {
  side: FeeTradeSide;
  quantity: DecimalInput;
  price: DecimalInput;
  /** Second leg of a same-day round trip: commission (and SST on it) is not charged again. */
  isDayTradeSecondLeg?: boolean;
}

export interface FeeComputeOptions {
  /** Paisa rounding mode per component. Default HALF_UP (docs/06 §1). */
  rounding?: RoundingMode;
}

export interface FeeLine {
  component: FeeComponent;
  method: FeeMethod;
  /** Paisa-rounded amount (≥ 0). */
  amount: Decimal;
  /** true → cost basis / proceeds; false → tax. */
  capitalised: boolean;
  source: 'ESTIMATED';
  /** Present when the true amount is only known from the contract note. */
  atActual?: true;
  /** Present when this component was zeroed by the day-trade one-side rule. */
  dayTradeWaived?: true;
}

export interface FeeBreakdown {
  side: FeeTradeSide;
  quantity: Decimal;
  price: Decimal;
  /** qty × price at ledger precision (4 dp). */
  grossValue: Decimal;
  /** Ordered by sortOrder, then component name. */
  lines: FeeLine[];
  /** Σ capitalised components: added to cost on BUY, deducted from proceeds on SELL. */
  capitalisedFees: Decimal;
  /** Σ non-capitalised components (never part of cost basis). */
  taxes: Decimal;
  /** capitalisedFees + taxes. */
  total: Decimal;
  /** true if any line is AT_ACTUAL (estimate incomplete — show a warning). */
  hasAtActual: boolean;
  /** Signed cash impact: BUY −(gross + fees + taxes); SELL gross − fees − taxes. */
  netAmount: Decimal;
}

const appliesToSide = (item: FeeScheduleItemSpec, side: FeeTradeSide): boolean =>
  item.appliesTo === side || item.appliesTo === 'BOTH';

/** One effective item per component; a side-specific item overrides a BOTH item. */
function effectiveItems(
  items: readonly FeeScheduleItemSpec[],
  side: FeeTradeSide,
): Map<FeeComponent, FeeScheduleItemSpec> {
  const out = new Map<FeeComponent, FeeScheduleItemSpec>();
  for (const item of items) {
    if (!appliesToSide(item, side)) continue;
    const existing = out.get(item.component);
    if (!existing) {
      out.set(item.component, item);
      continue;
    }
    const existingSpecific = existing.appliesTo === side;
    const itemSpecific = item.appliesTo === side;
    if (existingSpecific === itemSpecific) {
      throw new FeeScheduleError(
        'DUPLICATE_COMPONENT',
        `Fee schedule has two ${item.appliesTo} items for ${item.component} on ${side}`,
      );
    }
    if (itemSpecific) out.set(item.component, item);
  }
  return out;
}

function req(item: FeeScheduleItemSpec, field: 'rate' | 'perShare' | 'fixedAmount'): Decimal {
  const v = item[field];
  if (v === null || v === undefined) {
    throw new FeeScheduleError('MISSING_PARAMETER', `${item.component} (${item.method}) requires ${field}`);
  }
  const dv = d(v);
  if (dv.isNeg()) throw new FeeScheduleError('INVALID_PARAMETER', `${item.component}.${field} must be ≥ 0`);
  return dv;
}

/** Topological order honouring baseComponent; throws on missing bases or cycles. */
function evaluationOrder(items: Map<FeeComponent, FeeScheduleItemSpec>): FeeComponent[] {
  const order: FeeComponent[] = [];
  const state = new Map<FeeComponent, 'visiting' | 'done'>();
  const visit = (c: FeeComponent, path: FeeComponent[]): void => {
    const st = state.get(c);
    if (st === 'done') return;
    if (st === 'visiting') {
      throw new FeeScheduleError('CYCLIC_COMPONENTS', `Cyclic fee components: ${[...path, c].join(' → ')}`);
    }
    state.set(c, 'visiting');
    const item = items.get(c);
    if (item && item.method === 'PCT_OF_COMPONENT') {
      const base = item.baseComponent;
      if (!base) {
        throw new FeeScheduleError('MISSING_PARAMETER', `${c} (PCT_OF_COMPONENT) requires baseComponent`);
      }
      if (!items.has(base)) {
        throw new FeeScheduleError(
          'MISSING_BASE_COMPONENT',
          `${c} is based on ${base}, which does not apply to this trade`,
        );
      }
      visit(base, [...path, c]);
    }
    state.set(c, 'done');
    order.push(c);
  };
  for (const c of items.keys()) visit(c, []);
  return order;
}

/** Compute the estimated fee breakdown for one trade (one fill / contract-note line). */
export function computeTradeFees(
  schedule: FeeScheduleSpec | readonly FeeScheduleItemSpec[],
  trade: FeeTradeInput,
  options: FeeComputeOptions = {},
): FeeBreakdown {
  const mode = options.rounding ?? 'HALF_UP';
  const quantity = d(trade.quantity);
  const price = d(trade.price);
  if (!quantity.gt(ZERO)) throw new RangeError('Trade quantity must be > 0');
  if (price.isNeg()) throw new RangeError('Trade price must be ≥ 0');
  const value = quantity.times(price);
  const itemList = 'items' in schedule ? schedule.items : schedule;
  const items = effectiveItems(itemList, trade.side);
  const order = evaluationOrder(items);

  const computed = new Map<FeeComponent, FeeLine>();
  for (const component of order) {
    const item = items.get(component);
    if (!item) continue; // unreachable: order only contains effective components
    const line: FeeLine = {
      component,
      method: item.method,
      amount: ZERO,
      capitalised: item.capitalise,
      source: 'ESTIMATED',
    };
    let raw: Decimal;
    let applyMin = true;
    switch (item.method) {
      case 'PCT_OF_VALUE':
        raw = value.times(req(item, 'rate'));
        break;
      case 'PER_SHARE':
        raw = quantity.times(req(item, 'perShare'));
        break;
      case 'MAX_OF_PCT_OR_PER_SHARE':
        raw = max(value.times(req(item, 'rate')), quantity.times(req(item, 'perShare')));
        break;
      case 'FIXED':
        raw = req(item, 'fixedAmount');
        break;
      case 'PCT_OF_COMPONENT': {
        const base = computed.get(item.baseComponent as FeeComponent);
        if (!base) throw new FeeScheduleError('MISSING_BASE_COMPONENT', `${component}: base not computed`);
        raw = base.amount.times(req(item, 'rate'));
        if (base.atActual) line.atActual = true;
        if (base.dayTradeWaived) {
          line.dayTradeWaived = true;
          applyMin = false;
        }
        break;
      }
      case 'AT_ACTUAL':
        raw = ZERO;
        line.atActual = true;
        applyMin = false;
        break;
    }
    if (line.atActual) applyMin = false;
    if (component === 'COMMISSION' && trade.isDayTradeSecondLeg) {
      raw = ZERO;
      line.dayTradeWaived = true;
      applyMin = false;
    }
    if (applyMin && item.minAmount !== null && item.minAmount !== undefined) {
      raw = max(raw, d(item.minAmount));
    }
    line.amount = roundPaisa(raw, mode);
    computed.set(component, line);
  }

  const lines = [...computed.values()].sort((a, b) => {
    const sa = items.get(a.component)?.sortOrder ?? 0;
    const sb = items.get(b.component)?.sortOrder ?? 0;
    return sa !== sb ? sa - sb : a.component < b.component ? -1 : a.component > b.component ? 1 : 0;
  });
  const capitalisedFees = sum(lines.filter((l) => l.capitalised).map((l) => l.amount));
  const taxes = sum(lines.filter((l) => !l.capitalised).map((l) => l.amount));
  const total = capitalisedFees.plus(taxes);
  const grossValue = roundMoney(value);
  const netAmount = trade.side === 'BUY' ? grossValue.plus(total).neg() : grossValue.minus(total);
  return {
    side: trade.side,
    quantity,
    price,
    grossValue,
    lines,
    capitalisedFees,
    taxes,
    total,
    hasAtActual: lines.some((l) => l.atActual === true),
    netAmount,
  };
}

/** Pick the schedule effective on `date` (effectiveFrom ≤ date ≤ effectiveTo); latest effectiveFrom wins. */
export function selectFeeSchedule<S extends FeeScheduleSpec>(schedules: readonly S[], date: string): S {
  assertIsoDate(date);
  const candidates = schedules.filter((s) => isWithinEffective(date, s.effectiveFrom, s.effectiveTo));
  if (candidates.length === 0)
    throw new FeeScheduleError('NO_SCHEDULE', `No fee schedule effective on ${date}`);
  candidates.sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0,
  );
  const [best, second] = candidates;
  if (second && second.effectiveFrom === best?.effectiveFrom && second.brokerCode === best.brokerCode) {
    throw new FeeScheduleError(
      'AMBIGUOUS_SCHEDULE',
      `Two fee schedules effective from ${best.effectiveFrom}`,
    );
  }
  return best as S;
}

/**
 * KTrade's published schedule (docs/06 §2):
 * commission max(0.3% × value, Rs 0.06 × qty) per side; SST 15% of commission;
 * CDC, NCCPL, SECP/PSX levies and CVT "as per actual" (estimated 0, flagged).
 */
export function ktradeDefaultSchedule(effectiveFrom: string): FeeScheduleSpec {
  assertIsoDate(effectiveFrom, 'effectiveFrom');
  const atActual = (component: FeeComponent, sortOrder: number): FeeScheduleItemSpec => ({
    component,
    appliesTo: 'BOTH',
    method: 'AT_ACTUAL',
    capitalise: true,
    sortOrder,
  });
  return {
    brokerCode: 'KTRADE',
    name: 'KTrade published schedule',
    effectiveFrom,
    effectiveTo: null,
    sourceNote: 'KTrade Commission Structure PDF',
    items: [
      {
        component: 'COMMISSION',
        appliesTo: 'BOTH',
        method: 'MAX_OF_PCT_OR_PER_SHARE',
        rate: d('0.003'),
        perShare: d('0.06'),
        capitalise: true,
        sortOrder: 10,
      },
      {
        component: 'SST_ON_COMMISSION',
        appliesTo: 'BOTH',
        method: 'PCT_OF_COMPONENT',
        rate: d('0.15'),
        baseComponent: 'COMMISSION',
        capitalise: true,
        sortOrder: 20,
      },
      atActual('CDC_CHARGES', 30),
      atActual('NCCPL_CHARGES', 40),
      atActual('SECP_LEVY', 50),
      atActual('PSX_LEVY', 60),
      atActual('CVT', 70),
    ],
  };
}
