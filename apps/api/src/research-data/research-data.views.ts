import type { FinancialPeriodDto } from '@ktrade/broker-sdk';
import type { Prisma } from '../generated/prisma/client.js';
import { fromDb } from '../market-data/decimal-format.js';
import { FINANCIAL_ITEM_KEYS } from './research-data.schemas.js';

type FinancialRow = Prisma.CompanyFinancialGetPayload<{ include: { stock: { select: { symbol: true } } } }>;

/** Decimal strings in fixed notation; absent items stay absent (never zero-filled). */
export function financialView(r: FinancialRow): FinancialPeriodDto & { id: string } {
  const items: Record<string, string> = {};
  for (const k of FINANCIAL_ITEM_KEYS) {
    const v = r[k];
    if (v !== null) items[k] = fromDb(v).toFixed();
  }
  return {
    id: r.id,
    symbol: r.stock.symbol,
    periodType: r.periodType,
    periodEnd: r.periodEnd.toISOString().slice(0, 10),
    publishedAt: r.publishedAt.toISOString(),
    currency: r.currency,
    source: r.source,
    sourceRef: r.sourceRef,
    ...(r.sourceUrl ? { sourceUrl: r.sourceUrl } : {}),
    ...items,
  };
}
