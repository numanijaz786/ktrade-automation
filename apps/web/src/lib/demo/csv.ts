/**
 * Demo-mode CSV reader for the statement-import UI. The real parser lives server-side
 * (apps/api/src/imports/parsers/generic-csv.parser.ts); this mirrors its header aliases and row rules so the
 * demo behaves like the real pipeline. Never used to post real data.
 */
import type { ImportRowStatus } from '@ktrade/shared';
import type { FeeComponent, ImportRow, OrderSide } from '../api/types';

const ALIASES: Record<string, string> = {
  date: 'tradeDate', tradedate: 'tradeDate', trade_date: 'tradeDate',
  symbol: 'symbol', scrip: 'symbol',
  side: 'side', type: 'side', 'buy/sell': 'side',
  quantity: 'quantity', qty: 'quantity', volume: 'quantity',
  price: 'price', rate: 'price',
  commission: 'commission', brokerage: 'commission', sst: 'sst', cdc: 'cdc', cdc_charges: 'cdc',
  reference: 'ref', ref: 'ref', contract_no: 'ref', contract_number: 'ref',
};
const FEES: [string, FeeComponent][] = [['commission', 'COMMISSION'], ['sst', 'SST_ON_COMMISSION'], ['cdc', 'CDC_CHARGES']];
const REQUIRED = ['tradeDate', 'symbol', 'side', 'quantity', 'price'];
const DECIMAL = /^\d{1,16}(\.\d{1,10})?$/;

export interface DemoParsedRow {
  rowNo: number;
  tradeDate: string | null;
  symbol: string | null;
  side: OrderSide | null;
  quantity: string | null;
  price: string | null;
  contractRef: string | null;
  fees: { component: FeeComponent; amount: string }[];
  errors: string[];
}

/** RFC 4180-ish line splitter: handles quoted fields with commas and doubled quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function isoDate(v: string): string | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  let iso: string | null = null;
  if (m) iso = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v))) iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  if (!iso) return null;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().startsWith(iso) ? iso : null;
}

export function parseDemoCsv(content: string): { ok: true; rows: DemoParsedRow[] } | { ok: false; error: string } {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { ok: true, rows: [] };
  const header = splitCsvLine(lines[0]!).map((h) => ALIASES[h.toLowerCase().replace(/\s+/g, '_')] ?? h.toLowerCase());
  const missing = REQUIRED.filter((r) => !header.includes(r));
  if (missing.length) return { ok: false, error: `Missing column(s): ${missing.join(', ')}` };
  const rows: DemoParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    if (cells.length !== header.length) return { ok: false, error: `Row ${i + 1}: expected ${header.length} columns, found ${cells.length}` };
    const raw = Object.fromEntries(header.map((h, j) => [h, cells[j] ?? '']));
    const errors: string[] = [];
    const tradeDate = isoDate(raw.tradeDate ?? '');
    if (!tradeDate) errors.push(`invalid date "${raw.tradeDate}" (use YYYY-MM-DD or DD/MM/YYYY)`);
    const symbol = (raw.symbol ?? '').toUpperCase() || null;
    const s = (raw.side ?? '').toUpperCase();
    const side: OrderSide | null = s === 'B' || s === 'BUY' ? 'BUY' : s === 'S' || s === 'SELL' ? 'SELL' : null;
    if (!side) errors.push(`invalid side "${raw.side}" (BUY/SELL)`);
    const quantity = (raw.quantity ?? '').replace(/,/g, '');
    if (!/^\d+$/.test(quantity) || /^0+$/.test(quantity)) errors.push(`quantity must be a positive whole number, got "${raw.quantity}"`);
    const price = (raw.price ?? '').replace(/,/g, '');
    if (!DECIMAL.test(price) || /^0+(\.0+)?$/.test(price)) errors.push(`price must be a positive decimal, got "${raw.price}"`);
    const fees = FEES.flatMap(([field, component]) => {
      const v = (raw[field] ?? '').replace(/,/g, '');
      if (!v) return [];
      if (!DECIMAL.test(v)) { errors.push(`${field} must be a non-negative decimal`); return []; }
      return [{ component, amount: v }];
    });
    rows.push({ rowNo: i + 1, tradeDate, symbol, side, quantity: errors.length ? quantity || null : quantity, price: price || null, contractRef: raw.ref || null, fees, errors });
  }
  return { ok: true, rows };
}

/** Trade identity used for duplicate detection (same fields as the server fingerprint). */
export const demoRowKey = (r: Pick<ImportRow, 'tradeDate' | 'symbol' | 'side' | 'quantity' | 'price'>): string =>
  [r.tradeDate, r.symbol, r.side, r.quantity?.replace(/^0+(?=\d)/, ''), r.price?.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')].join('|');

export function countRows(rows: readonly ImportRow[]): Partial<Record<ImportRowStatus, number>> {
  const out: Partial<Record<ImportRowStatus, number>> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}
