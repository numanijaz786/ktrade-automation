/**
 * Display formatting for decimal STRINGS. All rounding goes through `Dec` (BigInt fixed-point);
 * nothing here converts money to a JS float.
 *
 * Percent convention: functions take a *percent* string ("2.35" → "2.35%") unless
 * `{ fraction: true }` is passed ("0.0235" → "2.35%").
 */
import { Dec, type DecInput } from './decimal';

export const MINUS = '−'; // typographic minus: aligns with "+" and reads clearly

function groupThousands(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "1234567.891" → "1,234,567.89" (dp = 2). Returns the unsigned magnitude plus a sign flag. */
function splitFormatted(v: DecInput, dp: number): { neg: boolean; body: string; zero: boolean } {
  const d = Dec.of(v).round(dp);
  const fixed = d.abs().toFixed(dp);
  const [int, frac] = fixed.split('.');
  return {
    neg: d.isNeg(),
    zero: d.isZero(),
    body: frac === undefined ? groupThousands(int) : `${groupThousands(int)}.${frac}`,
  };
}

export interface NumberFormatOptions {
  /** Fraction digits (default 2). */
  dp?: number;
  /** Always show a sign (+ for positive, − for negative). Zero shows no sign. */
  signed?: boolean;
}

/** Grouped decimal, e.g. "1,254,300.50". Invalid input renders as an em dash. */
export function formatNumber(v: DecInput | null | undefined, opts: NumberFormatOptions = {}): string {
  if (v === null || v === undefined || v === '') return '—';
  try {
    const { neg, body, zero } = splitFormatted(v, opts.dp ?? 2);
    if (zero) return body;
    if (neg) return `${MINUS}${body}`;
    return opts.signed ? `+${body}` : body;
  } catch {
    return '—';
  }
}

/** Share quantity: whole shares unless the value has a fraction. */
export function formatQty(v: DecInput | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  try {
    const d = Dec.of(v);
    const hasFraction = !d.round(0).sub(d).isZero();
    return formatNumber(d, { dp: hasFraction ? 4 : 0 });
  } catch {
    return '—';
  }
}

export interface MoneyFormatOptions extends NumberFormatOptions {
  /** Prefix, default "Rs". Pass "" to omit. */
  currency?: string;
  /** Compact notation: K / M / B (2 dp of the compacted figure). */
  compact?: boolean;
}

const COMPACT_STEPS: ReadonlyArray<[string, string]> = [
  ['1000000000', 'B'],
  ['1000000', 'M'],
  ['1000', 'K'],
];

/** PKR amount, e.g. "Rs 1,254,300.50", "−Rs 1,234.00", "+Rs 12.5K" (signed + compact). */
export function formatPKR(v: DecInput | null | undefined, opts: MoneyFormatOptions = {}): string {
  if (v === null || v === undefined || v === '') return '—';
  const currency = opts.currency ?? 'Rs';
  const prefix = currency ? `${currency} ` : '';
  try {
    let d = Dec.of(v);
    let suffix = '';
    if (opts.compact) {
      for (const [step, s] of COMPACT_STEPS) {
        if (d.abs().gte(step)) {
          d = d.div(step);
          suffix = s;
          break;
        }
      }
    }
    const { neg, body, zero } = splitFormatted(d, opts.dp ?? 2);
    const sign = zero ? '' : neg ? MINUS : opts.signed ? '+' : '';
    return `${sign}${prefix}${body}${suffix}`;
  } catch {
    return '—';
  }
}

export interface PercentFormatOptions extends NumberFormatOptions {
  /** Input is a fraction (0.0235) rather than a percent (2.35). */
  fraction?: boolean;
}

export function formatPercent(v: DecInput | null | undefined, opts: PercentFormatOptions = {}): string {
  if (v === null || v === undefined || v === '') return '—';
  try {
    const d = opts.fraction ? Dec.of(v).mul('100') : Dec.of(v);
    return `${formatNumber(d, { dp: opts.dp ?? 2, signed: opts.signed })}%`;
  } catch {
    return '—';
  }
}

export type Tone = 'gain' | 'loss' | 'flat';

/** Direction of a signed figure, for P&L colouring. */
export function toneOf(v: DecInput | null | undefined): Tone {
  if (v === null || v === undefined || v === '') return 'flat';
  try {
    const c = Dec.of(v).cmp(0);
    return c > 0 ? 'gain' : c < 0 ? 'loss' : 'flat';
  } catch {
    return 'flat';
  }
}

/** Tailwind text classes for a P&L tone (tokens defined in globals.css, AA in both themes). */
export function toneClass(t: Tone): string {
  return t === 'gain' ? 'text-gain' : t === 'loss' ? 'text-loss' : 'text-muted-foreground';
}

/** DISPLAY-ONLY: numeric value for chart libraries. Never use for money arithmetic. */
export function chartNumber(v: DecInput): number {
  return Dec.of(v).toNumber();
}

const PKT = 'Asia/Karachi';

/** "13 Nov 2026" for a YYYY-MM-DD date or ISO instant (PKT calendar). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00Z`) : new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const tz = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? 'UTC' : PKT;
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: tz }).format(
    date,
  );
}

/** "13 Nov 2026, 12:15 PKT" */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const s = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: PKT,
  }).format(date);
  return `${s} PKT`;
}

/** "12:15:04 PKT" */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: PKT,
  }).format(date)} PKT`;
}

/** Human label for SCREAMING_SNAKE enum values: "AWAITING_MANUAL_PLACEMENT" → "Awaiting manual placement". */
export function humanize(value: string): string {
  const s = value.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
