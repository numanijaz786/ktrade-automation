/**
 * Dividend rules shared by the /dividends forms and the demo client (ADR-031), mirroring
 * apps/api/src/dividends/dividends.schemas.ts:
 *  - declaration dates in order: announcement ≤ book-closure start ≤ end ≤ payment;
 *  - DPS > 0 with at most 6 decimals; money with at most 4 decimals;
 *  - mark-paid REQUIRES the withholding deducted (from the payment advice) — never inferred.
 * Every numeric comparison first checks DECIMAL_STRING_RE (ADR-024: Zod 4 runs refinements after a
 * failed regex). Nothing here computes a tax rate.
 */
import { z } from 'zod';
import { DECIMAL_STRING_RE, weakestSource, type DataSource } from '@ktrade/shared';
import { Dec } from '../decimal';
import type {
  DividendDeclaration,
  DividendDeclarationInput,
  DividendDeclarationUpdate,
  DividendEntitlement,
  DividendMarkPaidInput,
} from './types';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return new Date(t).toISOString().slice(0, 10) === value;
}

const isDec = (v: string) => DECIMAL_STRING_RE.test(v);
const fractionDigits = (v: string) => v.split('.')[1]?.length ?? 0;
const isPositive = (v: string) => !v.startsWith('-') && /[1-9]/.test(v);

export const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;

export interface DeclarationDates {
  announcementDate?: string | null;
  bookClosureFrom?: string;
  bookClosureTo?: string | null;
  paymentDate?: string | null;
}

/** Same order check as the API (`dateOrderIssue`): the offending field and message, or null. */
export function dateOrderIssue(
  v: DeclarationDates,
): { path: keyof DeclarationDates; message: string } | null {
  const from = v.bookClosureFrom;
  if (!from) return null;
  if (v.announcementDate && v.announcementDate > from) {
    return { path: 'announcementDate', message: 'Announcement must be on or before the book-closure start' };
  }
  if (v.bookClosureTo && v.bookClosureTo < from) {
    return { path: 'bookClosureTo', message: 'Book-closure end must be on or after its start' };
  }
  const lastBookClosureDay = v.bookClosureTo ?? from;
  if (v.paymentDate && v.paymentDate < lastBookClosureDay) {
    return { path: 'paymentDate', message: 'Payment date must be on or after the book closure' };
  }
  return null;
}

// ─── field schemas ─────────────────────────────────────────────────────────

const decimal = z.string().trim().regex(DECIMAL_STRING_RE, 'Enter a number, e.g. 12.50');
const maxDp = (dp: number) => (v: string) => !isDec(v) || fractionDigits(v) <= dp;

export const dpsSchema = decimal
  .refine((v) => !isDec(v) || isPositive(v), 'Must be greater than zero')
  .refine(maxDp(6), 'At most 6 decimal places');

export const positiveMoneySchema = decimal
  .refine((v) => !isDec(v) || isPositive(v), 'Must be greater than zero')
  .refine(maxDp(4), 'At most 4 decimal places');

export const nonNegativeMoneySchema = decimal
  .refine((v) => !isDec(v) || !v.startsWith('-'), 'Must not be negative')
  .refine(maxDp(4), 'At most 4 decimal places');

const requiredDate = z
  .string()
  .trim()
  .min(1, 'Required')
  .refine((v) => v === '' || isIsoDate(v), 'Enter a date (YYYY-MM-DD)');
const optionalDate = z
  .string()
  .trim()
  .refine((v) => v === '' || isIsoDate(v), 'Enter a date (YYYY-MM-DD)');

// ─── declaration form ──────────────────────────────────────────────────────

export interface DeclarationFormValues {
  symbol: string;
  announcementDate: string;
  bookClosureFrom: string;
  bookClosureTo: string;
  paymentDate: string;
  dividendPerShare: string;
}

export type FormErrors<T> = Partial<Record<keyof T, string>>;

const declarationFormSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .min(1, 'Required')
      .refine((v) => v === '' || SYMBOL_RE.test(v.toUpperCase()), 'Invalid symbol'),
    announcementDate: optionalDate,
    bookClosureFrom: requiredDate,
    bookClosureTo: optionalDate,
    paymentDate: optionalDate,
    dividendPerShare: dpsSchema,
  })
  .superRefine((v, ctx) => {
    // Order is only meaningful once every given date is valid.
    const dates = [v.announcementDate, v.bookClosureFrom, v.bookClosureTo, v.paymentDate].map((d) =>
      d.trim(),
    );
    if (!dates[1] || dates.some((d) => d !== '' && !isIsoDate(d))) return;
    const issue = dateOrderIssue({
      announcementDate: dates[0] || null,
      bookClosureFrom: dates[1],
      bookClosureTo: dates[2] || null,
      paymentDate: dates[3] || null,
    });
    if (issue) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  });

export type FormResult<I, T> = { ok: true; input: I } | { ok: false; errors: FormErrors<T> };

function firstErrors<T>(issues: readonly { path: PropertyKey[]; message: string }[]): FormErrors<T> {
  const errors: FormErrors<T> = {};
  for (const issue of issues) {
    const key = issue.path[0] as keyof T | undefined;
    if (key !== undefined && !errors[key]) errors[key] = issue.message;
  }
  return errors;
}

export function validateDeclarationForm(
  values: DeclarationFormValues,
): FormResult<DividendDeclarationInput, DeclarationFormValues> {
  const r = declarationFormSchema.safeParse(values);
  if (!r.success) return { ok: false, errors: firstErrors<DeclarationFormValues>(r.error.issues) };
  const v = r.data;
  return {
    ok: true,
    input: {
      symbol: v.symbol.toUpperCase(),
      announcementDate: v.announcementDate || null,
      bookClosureFrom: v.bookClosureFrom,
      bookClosureTo: v.bookClosureTo || null,
      paymentDate: v.paymentDate || null,
      dividendPerShare: v.dividendPerShare,
    },
  };
}

export function declarationFormValues(d?: DividendDeclaration): DeclarationFormValues {
  return {
    symbol: d?.symbol ?? '',
    announcementDate: d?.announcementDate ?? '',
    bookClosureFrom: d?.bookClosureFrom ?? '',
    bookClosureTo: d?.bookClosureTo ?? '',
    paymentDate: d?.paymentDate ?? '',
    dividendPerShare: d?.dividendPerShare ?? '',
  };
}

/** PATCH body with only what changed (DPS compared as decimals, so "4" equals "4.000000"). */
export function declarationPatch(
  original: DividendDeclaration,
  input: DividendDeclarationInput,
): DividendDeclarationUpdate {
  const patch: DividendDeclarationUpdate = {};
  if ((input.announcementDate ?? null) !== original.announcementDate)
    patch.announcementDate = input.announcementDate ?? null;
  if (input.bookClosureFrom !== original.bookClosureFrom) patch.bookClosureFrom = input.bookClosureFrom;
  if ((input.bookClosureTo ?? null) !== original.bookClosureTo)
    patch.bookClosureTo = input.bookClosureTo ?? null;
  if ((input.paymentDate ?? null) !== original.paymentDate) patch.paymentDate = input.paymentDate ?? null;
  if (Dec.of(input.dividendPerShare).cmp(original.dividendPerShare) !== 0)
    patch.dividendPerShare = input.dividendPerShare;
  return patch;
}

// ─── mark-paid form ────────────────────────────────────────────────────────

export interface MarkPaidFormValues {
  paidAt: string;
  netAmount: string;
  /** Required: the withholding shown on the payment advice ("0" if none was deducted). */
  whtAmount: string;
  zakatAmount: string;
}

export const WHT_REQUIRED_MESSAGE =
  'Enter the withholding tax shown on the payment advice (0 if none was deducted)';

export function validateMarkPaidForm(
  values: MarkPaidFormValues,
  ctx: { today: string; grossAmount?: string },
): FormResult<DividendMarkPaidInput, MarkPaidFormValues> {
  const schema = z
    .object({
      paidAt: requiredDate.refine((v) => !isIsoDate(v) || v <= ctx.today, 'Cannot be in the future'),
      netAmount: positiveMoneySchema,
      whtAmount: z.string().trim().min(1, WHT_REQUIRED_MESSAGE).pipe(nonNegativeMoneySchema),
      zakatAmount: z
        .string()
        .trim()
        .refine((v) => v === '' || nonNegativeMoneySchema.safeParse(v).success, {
          message: 'Must be a non-negative amount with at most 4 decimal places',
        }),
    })
    .superRefine((v, c) => {
      const gross = ctx.grossAmount;
      if (gross && isDec(v.whtAmount) && isDec(gross) && Dec.of(v.whtAmount).gt(gross))
        c.addIssue({
          code: 'custom',
          path: ['whtAmount'],
          message: 'Withholding exceeds the gross dividend',
        });
    });
  const r = schema.safeParse(values);
  if (!r.success) return { ok: false, errors: firstErrors<MarkPaidFormValues>(r.error.issues) };
  const v = r.data;
  return {
    ok: true,
    input: {
      paidAt: v.paidAt,
      netAmount: v.netAmount,
      whtAmount: v.whtAmount,
      ...(v.zakatAmount ? { zakatAmount: v.zakatAmount } : {}),
    },
  };
}

// ─── income summary ────────────────────────────────────────────────────────

export interface SourcedTotal {
  value: string;
  /** Weakest provenance of the rows summed; null when nothing was summed. */
  source: DataSource | null;
  count: number;
}

export interface DividendIncomeSummary {
  /** Net cash recorded as received (PAID + RECONCILED). */
  receivedNet: SourcedTotal;
  /** Withholding recorded from payment advices (PAID + RECONCILED). */
  whtWithheld: SourcedTotal;
  /** Gross of unpaid estimates (before any withholding — WHT may be not configured). ESTIMATED. */
  pendingGross: SourcedTotal;
  /** Unpaid estimates whose WHT/net are unknown (NOT_CONFIGURED or RECOMPUTE_REQUIRED). */
  pendingWithoutTax: number;
}

const SETTLED = new Set(['PAID', 'RECONCILED']);
const PENDING = new Set(['ANNOUNCED', 'ENTITLED']);

function total(rows: DividendEntitlement[], pick: (e: DividendEntitlement) => string | null): SourcedTotal {
  const used = rows.filter((e) => pick(e) !== null);
  return {
    value: Dec.sum(used.map((e) => pick(e)!)).toFixed(4),
    source: used.length ? weakestSource(used.map((e) => e.source)) : null,
    count: used.length,
  };
}

/** Sums recorded figures only (Dec arithmetic); never estimates a rate. */
export function summarizeDividendIncome(rows: DividendEntitlement[]): DividendIncomeSummary {
  const settled = rows.filter((e) => SETTLED.has(e.status));
  const pending = rows.filter((e) => PENDING.has(e.status));
  return {
    receivedNet: total(settled, (e) => e.netAmount),
    whtWithheld: total(settled, (e) => e.whtAmount),
    pendingGross: total(pending, (e) => e.grossAmount),
    pendingWithoutTax: pending.filter(
      (e) => e.taxStatus === 'NOT_CONFIGURED' || e.taxStatus === 'RECOMPUTE_REQUIRED',
    ).length,
  };
}
