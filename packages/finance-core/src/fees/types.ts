/**
 * Local mirrors of the @ktrade/shared enum values used by the fee engine.
 * finance-core does not depend on @ktrade/shared, so these string-literal unions MUST keep
 * exactly the same spellings as packages/shared/src/enums.ts (and the Prisma enums).
 */
import { type Decimal } from '../decimal.js';

export type FeeComponent =
  | 'COMMISSION'
  | 'SST_ON_COMMISSION'
  | 'CDC_CHARGES'
  | 'NCCPL_CHARGES'
  | 'SECP_LEVY'
  | 'PSX_LEVY'
  | 'CVT'
  | 'CGT'
  | 'DIVIDEND_WHT'
  | 'ZAKAT'
  | 'OTHER';

export type FeeAppliesTo = 'BUY' | 'SELL' | 'BOTH' | 'DIVIDEND';

export type FeeMethod =
  'PCT_OF_VALUE' | 'PER_SHARE' | 'MAX_OF_PCT_OR_PER_SHARE' | 'FIXED' | 'PCT_OF_COMPONENT' | 'AT_ACTUAL';

/** Trade direction for fee purposes (mirrors OrderSide). */
export type FeeTradeSide = 'BUY' | 'SELL';

export type TaxType = 'CAPITAL_GAINS' | 'DIVIDEND_WITHHOLDING';
export type TaxFilerStatus = 'FILER' | 'NON_FILER' | 'UNKNOWN';

/** Mirrors FeeScheduleItem (schema.prisma). Rates are fractions: 0.003 = 0.3%. */
export interface FeeScheduleItemSpec {
  component: FeeComponent;
  appliesTo: FeeAppliesTo;
  method: FeeMethod;
  rate?: Decimal | null;
  perShare?: Decimal | null;
  fixedAmount?: Decimal | null;
  minAmount?: Decimal | null;
  /** Required for PCT_OF_COMPONENT. */
  baseComponent?: FeeComponent | null;
  /** true → part of cost basis / deducted from proceeds; false → tracked as a tax. */
  capitalise: boolean;
  sortOrder: number;
}

/** Mirrors FeeSchedule. Dates are ISO 'YYYY-MM-DD'; effectiveTo is inclusive. */
export interface FeeScheduleSpec {
  brokerCode?: string;
  name?: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  sourceNote?: string | null;
  items: readonly FeeScheduleItemSpec[];
}
