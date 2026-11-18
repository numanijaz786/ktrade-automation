import { z } from 'zod';
import type { CsvIssue } from '../market-data/csv-eod.parser.js';

export const MAX_RESEARCH_CSV_BYTES = 2 * 1024 * 1024;
const MAX_ISSUES = 200;
const UNTERMINATED = '\u0000unterminated';

export interface CsvRecord {
  /** 1-based line where the record starts (the header is line 1 unless leading blank lines exist). */
  line: number;
  values: Record<string, string>;
}

/**
 * RFC 4180-style splitting: quoted fields may contain commas, doubled quotes and line breaks.
 * Returns each non-blank record with the physical line it started on.
 */
export function splitCsv(text: string): { line: number; fields: string[] }[] {
  const out: { line: number; fields: string[] }[] = [];
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;
  let line = 1;
  let startLine = 1;
  const endField = () => {
    fields.push(quotedField ? field : field.trim());
    field = '';
    quotedField = false;
  };
  const endRecord = () => {
    endField();
    if (!(fields.length === 1 && fields[0] === '')) out.push({ line: startLine, fields });
    fields = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
    } else if (c === '"' && field.trim() === '') {
      inQuotes = true;
      quotedField = true;
      field = '';
    } else if (c === ',') endField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else field += c;
  }
  if (inQuotes) {
    // Unterminated quote: surface as a malformed record so the caller reports it.
    endRecord();
    out[out.length - 1]!.fields.push(UNTERMINATED);
  } else if (field !== '' || fields.length > 0) endRecord();
  return out;
}

export interface ReadCsvResult {
  records: CsvRecord[];
  issues: CsvIssue[];
}

/**
 * Header-driven CSV reader: columns may come in any order; unknown/duplicate/missing-required columns and
 * ragged rows are reported with line numbers. Blank cells are omitted from `values`.
 */
export function readCsv(
  text: string,
  spec: { required: readonly string[]; optional: readonly string[]; maxRows: number },
): ReadCsvResult {
  const issues: CsvIssue[] = [];
  const push = (i: CsvIssue) => {
    if (issues.length < MAX_ISSUES) issues.push(i);
  };
  const raw = splitCsv(text);
  if (raw.length === 0) return { records: [], issues: [{ line: 1, message: 'file is empty' }] };
  const headerRow = raw[0]!;
  const header = headerRow.fields.map((h) => h.toLowerCase());
  const all = [...spec.required, ...spec.optional];
  const canonical = new Map(all.map((c) => [c.toLowerCase(), c]));
  const seen = new Set<string>();
  for (const h of header) {
    if (!canonical.has(h)) push({ line: headerRow.line, message: `unknown column "${h}"` });
    else if (seen.has(h)) push({ line: headerRow.line, message: `duplicate column "${h}"` });
    seen.add(h);
  }
  for (const c of spec.required)
    if (!seen.has(c.toLowerCase())) push({ line: headerRow.line, message: `missing column "${c}"` });
  if (issues.length) return { records: [], issues };

  const records: CsvRecord[] = [];
  const body = raw.slice(1);
  if (body.length === 0) return { records, issues: [{ line: headerRow.line + 1, message: 'no data rows' }] };
  for (const [n, row] of body.entries()) {
    if (n >= spec.maxRows) {
      push({ line: row.line, message: `too many rows (max ${spec.maxRows})` });
      break;
    }
    if (row.fields.includes(UNTERMINATED)) {
      push({ line: row.line, message: 'unterminated quoted field' });
      continue;
    }
    if (row.fields.length !== header.length) {
      push({
        line: row.line,
        message: `expected ${header.length} fields, got ${row.fields.length} (quote fields that contain commas)`,
      });
      continue;
    }
    const values: Record<string, string> = {};
    header.forEach((h, i) => {
      const v = row.fields[i]!;
      if (v !== '') values[canonical.get(h)!] = v;
    });
    records.push({ line: row.line, values });
  }
  return { records, issues };
}

/** Issues of a failed Zod parse for one CSV row, tagged with its line. */
export function zodIssuesFor(line: number, error: z.ZodError): CsvIssue[] {
  return error.issues.map((i) => ({ line, field: String(i.path[0] ?? ''), message: i.message }));
}

/** One-field validation failure rendered by the global filter as 422 problem+json. */
export function fieldError(path: string, message: string): z.ZodError {
  return new z.ZodError([{ code: 'custom', path: [path], message, input: undefined }]);
}
