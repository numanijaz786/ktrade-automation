import { z } from 'zod';

/**
 * Money, prices and quantities cross every boundary (HTTP, WS, queues) as decimal STRINGS,
 * never JS numbers. Optional sign, 1–16 integer digits, optional 1–10 fraction digits.
 */
export const DECIMAL_STRING_RE = /^-?\d{1,16}(\.\d{1,10})?$/;

export const decimalString = z
  .string()
  .trim()
  .regex(DECIMAL_STRING_RE, 'must be a decimal string like "1234.50"');

export const positiveDecimalString = decimalString.refine((v) => !v.startsWith('-') && /[1-9]/.test(v), {
  message: 'must be greater than zero',
});

export const nonNegativeDecimalString = decimalString.refine((v) => !v.startsWith('-'), {
  message: 'must not be negative',
});

export type DecimalString = z.infer<typeof decimalString>;
