/**
 * Tiny exact decimal arithmetic for the UI, built on BigInt fixed-point (10 fraction digits,
 * matching DECIMAL_STRING_RE in @ktrade/shared). Money, prices and quantities stay as decimal
 * STRINGS at every boundary; this never round-trips through JS floats, so there are no
 * `0.1 + 0.2` artifacts. Rounding is half-away-from-zero (the usual "half-up" for money).
 */

const SCALE_DIGITS = 10;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);
const SCALE = TEN ** BigInt(SCALE_DIGITS);

const INPUT_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

function pow10(n: number): bigint {
  return TEN ** BigInt(n);
}

/** Divide with half-away-from-zero rounding. */
function divRound(n: bigint, d: bigint): bigint {
  if (d === ZERO) throw new RangeError('Division by zero');
  const neg = n < ZERO !== d < ZERO;
  const an = n < ZERO ? -n : n;
  const ad = d < ZERO ? -d : d;
  let q = an / ad;
  const r = an % ad;
  if (r * TWO >= ad) q += ONE;
  return neg ? -q : q;
}

function parseUnits(input: string): bigint {
  const m = INPUT_RE.exec(input.trim());
  if (!m) throw new TypeError(`Not a decimal string: ${JSON.stringify(input)}`);
  const [, sign, int, frac = ''] = m;
  let units: bigint;
  if (frac.length <= SCALE_DIGITS) {
    units = BigInt(int + frac.padEnd(SCALE_DIGITS, '0'));
  } else {
    // More precision than we carry: round the excess away.
    const keep = BigInt(int + frac.slice(0, SCALE_DIGITS));
    const nextDigit = Number(frac[SCALE_DIGITS]);
    units = nextDigit >= 5 ? keep + ONE : keep;
  }
  return sign === '-' ? -units : units;
}

export type DecInput = Dec | string | number | bigint;

export class Dec {
  /** Value × 10^10. */
  readonly units: bigint;

  private constructor(units: bigint) {
    this.units = units;
  }

  static of(v: DecInput): Dec {
    if (v instanceof Dec) return v;
    if (typeof v === 'bigint') return new Dec(v * SCALE);
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) {
        throw new TypeError('Dec.of(number) only accepts safe integers; pass decimals as strings');
      }
      return new Dec(BigInt(v) * SCALE);
    }
    return new Dec(parseUnits(v));
  }

  /** Build from an integer count of minor units, e.g. paisa with `dp = 2`. */
  static fromMinor(minor: number | bigint, dp: number): Dec {
    const m = typeof minor === 'bigint' ? minor : BigInt(minor);
    return new Dec(m * pow10(SCALE_DIGITS - dp));
  }

  static zero(): Dec {
    return new Dec(ZERO);
  }

  static sum(values: readonly DecInput[]): Dec {
    return values.reduce<Dec>((acc, v) => acc.add(v), Dec.zero());
  }

  static max(a: DecInput, b: DecInput): Dec {
    const x = Dec.of(a);
    const y = Dec.of(b);
    return x.cmp(y) >= 0 ? x : y;
  }

  static min(a: DecInput, b: DecInput): Dec {
    const x = Dec.of(a);
    const y = Dec.of(b);
    return x.cmp(y) <= 0 ? x : y;
  }

  add(o: DecInput): Dec {
    return new Dec(this.units + Dec.of(o).units);
  }

  sub(o: DecInput): Dec {
    return new Dec(this.units - Dec.of(o).units);
  }

  mul(o: DecInput): Dec {
    return new Dec(divRound(this.units * Dec.of(o).units, SCALE));
  }

  div(o: DecInput): Dec {
    return new Dec(divRound(this.units * SCALE, Dec.of(o).units));
  }

  neg(): Dec {
    return new Dec(-this.units);
  }

  abs(): Dec {
    return this.units < ZERO ? this.neg() : this;
  }

  cmp(o: DecInput): -1 | 0 | 1 {
    const u = Dec.of(o).units;
    return this.units < u ? -1 : this.units > u ? 1 : 0;
  }

  gt(o: DecInput): boolean {
    return this.cmp(o) > 0;
  }

  gte(o: DecInput): boolean {
    return this.cmp(o) >= 0;
  }

  lt(o: DecInput): boolean {
    return this.cmp(o) < 0;
  }

  lte(o: DecInput): boolean {
    return this.cmp(o) <= 0;
  }

  isZero(): boolean {
    return this.units === ZERO;
  }

  isNeg(): boolean {
    return this.units < ZERO;
  }

  /** Round to `dp` fraction digits (half away from zero). */
  round(dp: number): Dec {
    const f = pow10(SCALE_DIGITS - dp);
    return new Dec(divRound(this.units, f) * f);
  }

  /** Round toward −∞ to `dp` digits (used for whole-share sizing). */
  floor(dp = 0): Dec {
    const f = pow10(SCALE_DIGITS - dp);
    let q = this.units / f;
    if (this.units < ZERO && this.units % f !== ZERO) q -= ONE;
    return new Dec(q * f);
  }

  /** Fixed-point string with exactly `dp` fraction digits, e.g. "-1234.50". */
  toFixed(dp: number): string {
    const f = pow10(SCALE_DIGITS - dp);
    const q = divRound(this.units, f);
    const neg = q < ZERO;
    const digits = (neg ? -q : q).toString().padStart(dp + 1, '0');
    const int = dp === 0 ? digits : digits.slice(0, -dp);
    const frac = dp === 0 ? '' : `.${digits.slice(-dp)}`;
    return `${neg && q !== ZERO ? '-' : ''}${int}${frac}`;
  }

  /** Canonical string without trailing zeros (at most 10 fraction digits). */
  toString(): string {
    const s = this.toFixed(SCALE_DIGITS);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }

  /**
   * DISPLAY-ONLY conversion for chart libraries that require numbers.
   * Never feed the result back into money arithmetic.
   */
  toNumber(): number {
    return Number(this.toFixed(SCALE_DIGITS));
  }
}

export const dec = Dec.of;
