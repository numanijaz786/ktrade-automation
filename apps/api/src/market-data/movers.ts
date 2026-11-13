import { d } from '@ktrade/finance-core';
import type { QuoteDto } from '@ktrade/broker-sdk';

export const MOVER_TYPES = ['gainers', 'losers', 'active'] as const;
export type MoverType = (typeof MOVER_TYPES)[number];

/**
 * Top movers over the quote universe (docs/09 §B3), compared as decimals:
 * - gainers: changePct > 0, highest first
 * - losers:  changePct < 0, lowest first
 * - active:  volume > 0, highest first
 * Ties break by symbol so the order is stable.
 */
export function rankMovers<T extends Pick<QuoteDto, 'symbol' | 'changePct' | 'volume'>>(
  quotes: readonly T[],
  type: MoverType,
  limit: number,
): T[] {
  const bySymbol = (a: T, b: T) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
  let ranked: T[];
  if (type === 'active') {
    ranked = quotes
      .filter((q) => q.volume !== undefined && d(q.volume).gt(0))
      .sort((a, b) => d(b.volume!).comparedTo(d(a.volume!)) || bySymbol(a, b));
  } else {
    const sign = type === 'gainers' ? 1 : -1;
    ranked = quotes
      .filter((q) => q.changePct !== undefined && d(q.changePct).times(sign).gt(0))
      .sort((a, b) => d(b.changePct!).comparedTo(d(a.changePct!)) * sign || bySymbol(a, b));
  }
  return ranked.slice(0, limit);
}
