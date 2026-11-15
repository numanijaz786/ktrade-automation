import { z } from 'zod';
import { d } from '@ktrade/finance-core';
import { DECIMAL_STRING_RE, nonNegativeDecimalString, positiveDecimalString } from '@ktrade/shared';
import { isIsoDate } from '../market-data/calendar.js';

// ADR-024: Zod 4 runs refinements even after the regex failed, so every decimal refinement checks the regex first.
const maxDp = (dp: number) => (v: string) => !DECIMAL_STRING_RE.test(v) || d(v).decimalPlaces() <= dp;

/** Dividend per share: > 0, at most 6 decimals (dividends.dividend_per_share is NUMERIC(20,6)). */
export const dividendPerShareString = positiveDecimalString.refine(maxDp(6), 'at most 6 decimal places');
/** Money amounts stored as NUMERIC(20,4): never silently rounded by the database. */
export const positiveMoneyString = positiveDecimalString.refine(maxDp(4), 'at most 4 decimal places');
export const nonNegativeMoneyString = nonNegativeDecimalString.refine(maxDp(4), 'at most 4 decimal places');

const isoDate = z.string().refine(isIsoDate, 'must be a calendar date YYYY-MM-DD');

const symbol = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9.-]{0,15}$/, 'invalid symbol');

export interface DeclarationDates {
  announcementDate?: string | null;
  bookClosureFrom?: string;
  bookClosureTo?: string | null;
  paymentDate?: string | null;
}

/**
 * announcement ≤ book-closure start ≤ book-closure end ≤ payment (payment ≥ start when no end is given).
 * Returns the offending field + message, or null when the order is valid. Shared by create and (merged) update.
 */
export function dateOrderIssue(
  v: DeclarationDates,
): { path: keyof DeclarationDates; message: string } | null {
  const from = v.bookClosureFrom;
  if (!from) return null;
  if (v.announcementDate && v.announcementDate > from) {
    return { path: 'announcementDate', message: 'announcementDate must be on or before bookClosureFrom' };
  }
  if (v.bookClosureTo && v.bookClosureTo < from) {
    return { path: 'bookClosureTo', message: 'bookClosureTo must be on or after bookClosureFrom' };
  }
  const lastBookClosureDay = v.bookClosureTo ?? from;
  if (v.paymentDate && v.paymentDate < lastBookClosureDay) {
    return { path: 'paymentDate', message: 'paymentDate must be on or after the book closure' };
  }
  return null;
}

const datesRefinement = (v: DeclarationDates, ctx: z.RefinementCtx) => {
  const issue = dateOrderIssue(v);
  if (issue) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
};

export const createDividendSchema = z
  .object({
    symbol,
    announcementDate: isoDate.nullish(),
    bookClosureFrom: isoDate,
    bookClosureTo: isoDate.nullish(),
    paymentDate: isoDate.nullish(),
    dividendPerShare: dividendPerShareString,
    // Owner-entered declarations are USER_REPORTED. PROVIDER is reserved for a future licensed corporate-actions feed.
    source: z.literal('USER_REPORTED').default('USER_REPORTED'),
  })
  .strict()
  .superRefine(datesRefinement);
export type CreateDividendInput = z.infer<typeof createDividendSchema>;

export const updateDividendSchema = z
  .object({
    announcementDate: isoDate.nullable().optional(),
    bookClosureFrom: isoDate.optional(),
    bookClosureTo: isoDate.nullable().optional(),
    paymentDate: isoDate.nullable().optional(),
    dividendPerShare: dividendPerShareString.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateDividendInput = z.infer<typeof updateDividendSchema>;

export const listDividendsSchema = z.object({
  symbol: symbol.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ListDividendsQuery = z.infer<typeof listDividendsSchema>;

export const markPaidSchema = z
  .object({
    paidAt: isoDate,
    /** Cash actually received (after withholding and zakat). */
    netAmount: positiveMoneyString,
    /** Withholding tax actually deducted, per the payment advice. Required — never inferred (ADR-031). */
    whtAmount: nonNegativeMoneyString,
    /** Zakat actually deducted at source. Optional (defaults to the entitlement's zakat, normally 0). */
    zakatAmount: nonNegativeMoneyString.optional(),
  })
  .strict();
export type MarkPaidInput = z.infer<typeof markPaidSchema>;

export const reconcileSchema = z
  .object({
    /** Reference of the broker / CDC statement the payment was matched to (kept in the audit trail). */
    statementRef: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type ReconcileInput = z.infer<typeof reconcileSchema>;
