import { type Decimal, d, max, pct, round } from '@ktrade/finance-core';
import type { PriceInterval } from '@ktrade/shared';

/** PSX tick size: 0.01 PKR. */
export const TICK_DP = 2;
export const MIN_TICK = d('0.01');

/** PSX symbols: upper-case letters/digits (e.g. OGDC, PIBTL, 786). */
export const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;

export const INTERVAL_MINUTES: Record<Exclude<PriceInterval, 'D1'>, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  H1: 60,
};

/** Round to the PSX tick (half-even) and never below one tick. */
export const toTick = (x: Decimal): Decimal => max(MIN_TICK, round(x, TICK_DP, 'HALF_EVEN'));

/** Prices are tick-rounded, so 2 dp is exact for generated data; stored/imported data keeps up to 6 dp. */
export function formatPrice(x: Decimal): string {
  return x.decimalPlaces() <= TICK_DP ? x.toFixed(TICK_DP) : x.toFixed();
}

/** Percentage change to 4 dp (half-even), or undefined when the base is zero. */
export function formatChangePct(change: Decimal, base: Decimal): string | undefined {
  const p = pct(change, base);
  return p === null ? undefined : round(p, 4, 'HALF_EVEN').toFixed(4);
}

/** Prisma returns NUMERIC as its own Decimal type; go through a fixed-notation string into finance-core. */
export const fromDb = (value: { toFixed(): string }): Decimal => d(value.toFixed());
