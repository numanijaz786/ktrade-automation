import { createHash } from 'node:crypto';
import { d, type DecimalInput } from '../decimal.js';
import { type TradeOrderType, type TradeSide, type TradingMode } from '../strategy/types.js';

/** Immutable fields an approval binds to (docs/08 §7). Any change → different hash → approval invalid. */
export interface PreviewHashFields {
  readonly symbol: string;
  readonly side: TradeSide;
  readonly type: TradeOrderType;
  readonly qty: DecimalInput;
  readonly limitPrice?: DecimalInput | null;
  readonly stopPrice?: DecimalInput | null;
  readonly portfolioId: string;
  readonly mode: TradingMode;
}

const PREVIEW_HASH_VERSION = 'ktrade-preview-v1';
const dec = (x: DecimalInput | null | undefined): string | null =>
  x === null || x === undefined ? null : d(x).toFixed();

/**
 * Canonical serialization: a JSON array in a FIXED field order (not object-key order), decimals normalized
 * so "100.50" and "100.5" hash identically, absent prices as null, prefixed with a version tag.
 */
export function canonicalPreviewString(f: PreviewHashFields): string {
  return JSON.stringify([
    PREVIEW_HASH_VERSION,
    ['symbol', f.symbol],
    ['side', f.side],
    ['type', f.type],
    ['qty', dec(f.qty)],
    ['limitPrice', dec(f.limitPrice)],
    ['stopPrice', dec(f.stopPrice)],
    ['portfolioId', f.portfolioId],
    ['mode', f.mode],
  ]);
}

/** Lower-case hex SHA-256 of the canonical preview string. */
export function previewHash(fields: PreviewHashFields): string {
  return createHash('sha256').update(canonicalPreviewString(fields), 'utf8').digest('hex');
}
