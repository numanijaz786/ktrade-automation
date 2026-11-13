/**
 * XIRR — money-weighted return over dated cash flows (docs/06 §5), Decimal throughout.
 *
 * Sign convention (investor's view): contributions/deposits are NEGATIVE, withdrawals and the
 * terminal account value are POSITIVE. Day count actual/365 from the earliest flow:
 *   NPV(r) = Σ a_i · (1 + r)^(−t_i),  t_i = days(d_0, d_i) / 365
 * Newton–Raphson from `guess`; falls back to (geometric) bisection on a bracketed root if Newton leaves
 * the domain (r ≤ −1), hits a zero derivative or fails to converge.
 */
import { type Decimal, type DecimalInput, d, fromInt, ONE, ZERO } from '../decimal.js';
import { daysBetween } from '../fees/isoDate.js';

export interface XirrCashFlow {
  date: string;
  amount: DecimalInput;
}

export interface XirrOptions {
  /** Starting rate for Newton. Default 0.1. */
  guess?: DecimalInput;
  /** Convergence tolerance on the rate step, relative to (1 + rate). Default 1e-12. */
  tolerance?: DecimalInput;
  /** Newton iteration cap. Default 100. */
  maxIterations?: number;
}

export class XirrError extends Error {
  constructor(
    public readonly code: 'INVALID_CASHFLOWS' | 'NO_CONVERGENCE',
    message: string,
  ) {
    super(message);
    this.name = 'XirrError';
  }
}

interface Flow {
  t: Decimal;
  a: Decimal;
}

const DAYS_PER_YEAR = fromInt(365);
const TWO = fromInt(2);

/*
 * The solver works on the growth factor g = 1 + r ∈ (0, ∞) rather than on r: near a −100% return
 * r is indistinguishable from −1 at any fixed precision, whereas g stays well-scaled.
 */

/** NPV as a function of g: Σ a_i · g^(−t_i). */
function npvG(flows: readonly Flow[], g: Decimal): Decimal {
  let acc = ZERO;
  for (const f of flows) acc = acc.plus(f.a.div(g.pow(f.t)));
  return acc;
}

/** dNPV/dg = Σ −t_i · a_i · g^(−t_i − 1). */
function dNpvG(flows: readonly Flow[], g: Decimal): Decimal {
  let acc = ZERO;
  for (const f of flows) {
    if (f.t.isZero()) continue;
    acc = acc.minus(f.t.times(f.a).div(g.pow(f.t.plus(ONE))));
  }
  return acc;
}

function newton(flows: readonly Flow[], guessG: Decimal, tol: Decimal, maxIter: number): Decimal | null {
  let g = guessG;
  for (let i = 0; i < maxIter; i++) {
    if (!g.gt(ZERO)) return null;
    const deriv = dNpvG(flows, g);
    if (deriv.isZero()) return null;
    const step = npvG(flows, g).div(deriv);
    const next = g.minus(step);
    if (step.abs().lte(tol.times(g))) return next.gt(ZERO) ? next : null;
    g = next;
  }
  return null;
}

/** Geometric bisection on g (bisects ln g), expanding the bracket towards 0 and ∞ as needed. */
function bisection(flows: readonly Flow[], tol: Decimal): Decimal | null {
  let lo = d('1e-6');
  let hi = TWO;
  let fLo = npvG(flows, lo);
  let fHi = npvG(flows, hi);
  for (let i = 0; i < 12 && fLo.s === fHi.s && !fLo.isZero() && !fHi.isZero(); i++) {
    lo = lo.times(lo); // 1e-12, 1e-24, … 1e-24576
    hi = hi.times(hi); // 4, 16, 256, … 2^4096
    fLo = npvG(flows, lo);
    fHi = npvG(flows, hi);
  }
  if (fLo.isZero()) return lo;
  if (fHi.isZero()) return hi;
  if (fLo.s === fHi.s) return null;
  const sLo = fLo.s;
  for (let i = 0; i < 2000; i++) {
    const mid = lo.times(hi).sqrt();
    const fMid = npvG(flows, mid);
    if (fMid.isZero() || hi.div(lo).minus(ONE).lte(tol)) return mid;
    if (fMid.s === sLo) lo = mid;
    else hi = mid;
  }
  return null;
}

/** Annualised money-weighted return (fraction, unrounded — round for display). Throws XirrError. */
export function xirr(cashflows: readonly XirrCashFlow[], options: XirrOptions = {}): Decimal {
  if (cashflows.length < 2) throw new XirrError('INVALID_CASHFLOWS', 'XIRR needs at least two cash flows');
  const parsed = cashflows.map((c) => ({ date: c.date, a: d(c.amount) }));
  if (!parsed.some((c) => c.a.gt(0)) || !parsed.some((c) => c.a.lt(0))) {
    throw new XirrError('INVALID_CASHFLOWS', 'XIRR needs at least one positive and one negative cash flow');
  }
  let first = parsed[0]?.date as string;
  for (const c of parsed) if (c.date < first) first = c.date;
  const flows: Flow[] = parsed.map((c) => ({
    t: fromInt(daysBetween(first, c.date)).div(DAYS_PER_YEAR),
    a: c.a,
  }));

  const tol = d(options.tolerance ?? '1e-12');
  const maxIter = options.maxIterations ?? 100;
  if (!Number.isSafeInteger(maxIter) || maxIter < 1)
    throw new RangeError('maxIterations must be a positive integer');
  const g = newton(flows, ONE.plus(d(options.guess ?? '0.1')), tol, maxIter) ?? bisection(flows, tol);
  if (g === null) throw new XirrError('NO_CONVERGENCE', 'XIRR did not converge (no bracketed root)');
  // NB: for annualised losses within ~1e-34 of −100%, g − 1 rounds to exactly −1 at precision 34.
  return g.minus(ONE);
}

/** Net present value at annual rate `rate` (actual/365) — exposed for verification and tests. */
export function xnpv(rate: DecimalInput, cashflows: readonly XirrCashFlow[]): Decimal {
  if (cashflows.length === 0) return ZERO;
  const r = d(rate);
  if (!r.gt(-1)) throw new RangeError('rate must be > −1');
  let first = cashflows[0]?.date as string;
  for (const c of cashflows) if (c.date < first) first = c.date;
  return npvG(
    cashflows.map((c) => ({ t: fromInt(daysBetween(first, c.date)).div(DAYS_PER_YEAR), a: d(c.amount) })),
    ONE.plus(r),
  );
}
