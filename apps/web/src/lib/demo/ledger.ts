/**
 * Demo ledger: seeded fictional trades / deposits / bonus / dividends and a replay that derives
 * positions (weighted-average cost, docs/06), FIFO lots for display, cash, fees and taxes.
 * Everything is exact decimal (Dec).
 */
import { weakestSource, type CashMovementType, type DataSource, type TransactionType } from '@ktrade/shared';
import { Dec } from '../decimal';
import { estimateFees } from '../fees';
import type { CashMovement, Dividend, Lot, Transaction } from '../api/types';
import { businessDays, closeOn, DEMO_BARS, DEMO_TODAY, paisaToString } from './prices';
import { findSeed } from './universe';

export type LedgerEntry = { kind: 'txn'; txn: Transaction } | { kind: 'cash'; cash: CashMovement };

export interface Position {
  symbol: string;
  qty: Dec;
  cost: Dec;
  realized: Dec;
  lots: Lot[];
  sources: DataSource[];
  lastConfirmed: string | null;
}

export interface LedgerState {
  cash: Dec;
  deposits: Dec;
  fees: Dec;
  taxes: Dec;
  dividends: Dec;
  positions: Map<string, Position>;
}

export function emptyState(): LedgerState {
  return { cash: Dec.zero(), deposits: Dec.zero(), fees: Dec.zero(), taxes: Dec.zero(), dividends: Dec.zero(), positions: new Map() };
}

function position(state: LedgerState, symbol: string): Position {
  let p = state.positions.get(symbol);
  if (!p) {
    p = { symbol, qty: Dec.zero(), cost: Dec.zero(), realized: Dec.zero(), lots: [], sources: [], lastConfirmed: null };
    state.positions.set(symbol, p);
  }
  return p;
}

/** Apply one ledger entry in place. */
export function applyEntry(state: LedgerState, e: LedgerEntry): void {
  if (e.kind === 'cash') {
    const amt = Dec.of(e.cash.amount);
    state.cash = state.cash.add(amt);
    if (e.cash.type === 'DEPOSIT' || e.cash.type === 'WITHDRAWAL') state.deposits = state.deposits.add(amt);
    if (e.cash.type === 'DIVIDEND') state.dividends = state.dividends.add(amt);
    if (e.cash.type === 'TAX') state.taxes = state.taxes.sub(amt);
    if (e.cash.type === 'FEE') state.fees = state.fees.sub(amt);
    return;
  }
  const t = e.txn;
  const p = position(state, t.symbol);
  const qty = Dec.of(t.quantity);
  p.sources.push(t.source);
  if (t.source === 'BROKER_CONFIRMED') p.lastConfirmed = t.tradeDate;
  if (t.type === 'BUY' || t.type === 'TRANSFER_IN') {
    const totalCost = Dec.of(t.grossAmount).add(t.fees);
    p.qty = p.qty.add(qty);
    p.cost = p.cost.add(totalCost);
    p.lots.push({ id: `lot-${t.id}`, acquiredAt: t.tradeDate, quantity: qty.toString(), remainingQty: qty.toString(), unitCost: totalCost.div(qty).toFixed(4), source: t.source });
    state.cash = state.cash.add(t.netAmount);
    state.fees = state.fees.add(t.fees);
  } else if (t.type === 'BONUS_IN') {
    p.qty = p.qty.add(qty);
    p.lots.push({ id: `lot-${t.id}`, acquiredAt: t.tradeDate, quantity: qty.toString(), remainingQty: qty.toString(), unitCost: '0.0000', source: t.source });
  } else if (t.type === 'SELL' || t.type === 'TRANSFER_OUT') {
    const avg = p.qty.isZero() ? Dec.zero() : p.cost.div(p.qty);
    const costOut = avg.mul(qty).round(4);
    const proceeds = Dec.of(t.grossAmount).sub(t.fees);
    p.realized = p.realized.add(proceeds.sub(costOut));
    p.cost = p.cost.sub(costOut);
    p.qty = p.qty.sub(qty);
    if (p.qty.isZero()) p.cost = Dec.zero();
    // FIFO depletion of display lots.
    let left = qty;
    for (const lot of p.lots) {
      if (left.isZero()) break;
      const rem = Dec.of(lot.remainingQty);
      const take = Dec.min(rem, left);
      lot.remainingQty = rem.sub(take).toString();
      left = left.sub(take);
    }
    state.cash = state.cash.add(t.netAmount);
    state.fees = state.fees.add(t.fees);
  }
}

export function replay(entries: readonly LedgerEntry[], upTo?: string): LedgerState {
  const s = emptyState();
  for (const e of entries) {
    if (upTo && entryDate(e) > upTo) break;
    applyEntry(s, e);
  }
  return s;
}

export function entryDate(e: LedgerEntry): string {
  return e.kind === 'txn' ? e.txn.tradeDate : e.cash.date;
}

export function positionSource(p: Position): DataSource {
  return p.sources.length ? weakestSource(p.sources) : 'SIMULATED';
}

export function avgCost(p: Position): Dec {
  return p.qty.isZero() ? Dec.zero() : p.cost.div(p.qty);
}

// ─── Transaction factories ─────────────────────────────────────────────────

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(++seq).toString().padStart(4, '0')}`;

export function makeTrade(input: {
  portfolioId: string;
  date: string;
  type: Extract<TransactionType, 'BUY' | 'SELL'>;
  symbol: string;
  quantity: string;
  price: string;
  source?: DataSource;
  reference?: string | null;
  orderId?: string | null;
}): Transaction {
  const est = estimateFees(input.type, input.quantity, input.price);
  const gross = Dec.of(est.notional).round(2);
  const fees = Dec.of(est.totalFees);
  const net = input.type === 'BUY' ? gross.add(fees).neg() : gross.sub(fees);
  return {
    id: nextId('txn'),
    portfolioId: input.portfolioId,
    tradeDate: input.date,
    type: input.type,
    symbol: input.symbol,
    quantity: input.quantity,
    price: input.price,
    grossAmount: gross.toFixed(2),
    fees: fees.toFixed(2),
    netAmount: net.toFixed(2),
    source: input.source ?? 'SIMULATED',
    reference: input.reference ?? null,
    orderId: input.orderId ?? null,
  };
}

function cash(portfolioId: string, date: string, type: CashMovementType, amount: string, description: string, source: DataSource = 'SIMULATED'): CashMovement {
  return { id: nextId('cash'), portfolioId, date, type, amount, description, source };
}

// ─── Seed ──────────────────────────────────────────────────────────────────

export interface DemoLedgerSeed {
  entries: LedgerEntry[];
  dividends: Dividend[];
}

const DAYS = businessDays(DEMO_TODAY, DEMO_BARS);
/** Business day `n` trading days before the demo today (0 = today). */
export function daysAgo(n: number): string {
  return DAYS[Math.max(0, DAYS.length - 1 - n)];
}

function qtyFor(symbol: string, date: string, targetRs: number): { qty: string; price: string } {
  const pricePaisa = closeOn(symbol, date);
  const step = pricePaisa < 5000 ? 100 : pricePaisa < 50000 ? 10 : 5;
  const raw = Math.floor((targetRs * 100) / pricePaisa);
  const qty = Math.max(step, Math.floor(raw / step) * step);
  return { qty: String(qty), price: paisaToString(pricePaisa) };
}

function buy(pf: string, n: number, symbol: string, targetRs: number, source: DataSource = 'SIMULATED', reference: string | null = null): LedgerEntry {
  const date = daysAgo(n);
  const { qty, price } = qtyFor(symbol, date, targetRs);
  return { kind: 'txn', txn: makeTrade({ portfolioId: pf, date, type: 'BUY', symbol, quantity: qty, price, source, reference }) };
}

function sell(pf: string, n: number, symbol: string, fraction: '1' | '0.5' | '0.3', entriesSoFar: LedgerEntry[]): LedgerEntry {
  const date = daysAgo(n);
  const held = replay(entriesSoFar).positions.get(symbol)?.qty ?? Dec.zero();
  const qty = held.mul(fraction).floor(0);
  return {
    kind: 'txn',
    txn: makeTrade({ portfolioId: pf, date, type: 'SELL', symbol, quantity: qty.toString(), price: paisaToString(closeOn(symbol, date)) }),
  };
}

function dividend(
  pf: string,
  entriesSoFar: LedgerEntry[],
  symbol: string,
  exAgo: number,
  payAgo: number | null,
  perShare: string,
  status: Dividend['status'],
  source: DataSource,
): { entries: LedgerEntry[]; record: Dividend } {
  const exDate = daysAgo(exAgo);
  const eligible = replay(entriesSoFar, exDate).positions.get(symbol)?.qty ?? Dec.zero();
  const gross = eligible.mul(perShare).round(2);
  const wht = gross.mul('0.15').round(2);
  const net = gross.sub(wht);
  const record: Dividend = {
    id: nextId('div'),
    symbol,
    name: findSeed(symbol)?.name ?? symbol,
    announcementDate: daysAgo(exAgo + 12),
    exDate,
    paymentDate: payAgo === null ? null : daysAgo(payAgo),
    perShare,
    eligibleQty: eligible.toString(),
    grossAmount: gross.toFixed(2),
    whtAmount: wht.toFixed(2),
    netAmount: net.toFixed(2),
    status,
    source,
  };
  const out: LedgerEntry[] = [];
  if (payAgo !== null && (status === 'PAID' || status === 'RECONCILED')) {
    const payDate = daysAgo(payAgo);
    out.push({ kind: 'cash', cash: cash(pf, payDate, 'DIVIDEND', gross.toFixed(2), `${symbol} cash dividend Rs ${perShare}/share`, source) });
    out.push({ kind: 'cash', cash: cash(pf, payDate, 'TAX', wht.neg().toFixed(2), `${symbol} dividend withholding tax (15%)`, source === 'BROKER_CONFIRMED' ? 'BROKER_CONFIRMED' : 'ESTIMATED') });
  }
  return { entries: out, record };
}

export function seedLivePortfolio(pf: string): DemoLedgerSeed {
  const e: LedgerEntry[] = [];
  const dividends: Dividend[] = [];
  e.push({ kind: 'cash', cash: cash(pf, daysAgo(262), 'DEPOSIT', '2000000.00', 'Initial funding (demo)') });
  e.push(buy(pf, 258, 'OGDC', 300_000), buy(pf, 258, 'HUBC', 250_000), buy(pf, 257, 'MCB', 200_000));
  e.push(buy(pf, 240, 'ENGRO', 180_000), buy(pf, 238, 'LUCK', 200_000));
  e.push(buy(pf, 221, 'SYS', 150_000), buy(pf, 220, 'DGKC', 120_000));
  e.push(buy(pf, 201, 'MEBL', 200_000), buy(pf, 200, 'FFC', 150_000));
  e.push(sell(pf, 170, 'DGKC', '1', e));
  e.push({ kind: 'cash', cash: cash(pf, daysAgo(150), 'DEPOSIT', '500000.00', 'Top-up (demo)') });
  e.push(buy(pf, 141, 'PSO', 200_000), buy(pf, 140, 'EFERT', 150_000));
  {
    const date = daysAgo(120);
    const held = replay(e).positions.get('MEBL')?.qty ?? Dec.zero();
    const bonus = held.mul('0.1').floor(0);
    e.push({
      kind: 'txn',
      txn: { id: nextId('txn'), portfolioId: pf, tradeDate: date, type: 'BONUS_IN', symbol: 'MEBL', quantity: bonus.toString(), price: '0.00', grossAmount: '0.00', fees: '0.00', netAmount: '0.00', source: 'SIMULATED', reference: 'Bonus 10% (demo)', orderId: null },
    });
  }
  {
    const d = dividend(pf, e, 'OGDC', 102, 95, '4.00', 'RECONCILED', 'BROKER_CONFIRMED');
    e.push(...d.entries);
    dividends.push(d.record);
  }
  e.push(buy(pf, 80, 'TRG', 100_000), buy(pf, 79, 'PPL', 150_000));
  e.push(sell(pf, 60, 'PSO', '0.5', e));
  {
    const d = dividend(pf, e, 'MCB', 42, 35, '9.00', 'PAID', 'SIMULATED');
    e.push(...d.entries);
    dividends.push(d.record);
  }
  e.push(buy(pf, 25, 'HUBC', 100_000, 'USER_REPORTED', 'Manual entry'));
  e.push(buy(pf, 10, 'MARI', 120_000, 'BROKER_CONFIRMED', 'CN-2026-10-30-0042 (demo contract note)'));
  e.push(sell(pf, 3, 'SYS', '0.3', e));
  {
    const d = dividend(pf, e, 'HUBC', 2, null, '5.00', 'ENTITLED', 'ESTIMATED');
    dividends.push(d.record);
  }
  {
    const ffcQty = replay(e).positions.get('FFC')?.qty ?? Dec.zero();
    const gross = ffcQty.mul('7.50').round(2);
    const wht = gross.mul('0.15').round(2);
    dividends.push({
      id: nextId('div'),
      symbol: 'FFC',
      name: findSeed('FFC')?.name ?? 'FFC',
      announcementDate: daysAgo(1),
      exDate: '2026-11-24',
      paymentDate: null,
      perShare: '7.50',
      eligibleQty: ffcQty.toString(),
      grossAmount: gross.toFixed(2),
      whtAmount: wht.toFixed(2),
      netAmount: gross.sub(wht).toFixed(2),
      status: 'ANNOUNCED',
      source: 'ESTIMATED',
    });
  }
  return { entries: e, dividends };
}

export function seedPaperPortfolio(pf: string): DemoLedgerSeed {
  const e: LedgerEntry[] = [];
  e.push({ kind: 'cash', cash: cash(pf, daysAgo(125), 'DEPOSIT', '1000000.00', 'Paper starting cash') });
  e.push(buy(pf, 120, 'UBL', 200_000), buy(pf, 110, 'EFERT', 150_000), buy(pf, 90, 'SYS', 150_000));
  e.push(buy(pf, 60, 'OGDC', 120_000), buy(pf, 45, 'LUCK', 100_000));
  e.push(sell(pf, 30, 'SYS', '0.5', e));
  e.push(buy(pf, 12, 'POL', 90_000));
  return { entries: e, dividends: [] };
}

export const DEMO_DAYS = DAYS;
