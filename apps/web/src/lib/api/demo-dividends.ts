/**
 * Demo dividend engine (ADR-031), used by `DemoApiClient`. It follows the same rules as the API:
 *  - declarations are owner-entered (USER_REPORTED), dates in order, DPS > 0; locked once any entitlement is paid;
 *  - entitlement = shares settled strictly before the book-closure start (T+1 by default; the demo calendar
 *    skips weekends only — no PSX holidays);
 *  - WHT is estimated from VERIFIED dividend-WHT rates only; otherwise taxStatus NOT_CONFIGURED and WHT / net
 *    are null (the stored 0 is a placeholder, never a rate);
 *  - mark-paid REQUIRES the withholding from the payment advice; mismatches surface as `unexplainedDifference`.
 * All money arithmetic uses `Dec`.
 */
import type { DataSource, DividendPaymentStatus, TaxFilerStatus } from '@ktrade/shared';
import { Dec } from '../decimal';
import type { LedgerEntry } from '../demo/ledger';
import { ApiError, type FieldError } from './errors';
import {
  dateOrderIssue,
  dpsSchema,
  isIsoDate,
  nonNegativeMoneySchema,
  positiveMoneySchema,
  SYMBOL_RE,
} from './dividends-rules';
import type {
  DividendComputeResult,
  DividendDeclaration,
  DividendDeclarationInput,
  DividendDeclarationUpdate,
  DividendEntitlement,
  DividendMarkPaidInput,
  DividendMarkPaidResult,
  DividendTaxStatus,
  SettlementAssumption,
  TaxRate,
} from './types';

export const DEMO_SETTLEMENT_DAYS = 1;

export type DemoDeclaration = Omit<DividendDeclaration, 'locked'>;

export interface DemoEntitlementRow {
  id: string;
  dividendId: string;
  portfolioId: string;
  sharesEligible: string;
  grossAmount: string;
  /** Stored like the API's NOT NULL columns: "0" when WHT is not configured (a placeholder, never a rate). */
  whtRate: string;
  whtAmount: string;
  zakatAmount: string;
  netAmount: string;
  status: DividendPaymentStatus;
  source: DataSource;
  paidAt: string | null;
  cashMovementId: string | null;
  reconciledAt: string | null;
  updatedAt: string;
}

export interface DemoDividendState {
  declarations: DemoDeclaration[];
  entitlements: DemoEntitlementRow[];
}

export interface DemoDividendContext {
  today: string;
  nowIso: string;
  id: (prefix: string) => string;
  filerStatus: TaxFilerStatus;
  taxRates: readonly TaxRate[];
  knownSymbol: (symbol: string) => boolean;
}

const SETTLED: ReadonlySet<DividendPaymentStatus> = new Set(['PAID', 'RECONCILED']);
const ESTIMATES: ReadonlySet<DividendPaymentStatus> = new Set(['ANNOUNCED', 'ENTITLED']);
const RATE_DP = 8;
const m4 = (x: Dec) => x.round(4).toFixed(4);

// ─── errors (same codes as the API) ────────────────────────────────────────

function validation(errors: FieldError[]): ApiError {
  return new ApiError('VALIDATION_FAILED', 400, 'Validation failed', errors[0]?.message, { errors });
}
const notFound = (what: string) => new ApiError('NOT_FOUND', 404, `${what} not found`);
const locked = () =>
  new ApiError(
    'DIVIDEND_LOCKED',
    409,
    'Dividend locked',
    'This dividend has paid entitlements and can no longer be changed',
  );

function check(
  errors: FieldError[],
  path: string,
  r: { success: boolean; error?: { issues: { message: string }[] } },
) {
  if (!r.success) errors.push({ path, message: r.error?.issues[0]?.message ?? 'invalid' });
}

function checkDate(errors: FieldError[], path: string, v: string | null | undefined, required = false) {
  if (v === undefined || v === null) {
    if (required) errors.push({ path, message: 'Required' });
    return;
  }
  if (!isIsoDate(v)) errors.push({ path, message: 'must be a calendar date YYYY-MM-DD' });
}

// ─── tax ───────────────────────────────────────────────────────────────────

type WhtLookup = { status: 'CONFIGURED'; rate: Dec } | { status: 'NOT_CONFIGURED'; note: string };

/** Verified DIVIDEND_WITHHOLDING rows only; UNKNOWN filer status is never mapped to a rate. */
export function lookupDemoWht(
  rates: readonly TaxRate[],
  filerStatus: TaxFilerStatus,
  date: string,
): WhtLookup {
  if (filerStatus === 'UNKNOWN')
    return {
      status: 'NOT_CONFIGURED',
      note: 'Your tax filer status is UNKNOWN, so withholding tax is not estimated. Set it in settings and recompute.',
    };
  const rows = rates
    .filter(
      (r) =>
        r.type === 'DIVIDEND_WITHHOLDING' &&
        r.verified &&
        r.filerStatus === filerStatus &&
        r.effectiveFrom <= date,
    )
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  if (rows.length === 0)
    return {
      status: 'NOT_CONFIGURED',
      note: `No verified dividend WHT rate for ${filerStatus} on ${date}. Enter the confirmed rate and recompute.`,
    };
  if (rows.length > 1 && rows[0].effectiveFrom === rows[1].effectiveFrom)
    return {
      status: 'NOT_CONFIGURED',
      note: `Overlapping verified dividend WHT rates for ${filerStatus} on ${date}; fix tax rates and recompute.`,
    };
  return { status: 'CONFIGURED', rate: Dec.of(rows[0].ratePct).div(100) };
}

const whtDate = (d: DemoDeclaration) => d.paymentDate ?? d.bookClosureFrom;

// ─── views ─────────────────────────────────────────────────────────────────

export function declarationView(st: DemoDividendState, d: DemoDeclaration): DividendDeclaration {
  return {
    ...d,
    locked: st.entitlements.some((e) => e.dividendId === d.id && SETTLED.has(e.status)),
  };
}

export function entitlementView(
  st: DemoDividendState,
  r: DemoEntitlementRow,
  ctx: DemoDividendContext,
): DividendEntitlement {
  const dv = st.declarations.find((d) => d.id === r.dividendId)!;
  const settled = SETTLED.has(r.status);
  let taxStatus: DividendTaxStatus;
  let taxNote: string | null = null;
  if (settled) taxStatus = 'AS_PAID';
  else {
    const lookup = lookupDemoWht(ctx.taxRates, ctx.filerStatus, whtDate(dv));
    if (lookup.status === 'NOT_CONFIGURED') {
      taxStatus = 'NOT_CONFIGURED';
      taxNote = lookup.note;
    } else if (lookup.rate.toFixed(RATE_DP) === Dec.of(r.whtRate).toFixed(RATE_DP)) taxStatus = 'CONFIGURED';
    else {
      taxStatus = 'RECOMPUTE_REQUIRED';
      taxNote = 'A different verified WHT rate now applies; recompute entitlements.';
    }
  }
  const showTax = taxStatus === 'CONFIGURED' || taxStatus === 'AS_PAID';
  return {
    id: r.id,
    dividendId: r.dividendId,
    portfolioId: r.portfolioId,
    symbol: dv.symbol,
    bookClosureFrom: dv.bookClosureFrom,
    bookClosureTo: dv.bookClosureTo,
    paymentDate: dv.paymentDate,
    dividendPerShare: dv.dividendPerShare,
    sharesEligible: r.sharesEligible,
    grossAmount: m4(Dec.of(r.grossAmount)),
    whtRate: showTax ? Dec.of(r.whtRate).toFixed(RATE_DP) : null,
    whtAmount: showTax ? m4(Dec.of(r.whtAmount)) : null,
    zakatAmount: m4(Dec.of(r.zakatAmount)),
    netAmount: showTax ? m4(Dec.of(r.netAmount)) : null,
    netBeforeWht: m4(Dec.of(r.grossAmount).sub(r.zakatAmount)),
    taxStatus,
    taxNote,
    status: r.status,
    source: r.source,
    provisional: !settled && dv.bookClosureFrom > ctx.today,
    paidAt: r.paidAt,
    cashMovementId: r.cashMovementId,
    reconciledAt: r.reconciledAt,
    updatedAt: r.updatedAt,
  };
}

// ─── declarations ──────────────────────────────────────────────────────────

export function createDeclaration(
  st: DemoDividendState,
  input: DividendDeclarationInput,
  ctx: DemoDividendContext,
): DividendDeclaration {
  const symbol = (input.symbol ?? '').trim().toUpperCase();
  const errors: FieldError[] = [];
  if (!SYMBOL_RE.test(symbol)) errors.push({ path: 'symbol', message: 'invalid symbol' });
  checkDate(errors, 'announcementDate', input.announcementDate);
  checkDate(errors, 'bookClosureFrom', input.bookClosureFrom, true);
  checkDate(errors, 'bookClosureTo', input.bookClosureTo);
  checkDate(errors, 'paymentDate', input.paymentDate);
  check(errors, 'dividendPerShare', dpsSchema.safeParse(input.dividendPerShare ?? ''));
  if (!errors.length) {
    const issue = dateOrderIssue(input);
    if (issue) errors.push({ path: issue.path, message: issue.message });
  }
  if (errors.length) throw validation(errors);
  if (!ctx.knownSymbol(symbol)) throw new ApiError('NOT_FOUND', 404, 'Not found', `Unknown symbol ${symbol}`);
  if (st.declarations.some((d) => d.symbol === symbol && d.bookClosureFrom === input.bookClosureFrom))
    throw new ApiError(
      'ALREADY_EXISTS',
      409,
      'Already exists',
      'A dividend with this book-closure start already exists for the stock',
    );
  const d: DemoDeclaration = {
    id: ctx.id('div'),
    symbol,
    companyName: null,
    announcementDate: input.announcementDate ?? null,
    bookClosureFrom: input.bookClosureFrom,
    bookClosureTo: input.bookClosureTo ?? null,
    paymentDate: input.paymentDate ?? null,
    dividendPerShare: input.dividendPerShare.trim(),
    source: 'USER_REPORTED',
    createdAt: ctx.nowIso,
  };
  st.declarations.push(d);
  return declarationView(st, d);
}

function loadUnlocked(st: DemoDividendState, id: string): DemoDeclaration {
  const d = st.declarations.find((x) => x.id === id);
  if (!d) throw notFound('Dividend');
  if (declarationView(st, d).locked) throw locked();
  return d;
}

function clearEntitlements(st: DemoDividendState, dividendId: string): number {
  const before = st.entitlements.length;
  st.entitlements = st.entitlements.filter((e) => e.dividendId !== dividendId);
  return before - st.entitlements.length;
}

export function updateDeclaration(st: DemoDividendState, id: string, patch: DividendDeclarationUpdate) {
  const d = loadUnlocked(st, id);
  const errors: FieldError[] = [];
  if (Object.keys(patch).length === 0) errors.push({ path: '', message: 'nothing to update' });
  checkDate(errors, 'announcementDate', patch.announcementDate);
  if (patch.bookClosureFrom !== undefined) checkDate(errors, 'bookClosureFrom', patch.bookClosureFrom, true);
  checkDate(errors, 'bookClosureTo', patch.bookClosureTo);
  checkDate(errors, 'paymentDate', patch.paymentDate);
  if (patch.dividendPerShare !== undefined)
    check(errors, 'dividendPerShare', dpsSchema.safeParse(patch.dividendPerShare));
  if (errors.length) throw validation(errors);
  const merged = {
    announcementDate: patch.announcementDate === undefined ? d.announcementDate : patch.announcementDate,
    bookClosureFrom: patch.bookClosureFrom ?? d.bookClosureFrom,
    bookClosureTo: patch.bookClosureTo === undefined ? d.bookClosureTo : patch.bookClosureTo,
    paymentDate: patch.paymentDate === undefined ? d.paymentDate : patch.paymentDate,
  };
  const issue = dateOrderIssue(merged);
  if (issue) throw new ApiError('INVALID_DATE_ORDER', 422, 'Invalid date order', issue.message);
  if (
    st.declarations.some(
      (x) => x.id !== d.id && x.symbol === d.symbol && x.bookClosureFrom === merged.bookClosureFrom,
    )
  )
    throw new ApiError(
      'ALREADY_EXISTS',
      409,
      'Already exists',
      'A dividend with this book-closure start already exists for the stock',
    );
  // Estimates were computed from the old terms: drop them so a stale estimate is never shown or paid.
  const cleared = clearEntitlements(st, d.id);
  Object.assign(
    d,
    merged,
    patch.dividendPerShare !== undefined ? { dividendPerShare: patch.dividendPerShare } : {},
  );
  return { ...declarationView(st, d), estimatedEntitlementsCleared: cleared };
}

export function deleteDeclaration(st: DemoDividendState, id: string) {
  const d = loadUnlocked(st, id);
  const cleared = clearEntitlements(st, d.id);
  st.declarations = st.declarations.filter((x) => x.id !== d.id);
  return { id: d.id, deleted: true as const, estimatedEntitlementsCleared: cleared };
}

// ─── eligibility ───────────────────────────────────────────────────────────

/** Add `n` Mon–Fri business days (demo calendar: no PSX holidays). */
export function addBusinessDays(date: string, n: number): string {
  let t = Date.parse(`${date}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    t += 86_400_000;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** Shares of `symbol` settled strictly before `bookClosureFrom` (BUY/SELL settle T+n; other events on their date). */
export function eligibleShares(
  ledger: readonly LedgerEntry[],
  symbol: string,
  bookClosureFrom: string,
  settlementDays: number,
): Dec {
  let qty = Dec.zero();
  for (const e of ledger) {
    if (e.kind !== 'txn' || e.txn.symbol !== symbol) continue;
    const t = e.txn;
    const tradeSettles = t.type === 'BUY' || t.type === 'SELL';
    const settles = tradeSettles ? addBusinessDays(t.tradeDate, settlementDays) : t.tradeDate;
    if (settles >= bookClosureFrom) continue;
    if (t.type === 'BUY' || t.type === 'TRANSFER_IN' || t.type === 'BONUS_IN') qty = qty.add(t.quantity);
    else if (t.type === 'SELL' || t.type === 'TRANSFER_OUT') qty = qty.sub(t.quantity);
  }
  return qty.isNeg() ? Dec.zero() : qty;
}

export function demoSettlement(): SettlementAssumption {
  return {
    days: DEMO_SETTLEMENT_DAYS,
    basis: 'DEFAULT',
    note:
      `Default T+${DEMO_SETTLEMENT_DAYS} settlement (PSX ready market). The owner must confirm the cycle against ` +
      `the current NCCPL rules and set system_settings 'market.settlementDays'. Demo calendar: weekends only, no PSX holidays.`,
  };
}

// ─── compute ───────────────────────────────────────────────────────────────

export function computeEntitlements(
  st: DemoDividendState,
  portfolioId: string,
  ledger: readonly LedgerEntry[],
  ctx: DemoDividendContext,
): DividendComputeResult {
  const settlement = demoSettlement();
  const firstBySymbol = new Map<string, string>();
  for (const e of ledger)
    if (e.kind === 'txn' && !firstBySymbol.has(e.txn.symbol))
      firstBySymbol.set(e.txn.symbol, e.txn.tradeDate);
  const counts = { created: 0, updated: 0, unchanged: 0, removed: 0, skippedSettled: 0, notEligible: 0 };
  const data: DividendEntitlement[] = [];
  const inHistory = st.declarations.filter((d) => {
    const first = firstBySymbol.get(d.symbol);
    return first !== undefined && d.bookClosureFrom > first;
  });
  for (const dv of inHistory) {
    const existing = st.entitlements.find((e) => e.dividendId === dv.id && e.portfolioId === portfolioId);
    if (existing && !ESTIMATES.has(existing.status)) {
      counts.skippedSettled++;
      data.push(entitlementView(st, existing, ctx));
      continue;
    }
    const shares = eligibleShares(ledger, dv.symbol, dv.bookClosureFrom, settlement.days);
    if (shares.isZero()) {
      counts.notEligible++;
      if (existing) {
        st.entitlements = st.entitlements.filter((e) => e !== existing);
        counts.removed++;
      }
      continue;
    }
    const wht = lookupDemoWht(ctx.taxRates, ctx.filerStatus, whtDate(dv));
    const rate = wht.status === 'CONFIGURED' ? wht.rate : Dec.zero();
    const gross = shares.mul(dv.dividendPerShare).round(4);
    const whtAmount = gross.mul(rate).round(4);
    const values = {
      sharesEligible: shares.toString(),
      grossAmount: m4(gross),
      whtRate: rate.toFixed(RATE_DP),
      whtAmount: m4(whtAmount),
      zakatAmount: '0.0000',
      netAmount: m4(gross.sub(whtAmount)),
      status: 'ENTITLED' as const,
      source: 'ESTIMATED' as const,
    };
    let row: DemoEntitlementRow;
    if (!existing) {
      row = {
        id: ctx.id('dent'),
        dividendId: dv.id,
        portfolioId,
        ...values,
        paidAt: null,
        cashMovementId: null,
        reconciledAt: null,
        updatedAt: ctx.nowIso,
      };
      st.entitlements.push(row);
      counts.created++;
    } else if (
      existing.status === 'ENTITLED' &&
      existing.source === 'ESTIMATED' &&
      (['sharesEligible', 'grossAmount', 'whtRate', 'whtAmount', 'zakatAmount', 'netAmount'] as const).every(
        (k) => Dec.of(existing[k]).cmp(values[k]) === 0,
      )
    ) {
      row = existing;
      counts.unchanged++;
    } else {
      Object.assign(existing, values, { updatedAt: ctx.nowIso });
      row = existing;
      counts.updated++;
    }
    data.push(entitlementView(st, row, ctx));
  }
  return { portfolioId, settlement, filerStatus: ctx.filerStatus, counts, data };
}

// ─── payment ───────────────────────────────────────────────────────────────

export function markPaid(
  st: DemoDividendState,
  id: string,
  input: DividendMarkPaidInput,
  ctx: DemoDividendContext,
  recordCash: (row: DemoEntitlementRow, symbol: string, net: string) => string,
): DividendMarkPaidResult {
  const errors: FieldError[] = [];
  checkDate(errors, 'paidAt', input.paidAt, true);
  check(errors, 'netAmount', positiveMoneySchema.safeParse(input.netAmount ?? ''));
  // Required, never inferred from the cash received (ADR-031).
  if (input.whtAmount === undefined || input.whtAmount === null || String(input.whtAmount).trim() === '')
    errors.push({ path: 'whtAmount', message: 'whtAmount is required (from the payment advice)' });
  else check(errors, 'whtAmount', nonNegativeMoneySchema.safeParse(input.whtAmount));
  if (input.zakatAmount !== undefined)
    check(errors, 'zakatAmount', nonNegativeMoneySchema.safeParse(input.zakatAmount));
  if (errors.length) throw validation(errors);
  if (input.paidAt > ctx.today)
    throw new ApiError('INVALID_DATE', 422, 'Invalid date', 'paidAt cannot be in the future');

  const e = st.entitlements.find((x) => x.id === id);
  if (!e) throw notFound('Dividend entitlement');
  if (!ESTIMATES.has(e.status))
    throw new ApiError(
      'ENTITLEMENT_NOT_PAYABLE',
      409,
      'Not payable',
      `Entitlement is ${e.status}; only an ENTITLED dividend can be marked paid`,
    );
  const estimate = entitlementView(st, e, ctx);
  const gross = Dec.of(e.grossAmount);
  const net = Dec.of(input.netAmount);
  const zakat = input.zakatAmount !== undefined ? Dec.of(input.zakatAmount) : Dec.of(e.zakatAmount);
  const wht = Dec.of(input.whtAmount);
  if (wht.gt(gross))
    throw new ApiError('INVALID_WHT', 422, 'Invalid withholding', 'Withholding exceeds the gross dividend');
  const unexplained = gross.sub(zakat).sub(wht).sub(net);
  const cashMovementId = recordCash(e, estimate.symbol, m4(net));
  Object.assign(e, {
    status: 'PAID',
    paidAt: input.paidAt,
    cashMovementId,
    netAmount: m4(net),
    whtAmount: m4(wht),
    whtRate: gross.isZero() ? Dec.zero().toFixed(RATE_DP) : wht.div(gross).toFixed(RATE_DP),
    zakatAmount: m4(zakat),
    source: 'USER_REPORTED',
    updatedAt: ctx.nowIso,
  } satisfies Partial<DemoEntitlementRow>);
  return {
    entitlement: entitlementView(st, e, ctx),
    cashMovementId,
    whtBasis: 'REPORTED',
    unexplainedDifference: m4(unexplained),
    warnings: unexplained.isZero()
      ? []
      : [
          `gross − zakat − withholding − received = ${m4(unexplained)}: check the share count and the payment advice`,
        ],
    estimate: {
      netAmount: estimate.netAmount,
      whtAmount: estimate.whtAmount,
      grossAmount: estimate.grossAmount,
      taxStatus: estimate.taxStatus,
    },
    differences: {
      netAmount: estimate.netAmount === null ? null : m4(net.sub(estimate.netAmount)),
      whtAmount: estimate.whtAmount === null ? null : m4(wht.sub(estimate.whtAmount)),
      grossAmount: m4(net.add(wht).add(zakat).sub(gross)),
    },
  };
}

export function reconcile(
  st: DemoDividendState,
  id: string,
  ctx: DemoDividendContext,
  confirmCash: (cashMovementId: string) => void,
): DividendEntitlement {
  const e = st.entitlements.find((x) => x.id === id);
  if (!e) throw notFound('Dividend entitlement');
  if (e.status !== 'PAID' || !e.cashMovementId)
    throw new ApiError(
      'ENTITLEMENT_NOT_RECONCILABLE',
      409,
      'Not reconcilable',
      `Entitlement is ${e.status}; only a PAID dividend can be reconciled`,
    );
  Object.assign(e, {
    status: 'RECONCILED',
    source: 'BROKER_CONFIRMED',
    reconciledAt: ctx.nowIso,
    updatedAt: ctx.nowIso,
  });
  confirmCash(e.cashMovementId);
  return entitlementView(st, e, ctx);
}
