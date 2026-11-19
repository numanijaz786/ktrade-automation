import {
  d,
  evaluateStock,
  type EvaluateStockInput,
  ktradeDefaultSchedule,
  type ResearchBar,
  type ResearchDataSource,
  type StockEvaluation,
} from '@ktrade/finance-core';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/config.module.js';
import { LlmExplainer, TemplateExplainer } from './explanation.js';

/** SYNTHETIC TEST DATA: deterministic formula, not market data. */
const WAVE = [0, 1, 2, 1, 0, -1, -2, -1] as const;
function syntheticBars(
  n: number,
  source: ResearchDataSource,
  slope: string,
  volume = 1_000_000,
): ResearchBar[] {
  const base = Date.UTC(2025, 0, 1);
  const out: ResearchBar[] = [];
  let prev = d('100');
  for (let i = 0; i < n; i++) {
    const c = d('100')
      .plus(d(slope).times(i))
      .plus(WAVE[i % 8] as number);
    const o = i === 0 ? c : prev;
    out.push({
      ts: new Date(base + i * 86_400_000).toISOString(),
      open: o,
      high: (o.gt(c) ? o : c).plus('0.5'),
      low: (o.lt(c) ? o : c).minus('0.5'),
      close: c,
      volume: d(String(volume))
        .times(20 + (i % 5))
        .div(20),
      source,
    });
    prev = c;
  }
  return out;
}

function input(bars: ResearchBar[]): EvaluateStockInput {
  const last = bars[bars.length - 1] as ResearchBar;
  return {
    symbol: 'SYNTH',
    sector: 'SYNTHETIC SECTOR',
    horizon: 'SWING',
    asOf: new Date(Date.parse(last.ts) + 6 * 3_600_000).toISOString(),
    bars,
    marketData: { priceAsOf: last.ts, freshnessLimitMinutes: 1440, delayMinutes: 0 },
    currency: 'PKR',
    portfolio: { equity: d('1000000'), cash: d('1000000'), holdingQty: d('0'), sectorExposurePct: d('0') },
    risk: {
      riskPerTradePct: d('1'),
      maxPositionPct: d('20'),
      maxSectorPct: d('40'),
      feeSchedule: ktradeDefaultSchedule('2024-01-01'),
    },
  };
}

const NUM = /(?<![A-Za-z_])\d+(?:\.\d+)?/g;
const numbersIn = (s: string): string[] => s.match(NUM) ?? [];

/** A number in the text is "from the evidence" if some evidence number equals it after rounding to the shown places. */
function derivable(text: string, evidence: unknown): string[] {
  const ev = numbersIn(JSON.stringify(evidence));
  const exact = new Set(ev);
  const bad: string[] = [];
  for (const t of numbersIn(text)) {
    if (exact.has(t)) continue;
    const dp = (t.split('.')[1] ?? '').length;
    const ok = ev.some((e) => d(e).toDecimalPlaces(dp).toFixed(dp) === d(t).toFixed(dp));
    if (!ok) bad.push(t);
  }
  return bad;
}

const flatten = (e: ReturnType<TemplateExplainer['explain']>): string =>
  [e.summary, ...e.bullets, ...e.risks, ...e.dataNotes].join('\n');

describe('TemplateExplainer', () => {
  const explainer = new TemplateExplainer();

  it('every number in an actionable explanation comes from the evidence object', () => {
    const ev = evaluateStock(input(syntheticBars(250, 'USER_REPORTED', '0.3')));
    expect(ev.status).toBe('ACTIONABLE');
    const e = explainer.explain(ev);
    expect(e.available).toBe(true);
    expect(derivable(flatten(e), ev)).toEqual([]);
    if (ev.plan) {
      expect(flatten(e)).toContain(ev.plan.stopLoss.toFixed(2));
    }
  });

  it('every number in a NOT_ACTIONABLE explanation comes from the evidence object', () => {
    for (const ev of [
      evaluateStock(input(syntheticBars(250, 'SIMULATED', '0.3'))),
      evaluateStock(input(syntheticBars(30, 'USER_REPORTED', '0.3'))),
    ]) {
      expect(ev.status).toBe('NOT_ACTIONABLE');
      const e = explainer.explain(ev);
      expect(e.summary.startsWith('No recommendation')).toBe(true);
      expect(derivable(flatten(e), ev)).toEqual([]);
    }
  });

  it('the checker itself rejects a number the evidence does not contain', () => {
    const ev: StockEvaluation = evaluateStock(input(syntheticBars(250, 'SIMULATED', '0.3')));
    expect(derivable('the target is 987654.32', ev)).toEqual(['987654.32']);
  });

  it('is deterministic', () => {
    const ev = evaluateStock(input(syntheticBars(250, 'USER_REPORTED', '0.3')));
    expect(explainer.explain(ev)).toEqual(explainer.explain(ev));
  });
});

describe('LlmExplainer (disabled stub)', () => {
  const ev = evaluateStock(input(syntheticBars(250, 'SIMULATED', '0.3')));
  const cfg = (v: string | undefined) => ({ get: () => v }) as unknown as AppConfig;

  it('reports that no LLM key is configured and never produces text', () => {
    const e = new LlmExplainer(cfg(undefined));
    expect(e.enabled).toBe(false);
    expect(e.explain(ev)).toMatchObject({ available: false, provider: 'llm' });
    expect(e.explain(ev).available === false && e.explain(ev)).toHaveProperty('reason');
    expect(JSON.stringify(e.explain(ev))).toContain('no LLM key configured');
  });

  it('stays disabled even when a provider name is set', () => {
    const e = new LlmExplainer(cfg('someprovider'));
    expect(e.enabled).toBe(false);
    expect(e.explain(ev).available).toBe(false);
  });
});
