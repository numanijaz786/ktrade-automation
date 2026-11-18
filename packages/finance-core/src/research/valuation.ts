/**
 * Valuation (docs/10, docs/12). Runs only when the caller supplies every input; refuses otherwise.
 * Every result separates REPORTED FACTS (sourced figures) from ASSUMPTIONS (caller-supplied, listed one by one).
 * Valuation is a model output, not a fact: it is never presented as the market's or the company's own figure.
 */
import { type Decimal, HUNDRED, ONE, sum } from '../decimal.js';
import { type RatioResult } from './fundamentals.js';
import { type ResearchDataSource } from './types.js';
import { fmt, median } from './util.js';

export interface ReportedFact {
  readonly name: string;
  readonly value: Decimal;
  readonly period: string;
  readonly currency: string;
  readonly source: ResearchDataSource;
}
export interface Assumption {
  readonly name: string;
  readonly value: string;
  /** Where the assumption comes from (e.g. "peer median of 4 peers", "owner input"). */
  readonly basis: string;
}

export type ValuationMethod = 'EARNINGS_MULTIPLE' | 'DDM' | 'DCF';
export interface ValuationOk {
  readonly status: 'OK';
  readonly method: ValuationMethod;
  /** Per-share value in `currency`. */
  readonly fairValue: Decimal;
  readonly currency: string;
  readonly facts: readonly ReportedFact[];
  readonly assumptions: readonly Assumption[];
  readonly explanation: readonly string[];
}
export interface ValuationUnavailable {
  readonly status: 'UNAVAILABLE';
  readonly method: ValuationMethod | 'PEER_MULTIPLES';
  readonly missing: readonly string[];
  readonly reason: string;
}
export type ValuationResult = ValuationOk | ValuationUnavailable;

const refuse = (
  method: ValuationUnavailable['method'],
  missing: readonly string[],
  reason: string,
): ValuationUnavailable => ({ status: 'UNAVAILABLE', method, missing, reason });

// ───────────────────────────── peers ─────────────────────────────

export interface PeerInput {
  readonly symbol: string;
  readonly pe?: Decimal | null;
  readonly pb?: Decimal | null;
  /** ISO date the peer multiples were computed. */
  readonly asOf: string;
  readonly source: ResearchDataSource;
}
export interface PeerMedian {
  readonly status: 'OK';
  readonly metric: 'pe' | 'pb';
  readonly median: Decimal;
  readonly count: number;
  readonly symbols: readonly string[];
}
export interface PeerComparison {
  readonly pe: PeerMedian | ValuationUnavailable;
  readonly pb: PeerMedian | ValuationUnavailable;
}

/** Median multiples from the supplied peers. Needs >= minPeers peers with a positive value for the metric. */
export function peerMedianMultiples(peers: readonly PeerInput[], minPeers = 3): PeerComparison {
  const one = (metric: 'pe' | 'pb'): PeerMedian | ValuationUnavailable => {
    const usable = peers.filter((p) => {
      const v = p[metric];
      return v !== undefined && v !== null && v.gt(0);
    });
    if (usable.length < minPeers) {
      return refuse(
        'PEER_MULTIPLES',
        [`peers with positive ${metric} (need ${minPeers}, have ${usable.length})`],
        `peer ${metric} median needs >= ${minPeers} peers with a positive multiple; ${usable.length} supplied`,
      );
    }
    return {
      status: 'OK',
      metric,
      median: median(usable.map((p) => p[metric] as Decimal)),
      count: usable.length,
      symbols: usable.map((p) => p.symbol).sort(),
    };
  };
  return { pe: one('pe'), pb: one('pb') };
}

/** Compare a stock's multiple with a peer median: % premium (+) / discount (-). */
export function relativeToPeers(multiple: Decimal, peerMedian: PeerMedian): Decimal {
  return multiple.minus(peerMedian.median).div(peerMedian.median).times(HUNDRED);
}

// ───────────────────────────── earnings multiple ─────────────────────────────

export interface EarningsMultipleInput {
  /** Annual EPS ratio result (from annualEps). */
  readonly annualEps: RatioResult;
  /** Justified P/E and where it comes from (a peer median or a supplied historical multiple). */
  readonly justifiedPe: { readonly value: Decimal; readonly basis: string } | null | undefined;
  readonly priceCurrency: string;
}

export function earningsFairValue(input: EarningsMultipleInput): ValuationResult {
  const m = 'EARNINGS_MULTIPLE' as const;
  if (input.annualEps.status === 'UNAVAILABLE') {
    return refuse(m, input.annualEps.missing, `annual EPS unavailable: ${input.annualEps.reason}`);
  }
  if (!input.justifiedPe)
    return refuse(m, ['justified P/E (peer or historical multiple)'], 'no justified P/E supplied');
  const eps = input.annualEps;
  const first = eps.inputs[0];
  if (!first) return refuse(m, ['EPS provenance'], 'EPS has no provenance');
  if (first.currency !== input.priceCurrency) {
    return refuse(m, [], `EPS currency ${first.currency} differs from price currency ${input.priceCurrency}`);
  }
  if (!eps.value.gt(0)) return refuse(m, [], `annual EPS ${eps.value.toString()} is not positive`);
  if (!input.justifiedPe.value.gt(0)) return refuse(m, [], 'justified P/E must be > 0');
  const fv = eps.value.times(input.justifiedPe.value);
  return {
    status: 'OK',
    method: m,
    fairValue: fv,
    currency: first.currency,
    facts: [
      {
        name: 'annualEps',
        value: eps.value,
        period: first.period,
        currency: first.currency,
        source: first.source,
      },
    ],
    assumptions: [
      { name: 'justifiedPe', value: fmt(input.justifiedPe.value), basis: input.justifiedPe.basis },
      ...eps.flags.map((f) => ({ name: 'epsAnnualisation', value: 'x4', basis: f })),
    ],
    explanation: [
      `fair value = annual EPS ${fmt(eps.value)} x justified P/E ${fmt(input.justifiedPe.value)} = ${fmt(fv)}`,
    ],
  };
}

// ───────────────────────────── dividend discount model ─────────────────────────────

export interface DdmInput {
  /** Last full-year dividend per share (a reported fact). */
  readonly lastAnnualDps: ReportedFact | null | undefined;
  /** Perpetual dividend growth, in percent. Assumption. */
  readonly growthPct: Decimal | null | undefined;
  /** Required return (cost of equity), in percent. Assumption. */
  readonly requiredReturnPct: Decimal | null | undefined;
  readonly growthBasis?: string;
  readonly requiredReturnBasis?: string;
}

/** Gordon growth: V = D0 (1 + g) / (r - g); refuses unless r > g. */
export function gordonGrowth(input: DdmInput): ValuationResult {
  const m = 'DDM' as const;
  const missing: string[] = [];
  if (!input.lastAnnualDps) missing.push('lastAnnualDps');
  if (input.growthPct === null || input.growthPct === undefined) missing.push('growthPct');
  if (input.requiredReturnPct === null || input.requiredReturnPct === undefined)
    missing.push('requiredReturnPct');
  if (missing.length > 0) return refuse(m, missing, `DDM inputs missing: ${missing.join(', ')}`);
  const dps = input.lastAnnualDps as ReportedFact;
  const g = (input.growthPct as Decimal).div(HUNDRED);
  const r = (input.requiredReturnPct as Decimal).div(HUNDRED);
  if (!dps.value.gt(0)) return refuse(m, [], 'last annual dividend must be > 0');
  if (!r.gt(0)) return refuse(m, [], 'required return must be > 0');
  if (!r.gt(g))
    return refuse(
      m,
      [],
      `required return ${fmt(r.times(HUNDRED))}% must exceed growth ${fmt(g.times(HUNDRED))}% (Gordon growth needs g < r)`,
    );
  const fv = dps.value.times(ONE.plus(g)).div(r.minus(g));
  return {
    status: 'OK',
    method: m,
    fairValue: fv,
    currency: dps.currency,
    facts: [dps],
    assumptions: [
      {
        name: 'dividendGrowthPct',
        value: fmt(g.times(HUNDRED)),
        basis: input.growthBasis ?? 'caller-supplied',
      },
      {
        name: 'requiredReturnPct',
        value: fmt(r.times(HUNDRED)),
        basis: input.requiredReturnBasis ?? 'caller-supplied',
      },
    ],
    explanation: [
      `V = D0 ${fmt(dps.value)} x (1 + ${fmt(g, 4)}) / (${fmt(r, 4)} - ${fmt(g, 4)}) = ${fmt(fv)}`,
    ],
  };
}

// ───────────────────────────── simple DCF ─────────────────────────────

export interface DcfInput {
  /** Latest annual free cash flow (a reported fact, total currency amount). */
  readonly baseFcf: ReportedFact | null | undefined;
  readonly growthPct: Decimal | null | undefined;
  readonly years: number | null | undefined;
  readonly terminalGrowthPct: Decimal | null | undefined;
  readonly discountRatePct: Decimal | null | undefined;
  /** Debt minus cash, in the same currency. Must be supplied explicitly (0 is allowed). */
  readonly netDebt: ReportedFact | null | undefined;
  readonly sharesOutstanding: ReportedFact | null | undefined;
  readonly basis?: string;
}

/**
 * Two-stage DCF: FCF_t = FCF_0 (1+g)^t for t = 1..years, terminal value = FCF_years (1+gT) / (r - gT),
 * all discounted at r; equity = EV - net debt; per share = equity / shares. Refuses unless every input is
 * supplied, FCF_0 > 0, r > gT and shares > 0.
 */
export function simpleDcf(input: DcfInput): ValuationResult {
  const m = 'DCF' as const;
  const missing: string[] = [];
  const req: [string, unknown][] = [
    ['baseFcf', input.baseFcf],
    ['growthPct', input.growthPct],
    ['years', input.years],
    ['terminalGrowthPct', input.terminalGrowthPct],
    ['discountRatePct', input.discountRatePct],
    ['netDebt', input.netDebt],
    ['sharesOutstanding', input.sharesOutstanding],
  ];
  for (const [k, v] of req) if (v === null || v === undefined) missing.push(k);
  if (missing.length > 0) return refuse(m, missing, `DCF assumptions missing: ${missing.join(', ')}`);
  const fcf = input.baseFcf as ReportedFact;
  const nd = input.netDebt as ReportedFact;
  const sh = input.sharesOutstanding as ReportedFact;
  const years = input.years as number;
  if (!Number.isSafeInteger(years) || years < 1 || years > 30)
    return refuse(m, [], 'years must be an integer 1..30');
  if (fcf.currency !== nd.currency) return refuse(m, [], 'FCF and net debt currencies differ');
  if (!fcf.value.gt(0)) return refuse(m, [], `base free cash flow ${fcf.value.toString()} is not positive`);
  if (!sh.value.gt(0)) return refuse(m, [], 'shares outstanding must be > 0');
  const g = (input.growthPct as Decimal).div(HUNDRED);
  const gt = (input.terminalGrowthPct as Decimal).div(HUNDRED);
  const r = (input.discountRatePct as Decimal).div(HUNDRED);
  if (!r.gt(0)) return refuse(m, [], 'discount rate must be > 0');
  if (!r.gt(gt)) return refuse(m, [], 'discount rate must exceed terminal growth');
  const flows: Decimal[] = [];
  let f = fcf.value;
  for (let t = 1; t <= years; t++) {
    f = f.times(ONE.plus(g));
    flows.push(f.div(ONE.plus(r).pow(t)));
  }
  const tv = f.times(ONE.plus(gt)).div(r.minus(gt)).div(ONE.plus(r).pow(years));
  const ev = sum(flows).plus(tv);
  const equity = ev.minus(nd.value);
  const fv = equity.div(sh.value);
  if (!fv.gt(0)) return refuse(m, [], `DCF equity value per share ${fmt(fv)} is not positive`);
  const basis = input.basis ?? 'caller-supplied';
  return {
    status: 'OK',
    method: m,
    fairValue: fv,
    currency: fcf.currency,
    facts: [fcf, nd, sh],
    assumptions: [
      { name: 'fcfGrowthPct', value: fmt(g.times(HUNDRED)), basis },
      { name: 'explicitYears', value: String(years), basis },
      { name: 'terminalGrowthPct', value: fmt(gt.times(HUNDRED)), basis },
      { name: 'discountRatePct', value: fmt(r.times(HUNDRED)), basis },
    ],
    explanation: [
      `PV of ${years} explicit FCFs ${fmt(sum(flows), 0)} + PV of terminal value ${fmt(tv, 0)} = EV ${fmt(ev, 0)}`,
      `equity ${fmt(equity, 0)} / ${fmt(sh.value, 0)} shares = ${fmt(fv)} per share`,
    ],
  };
}

// ───────────────────────────── margin of safety & summary ─────────────────────────────

/** Margin of safety % = (fair - price) / fair x 100. Positive = price below fair value. Null if fair <= 0. */
export function marginOfSafetyPct(fairValue: Decimal, price: Decimal): Decimal | null {
  return fairValue.gt(0) ? fairValue.minus(price).div(fairValue).times(HUNDRED) : null;
}

export interface ValuationSummary {
  readonly status: 'OK' | 'UNAVAILABLE';
  readonly methods: readonly ValuationResult[];
  /** Lowest / highest fair value among OK methods (the lowest is the conservative one used for margin of safety). */
  readonly fairValueLow: Decimal | null;
  readonly fairValueHigh: Decimal | null;
  readonly marginOfSafetyPct: Decimal | null;
  readonly reportedFacts: readonly ReportedFact[];
  readonly assumptions: readonly Assumption[];
  readonly explanation: readonly string[];
}

export function summariseValuation(
  price: Decimal,
  priceCurrency: string,
  methods: readonly ValuationResult[],
): ValuationSummary {
  const ok = methods.filter((x): x is ValuationOk => x.status === 'OK' && x.currency === priceCurrency);
  const wrongCcy = methods.filter((x): x is ValuationOk => x.status === 'OK' && x.currency !== priceCurrency);
  const explanation = [
    ...wrongCcy.map(
      (x) => `${x.method} ignored: currency ${x.currency} differs from price currency ${priceCurrency}`,
    ),
    ...methods.flatMap((x) => (x.status === 'UNAVAILABLE' ? [`${x.method} unavailable: ${x.reason}`] : [])),
  ];
  if (ok.length === 0) {
    return {
      status: 'UNAVAILABLE',
      methods,
      fairValueLow: null,
      fairValueHigh: null,
      marginOfSafetyPct: null,
      reportedFacts: [],
      assumptions: [],
      explanation,
    };
  }
  const values = ok.map((x) => x.fairValue).sort((a, b) => a.cmp(b));
  const low = values[0] as Decimal;
  const high = values[values.length - 1] as Decimal;
  const seen = new Set<string>();
  const assumptions: Assumption[] = [];
  for (const a of ok.flatMap((x) => x.assumptions)) {
    const k = `${a.name}|${a.value}|${a.basis}`;
    if (!seen.has(k)) {
      seen.add(k);
      assumptions.push(a);
    }
  }
  const mos = marginOfSafetyPct(low, price);
  explanation.push(
    `fair value range ${fmt(low)}..${fmt(high)} from ${ok.length} method(s); margin of safety vs the lowest = ${mos === null ? 'n/a' : fmt(mos) + '%'}`,
  );
  return {
    status: 'OK',
    methods,
    fairValueLow: low,
    fairValueHigh: high,
    marginOfSafetyPct: mos,
    reportedFacts: ok.flatMap((x) => x.facts),
    assumptions,
    explanation,
  };
}
