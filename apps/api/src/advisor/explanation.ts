import { Injectable } from '@nestjs/common';
import { type Horizon, type RecommendationAction, type StockEvaluation } from '@ktrade/finance-core';
import { AppConfig } from '../config/config.module.js';

/**
 * Explanation layer (docs/10 §3, ADR-035): an explainer may only RE-STATE evidence the deterministic engine already
 * produced. It never computes a price, target, score or ratio, and never adds a number of its own.
 */
export interface Explanation {
  readonly available: true;
  readonly provider: string;
  readonly summary: string;
  /** The rule evidence behind the call, each with its metric value and threshold. */
  readonly bullets: readonly string[];
  /** What would make the call wrong, plus the engine's warnings. */
  readonly risks: readonly string[];
  /** Where the data came from and what was missing. */
  readonly dataNotes: readonly string[];
}
export interface ExplanationUnavailable {
  readonly available: false;
  readonly provider: string;
  readonly reason: string;
}
export type ExplanationResult = Explanation | ExplanationUnavailable;

export interface ExplanationProvider {
  readonly name: string;
  explain(evaluation: StockEvaluation): ExplanationResult;
}

const HORIZON_WORDS: Readonly<Record<Horizon, string>> = {
  SHORT_TERM: 'short-term',
  SWING: 'swing-trade',
  LONG_TERM: 'long-term',
  DIVIDEND: 'dividend-income',
  VALUE: 'value',
  GROWTH: 'growth',
};

const ACTION_WORDS: Readonly<Record<RecommendationAction, string>> = {
  STRONG_BUY: 'a strong buy',
  BUY: 'a buy',
  HOLD: 'a hold, with no strong opportunity to act on',
  WATCHLIST: 'one to watch but not to buy yet',
  SELL: 'a sell for a current holder',
  AVOID: 'one to avoid for now',
};

/** Prices and amounts shown to 2 decimals; the underlying evidence keeps full precision. */
const money = (x: { toFixed(dp: number): string }): string => x.toFixed(2);

/**
 * Simple-English explanations built ONLY from the engine's evidence: rule texts (metric value + threshold), the
 * plan numbers, invalidation conditions, warnings and data-quality fields. Deterministic: same evidence, same text.
 */
@Injectable()
export class TemplateExplainer implements ExplanationProvider {
  readonly name = 'template';

  explain(ev: StockEvaluation): Explanation {
    const horizon = HORIZON_WORDS[ev.horizon];
    const dq = ev.dataQuality;
    const dataNotes: string[] = [];
    if (dq.sourcesUsed.length > 0) dataNotes.push(`Price data sources: ${dq.sourcesUsed.join(', ')}.`);
    if (dq.latestBarSource) dataNotes.push(`The latest price bar is ${dq.latestBarSource}.`);
    for (const m of dq.missingInputs) dataNotes.push(`Missing: ${m}.`);
    for (const w of dq.warnings) dataNotes.push(w);

    if (ev.status === 'NOT_ACTIONABLE' || ev.action === null) {
      const [first, ...rest] = ev.notActionableReasons;
      return {
        available: true,
        provider: this.name,
        summary: `No recommendation for ${ev.symbol} on the ${horizon} view: ${first ?? 'not enough evidence'}.`,
        bullets: rest,
        risks: [],
        dataNotes,
      };
    }

    const bullets = ev.reasons
      .slice(0, 5)
      .map((r) => `${r.supports === 'BULLISH' ? 'For' : 'Against'}: ${r.text}`);
    const risks = [
      ...ev.invalidation.slice(0, 3),
      ...ev.watchFor.map((w) => `Wait for: ${w}`),
      ...ev.warnings,
    ];
    let summary = `${ev.symbol} looks like ${ACTION_WORDS[ev.action]} on the ${horizon} view`;
    if (ev.confidence)
      summary += ` (confidence ${money(ev.confidence.score)} out of 100, ${ev.confidence.level.toLowerCase()})`;
    summary += `. ${ev.headline}`;
    if (ev.plan) {
      const p = ev.plan;
      bullets.push(
        `Plan: buy between ${money(p.entryLow)} and ${money(p.entryHigh)}; stop-loss at ${money(p.stopLoss)} (${p.stopBasis}).`,
      );
      bullets.push(
        `Targets: ${p.targets.map((t) => `Target ${t.n} at ${money(t.price)} (risk to reward ${money(t.riskReward)})`).join('; ')}.`,
      );
      bullets.push(
        `Suggested size: ${p.quantity.toFixed(0)} shares, about ${money(p.estimatedBuyCost)} including ${money(p.estimatedBuyFees)} in fees; the most you would lose at the stop is ${money(p.maxLoss)}.`,
      );
    }
    return { available: true, provider: this.name, summary, bullets, risks, dataNotes };
  }
}

/**
 * Disabled LLM explainer. It reports why it is off and NEVER makes a network call: there is no client in this
 * module. Even with ADVISOR_LLM_PROVIDER set it stays disabled until a provider integration is reviewed (ADR-035).
 */
@Injectable()
export class LlmExplainer implements ExplanationProvider {
  readonly name = 'llm';

  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean {
    return false;
  }

  explain(_evaluation: StockEvaluation): ExplanationUnavailable {
    const provider = this.config.get('ADVISOR_LLM_PROVIDER');
    return {
      available: false,
      provider: this.name,
      reason: provider
        ? `ADVISOR_LLM_PROVIDER=${provider} is set but no LLM integration is enabled; no network call is made`
        : 'no LLM key configured (ADVISOR_LLM_PROVIDER is unset); the template explanation is used',
    };
  }
}
