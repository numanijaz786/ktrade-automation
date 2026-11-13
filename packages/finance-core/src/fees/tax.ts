/**
 * Tax-rate lookup over effective-dated TaxRate rows (schema.prisma `TaxRate`).
 * Rates are fractions (0.15 = 15%). Seed rates are placeholders (verified=false) — see docs/06.
 */
import { type Decimal, type DecimalInput, type RoundingMode, d, roundPaisa } from '../decimal.js';
import { assertIsoDate, isWithinEffective } from './isoDate.js';
import { type TaxFilerStatus, type TaxType } from './types.js';

export interface TaxRateRow {
  taxType: TaxType;
  filerStatus: TaxFilerStatus;
  /** Inclusive lower bound on holding days (CGT bands). null = unbounded. */
  minHoldingDays?: number | null;
  /** Inclusive upper bound on holding days (CGT bands). null = unbounded. */
  maxHoldingDays?: number | null;
  rate: Decimal;
  /** ISO date, inclusive. */
  effectiveFrom: string;
  /** ISO date, inclusive; null = open-ended. */
  effectiveTo?: string | null;
  verified?: boolean;
}

export interface TaxRateQuery {
  taxType: TaxType;
  filerStatus: TaxFilerStatus;
  /** ISO date the tax is assessed on (payment date for dividend WHT, disposal date for CGT). */
  date: string;
  /** Required to match rows with holding-day bounds (CGT). */
  holdingDays?: number;
  /**
   * When no row exists for UNKNOWN, fall back to NON_FILER rows (the conservative, higher rate —
   * a person not on the Active Taxpayers List is withheld at the non-filer rate). Default true.
   */
  unknownAsNonFiler?: boolean;
}

export class TaxRateNotFoundError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'AMBIGUOUS',
    public readonly query: TaxRateQuery,
    message: string,
  ) {
    super(message);
    this.name = 'TaxRateNotFoundError';
  }
}

function matches(row: TaxRateRow, q: TaxRateQuery, filerStatus: TaxFilerStatus): boolean {
  if (row.taxType !== q.taxType || row.filerStatus !== filerStatus) return false;
  if (!isWithinEffective(q.date, row.effectiveFrom, row.effectiveTo)) return false;
  const hasMin = row.minHoldingDays !== null && row.minHoldingDays !== undefined;
  const hasMax = row.maxHoldingDays !== null && row.maxHoldingDays !== undefined;
  if (hasMin || hasMax) {
    if (q.holdingDays === undefined) return false;
    if (hasMin && q.holdingDays < (row.minHoldingDays as number)) return false;
    if (hasMax && q.holdingDays > (row.maxHoldingDays as number)) return false;
  }
  return true;
}

function pick<R extends TaxRateRow>(
  rows: readonly R[],
  q: TaxRateQuery,
  filerStatus: TaxFilerStatus,
): R | undefined {
  const hits = rows.filter((r) => matches(r, q, filerStatus));
  if (hits.length === 0) return undefined;
  hits.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0));
  const [best, second] = hits;
  if (best && second && second.effectiveFrom === best.effectiveFrom) {
    throw new TaxRateNotFoundError(
      'AMBIGUOUS',
      q,
      `Overlapping ${q.taxType} rates for ${filerStatus} on ${q.date} (effective ${best.effectiveFrom})`,
    );
  }
  return best;
}

/**
 * Find the applicable tax-rate row. Among matching rows the latest effectiveFrom wins; two matches
 * with the same effectiveFrom (overlapping bands) throw AMBIGUOUS. No match throws NOT_FOUND.
 */
export function findTaxRate<R extends TaxRateRow>(rows: readonly R[], query: TaxRateQuery): R {
  assertIsoDate(query.date);
  if (
    query.holdingDays !== undefined &&
    (!Number.isSafeInteger(query.holdingDays) || query.holdingDays < 0)
  ) {
    throw new RangeError(`holdingDays must be a non-negative integer, got ${query.holdingDays}`);
  }
  const direct = pick(rows, query, query.filerStatus);
  if (direct) return direct;
  if (query.filerStatus === 'UNKNOWN' && (query.unknownAsNonFiler ?? true)) {
    const fallback = pick(rows, query, 'NON_FILER');
    if (fallback) return fallback;
  }
  throw new TaxRateNotFoundError(
    'NOT_FOUND',
    query,
    `No ${query.taxType} rate for ${query.filerStatus} on ${query.date}` +
      (query.holdingDays === undefined ? '' : ` (holding ${query.holdingDays} days)`),
  );
}

export interface DividendTaxEstimate {
  rate: Decimal;
  /** gross × rate, paisa-rounded. */
  amount: Decimal;
  /** false when the rate row is a placeholder (verified=false or unknown). */
  verified: boolean;
}

/** Estimated dividend withholding tax: gross × taxRate(DIVIDEND_WITHHOLDING, filerStatus, paymentDate). */
export function estimateDividendTax(
  rows: readonly TaxRateRow[],
  input: { gross: DecimalInput; filerStatus: TaxFilerStatus; paymentDate: string; rounding?: RoundingMode },
): DividendTaxEstimate {
  const row = findTaxRate(rows, {
    taxType: 'DIVIDEND_WITHHOLDING',
    filerStatus: input.filerStatus,
    date: input.paymentDate,
  });
  const gross = d(input.gross);
  if (gross.isNeg()) throw new RangeError('Dividend gross must be ≥ 0');
  const rate = d(row.rate);
  return {
    rate,
    amount: roundPaisa(gross.times(rate), input.rounding ?? 'HALF_UP'),
    verified: row.verified === true,
  };
}
