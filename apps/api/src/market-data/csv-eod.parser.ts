import { d } from '@ktrade/finance-core';
import { positiveDecimalString } from '@ktrade/shared';
import { z } from 'zod';
import { isIsoDate, isWeekday } from './calendar.js';
import { SYMBOL_RE } from './decimal-format.js';

export const EOD_CSV_COLUMNS = ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'] as const;
type Column = (typeof EOD_CSV_COLUMNS)[number];

export const MAX_CSV_ROWS = 50_000;
const MAX_ISSUES = 200;

/** NUMERIC(20,6): at most 14 integer and 6 fraction digits. */
const priceString = positiveDecimalString.refine((v) => /^\d{1,14}(\.\d{1,6})?$/.test(v), {
  message: 'must have at most 14 integer and 6 decimal digits',
});

const rowSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(SYMBOL_RE, 'must be a PSX symbol (A–Z, 0–9, up to 12 characters)'),
    date: z.string().trim().refine(isIsoDate, 'must be a valid date in YYYY-MM-DD form'),
    open: priceString,
    high: priceString,
    low: priceString,
    close: priceString,
    volume: z.string().trim().regex(/^\d{1,15}$/, 'must be a whole number of shares'),
  })
  .superRefine((r, ctx) => {
    const [open, high, low, close] = [d(r.open), d(r.high), d(r.low), d(r.close)];
    if (high.lt(low)) ctx.addIssue({ code: 'custom', path: ['high'], message: 'high must be ≥ low' });
    if (open.gt(high) || open.lt(low)) ctx.addIssue({ code: 'custom', path: ['open'], message: 'open must be within [low, high]' });
    if (close.gt(high) || close.lt(low)) ctx.addIssue({ code: 'custom', path: ['close'], message: 'close must be within [low, high]' });
  });

export interface EodCsvRow {
  /** 1-based line number in the uploaded file (the header is line 1). */
  line: number;
  symbol: string;
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface CsvIssue {
  line: number;
  field?: string;
  message: string;
}

export interface ParseEodCsvOptions {
  /** PKT trading date "today": bars dated after it are rejected. */
  today: string;
  maxRows?: number;
}

/**
 * Parses and validates an EOD price CSV (`symbol,date,open,high,low,close,volume`, any column order,
 * header required). Values must be plain decimal strings — `1,234.50` or `1.2e3` are rejected rather
 * than guessed. Returns every valid row and every issue with its line number; callers decide whether
 * any issue rejects the whole file (the importer does — imports are all-or-nothing).
 */
export function parseEodCsv(text: string, options: ParseEodCsvOptions): { rows: EodCsvRow[]; issues: CsvIssue[] } {
  const maxRows = options.maxRows ?? MAX_CSV_ROWS;
  const rows: EodCsvRow[] = [];
  const issues: CsvIssue[] = [];
  const push = (issue: CsvIssue) => {
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim() !== '');
  if (headerIdx === -1) return { rows, issues: [{ line: 1, message: 'file is empty' }] };

  const header = splitFields(lines[headerIdx]!).map((h) => h.toLowerCase());
  const index = new Map<Column, number>();
  header.forEach((h, i) => {
    if (!(EOD_CSV_COLUMNS as readonly string[]).includes(h)) push({ line: headerIdx + 1, message: `unknown column "${h}"` });
    else if (index.has(h as Column)) push({ line: headerIdx + 1, message: `duplicate column "${h}"` });
    else index.set(h as Column, i);
  });
  for (const c of EOD_CSV_COLUMNS) if (!index.has(c)) push({ line: headerIdx + 1, message: `missing column "${c}"` });
  if (issues.length) return { rows, issues };

  const seen = new Map<string, number>();
  let dataRows = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const line = i + 1;
    if (++dataRows > maxRows) {
      push({ line, message: `too many rows (max ${maxRows})` });
      break;
    }
    const fields = splitFields(raw);
    if (fields.length !== header.length) {
      push({ line, message: `expected ${header.length} fields, got ${fields.length} (thousands separators are not allowed)` });
      continue;
    }
    const record = Object.fromEntries(EOD_CSV_COLUMNS.map((c) => [c, fields[index.get(c)!]!]));
    const parsed = rowSchema.safeParse(record);
    if (!parsed.success) {
      for (const iss of parsed.error.issues) push({ line, field: String(iss.path[0] ?? ''), message: iss.message });
      continue;
    }
    const r = parsed.data;
    if (r.date > options.today) {
      push({ line, field: 'date', message: 'must not be in the future' });
      continue;
    }
    if (!isWeekday(r.date)) {
      push({ line, field: 'date', message: 'is a weekend — PSX does not trade' });
      continue;
    }
    const key = `${r.symbol}|${r.date}`;
    const firstLine = seen.get(key);
    if (firstLine !== undefined) {
      push({ line, message: `duplicate ${r.symbol} ${r.date} (first seen on line ${firstLine})` });
      continue;
    }
    seen.set(key, line);
    rows.push({ line, ...r });
  }
  if (dataRows === 0 && issues.length === 0) push({ line: headerIdx + 2, message: 'no data rows' });
  return { rows, issues };
}

/** Minimal CSV field splitting: trims, strips one pair of surrounding double quotes. No embedded commas. */
function splitFields(line: string): string[] {
  return line.split(',').map((f) => {
    const t = f.trim();
    return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t;
  });
}

/** Render CSV issues through the global filter as 422 problem+json: `errors[].path` = `rows.<line>.<field>`. */
export function csvIssuesToZodError(issues: readonly CsvIssue[]): z.ZodError {
  return new z.ZodError(
    issues.map((i) => ({
      code: 'custom' as const,
      path: i.field ? ['rows', i.line, i.field] : ['rows', i.line],
      message: i.message,
      input: undefined,
    })),
  );
}
