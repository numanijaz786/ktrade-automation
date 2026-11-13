import { parse } from 'csv-parse/sync';
import { d } from '@ktrade/finance-core';
import { DECIMAL_STRING_RE, type FeeComponent } from '@ktrade/shared';
import type { ParsedTradeRow, StatementParser } from './parser.types.js';

/** Header aliases (case/space-insensitive) → canonical field. */
const ALIASES: Record<string, string> = {
  date: 'tradeDate',
  tradedate: 'tradeDate',
  trade_date: 'tradeDate',
  symbol: 'symbol',
  scrip: 'symbol',
  side: 'side',
  type: 'side',
  'buy/sell': 'side',
  quantity: 'quantity',
  qty: 'quantity',
  volume: 'quantity',
  price: 'price',
  rate: 'price',
  commission: 'commission',
  brokerage: 'commission',
  sst: 'sst',
  cdc: 'cdc',
  cdc_charges: 'cdc',
  nccpl: 'nccpl',
  secp: 'secp',
  psx: 'psx',
  cvt: 'cvt',
  other: 'other',
  other_charges: 'other',
  reference: 'ref',
  ref: 'ref',
  contract_no: 'ref',
  contract_number: 'ref',
};

const FEE_FIELDS: [string, FeeComponent][] = [
  ['commission', 'COMMISSION'],
  ['sst', 'SST_ON_COMMISSION'],
  ['cdc', 'CDC_CHARGES'],
  ['nccpl', 'NCCPL_CHARGES'],
  ['secp', 'SECP_LEVY'],
  ['psx', 'PSX_LEVY'],
  ['cvt', 'CVT'],
  ['other', 'OTHER'],
];

const normaliseHeader = (h: string) =>
  ALIASES[h.trim().toLowerCase().replace(/\s+/g, '_')] ?? h.trim().toLowerCase();
const cleanNumber = (v: string) => v.trim().replace(/,/g, '');

/** Accepts YYYY-MM-DD or DD/MM/YYYY (Pakistani convention) or DD-MM-YYYY. */
export function normaliseDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  let y: string, mo: string, da: string;
  if (m) [, y, mo, da] = m as unknown as [string, string, string, string];
  else if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s))) {
    y = m[3]!;
    mo = m[2]!.padStart(2, '0');
    da = m[1]!.padStart(2, '0');
  } else return null;
  const iso = `${y}-${mo}-${da}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().startsWith(iso) ? iso : null;
}

/**
 * User-assembled trade history CSV (e.g. transcribed from contract notes or a spreadsheet).
 * Required: date, symbol, side, quantity, price. Optional: per-component charges and a reference.
 * Rows are USER_REPORTED; KTrade document parsers (when samples are available) produce BROKER_CONFIRMED.
 */
export class GenericTransactionsCsvParser implements StatementParser {
  readonly key = 'generic.transactions.csv';
  readonly version = '1';
  readonly kind = 'GENERIC_TRANSACTIONS_CSV' as const;
  readonly source = 'USER_REPORTED' as const;

  detect(fileName: string, content: string): number {
    if (!fileName.toLowerCase().endsWith('.csv')) return 0;
    const header = (content.split(/\r?\n/, 1)[0] ?? '').split(',').map(normaliseHeader);
    const required = ['tradeDate', 'symbol', 'side', 'quantity', 'price'];
    return required.every((r) => header.includes(r)) ? 0.9 : 0;
  }

  parse(content: string): ParsedTradeRow[] {
    const records: Record<string, string>[] = parse(content, {
      columns: (h: string[]) => h.map(normaliseHeader),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: false,
    });
    return records.map((raw, i) => this.toRow(raw, i + 2)); // +2: 1-based, after the header line
  }

  private toRow(raw: Record<string, string>, rowIndex: number): ParsedTradeRow {
    const errors: string[] = [];
    const tradeDate = normaliseDate(raw.tradeDate ?? '');
    if (!tradeDate) errors.push(`invalid date "${raw.tradeDate ?? ''}" (use YYYY-MM-DD or DD/MM/YYYY)`);
    const symbol = (raw.symbol ?? '').toUpperCase();
    if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) errors.push(`invalid symbol "${raw.symbol ?? ''}"`);
    const sideRaw = (raw.side ?? '').trim().toUpperCase();
    const side =
      sideRaw === 'B' || sideRaw === 'BUY' ? 'BUY' : sideRaw === 'S' || sideRaw === 'SELL' ? 'SELL' : null;
    if (!side) errors.push(`invalid side "${raw.side ?? ''}" (BUY/SELL)`);
    const quantity = cleanNumber(raw.quantity ?? '');
    if (!/^\d+$/.test(quantity) || quantity === '0' || /^0+$/.test(quantity))
      errors.push(`quantity must be a positive whole number, got "${raw.quantity ?? ''}"`);
    const price = cleanNumber(raw.price ?? '');
    if (!DECIMAL_STRING_RE.test(price) || !d(price).gt(0))
      errors.push(`price must be a positive decimal, got "${raw.price ?? ''}"`);

    const fees: { component: FeeComponent; amount: string }[] = [];
    for (const [field, component] of FEE_FIELDS) {
      const v = raw[field];
      if (v === undefined || v.trim() === '') continue;
      const amt = cleanNumber(v);
      if (!DECIMAL_STRING_RE.test(amt) || d(amt).lt(0))
        errors.push(`${field} must be a non-negative decimal, got "${v}"`);
      else fees.push({ component, amount: amt });
    }

    if (errors.length > 0 || !tradeDate || !side) return { rowIndex, raw, errors };
    return {
      rowIndex,
      raw,
      errors,
      trade: { tradeDate, symbol, side, quantity, price, fees, ...(raw.ref ? { externalRef: raw.ref } : {}) },
    };
  }
}
