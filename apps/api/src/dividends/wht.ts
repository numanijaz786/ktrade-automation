/**
 * Dividend withholding-tax lookup. Never invents a rate (ADR-023):
 * - only VERIFIED `tax_rates` rows of type DIVIDEND_WITHHOLDING are considered;
 * - an UNKNOWN filer status is NOT mapped to the non-filer rate here (finance-core's conservative fallback is
 *   switched off) — the owner must set their filer status first;
 * - no matching row, or overlapping rows, → NOT_CONFIGURED. The entitlement then stores 0 for the NOT NULL
 *   wht columns and every response flags it (WHT and net are shown as null).
 */
import { type Decimal, findTaxRate, type TaxRateRow, TaxRateNotFoundError } from '@ktrade/finance-core';
import type { TaxFilerStatus } from '@ktrade/shared';

export type WhtLookup =
  | { status: 'CONFIGURED'; rate: Decimal; effectiveFrom: string }
  | {
      status: 'NOT_CONFIGURED';
      reason: 'FILER_STATUS_UNKNOWN' | 'NO_VERIFIED_RATE' | 'AMBIGUOUS_RATES';
      note: string;
    };

export function lookupDividendWht(
  verifiedRows: readonly TaxRateRow[],
  filerStatus: TaxFilerStatus,
  date: string,
): WhtLookup {
  if (filerStatus === 'UNKNOWN') {
    return {
      status: 'NOT_CONFIGURED',
      reason: 'FILER_STATUS_UNKNOWN',
      note: 'Your tax filer status is UNKNOWN, so withholding tax is not estimated. Set it in settings and recompute.',
    };
  }
  try {
    const row = findTaxRate(
      verifiedRows.filter((r) => r.verified === true),
      { taxType: 'DIVIDEND_WITHHOLDING', filerStatus, date, unknownAsNonFiler: false },
    );
    return { status: 'CONFIGURED', rate: row.rate, effectiveFrom: row.effectiveFrom };
  } catch (err) {
    if (!(err instanceof TaxRateNotFoundError)) throw err;
    return err.code === 'AMBIGUOUS'
      ? {
          status: 'NOT_CONFIGURED',
          reason: 'AMBIGUOUS_RATES',
          note: `Overlapping verified dividend WHT rates for ${filerStatus} on ${date}; fix tax_rates and recompute.`,
        }
      : {
          status: 'NOT_CONFIGURED',
          reason: 'NO_VERIFIED_RATE',
          note: `No verified dividend WHT rate for ${filerStatus} on ${date}. Enter the confirmed rate and recompute.`,
        };
  }
}
