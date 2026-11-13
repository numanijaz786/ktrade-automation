import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DECIMAL_STRING_RE, positiveDecimalString } from '@ktrade/shared';
import { d } from '@ktrade/finance-core';

/**
 * Regression guard (ADR-024): Zod 4 keeps running refinements after a failed check, so any refinement that
 * parses a decimal must tolerate malformed input. Unguarded, `d('abc')` throws and a 422 becomes a 500.
 */
describe('Zod 4 refinement behaviour', () => {
  it('runs refinements even when an earlier check failed — guarded refinements must not throw', () => {
    const unguarded = positiveDecimalString.refine((v) => d(v).lte(100));
    expect(() => unguarded.safeParse('abc')).toThrow(); // documents the hazard
    const guarded = positiveDecimalString.refine(
      (v) => !DECIMAL_STRING_RE.test(v) || d(v).lte(100),
      'must be ≤ 100',
    );
    const r = guarded.safeParse('abc');
    expect(r.success).toBe(false);
    expect(guarded.safeParse('101').success).toBe(false);
    expect(guarded.safeParse('25.5').success).toBe(true);
  });

  it('object-level superRefine also runs after field failures', () => {
    let ran = false;
    const s = z.object({ a: z.string().regex(/^\d+$/) }).superRefine(() => {
      ran = true;
    });
    s.safeParse({ a: 'x' });
    expect(ran).toBe(true);
  });
});
