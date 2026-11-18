import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { d } from '../decimal.js';
import { ktradeDefaultSchedule } from '../fees/engine.js';
import { computeTradeFees } from '../fees/engine.js';
import { evaluateAllHorizons, evaluateStock } from './evaluate.js';
import { asOfAfter, bar, D, driftBars, isoDay, prior, statement, stockInput } from './fixtures.js';
import { evaluateHolding } from './holding.js';
import { type EvaluateStockInput, type StockEvaluation, SIMULATED_REASON } from './rec-types.js';
import { RULE_TABLE } from './rules.js';
import { rankOpportunities } from './scanner.js';
import { HORIZONS, type ResearchBar } from './types.js';

const peers = (pe: string[]) =>
  pe.map((v, i) => ({
    symbol: `P${i}`,
    pe: d(v),
    pb: null,
    asOf: '2025-08-30',
    source: 'USER_REPORTED' as const,
  }));

const fundamentalsBundle = (pes = ['16', '18', '20']) => ({
  current: statement(),
  priorYear: prior(),
  peers: peers(pes),
});

const downBars = (): ResearchBar[] => driftBars(250, { start: '300', slope: '-0.3' });

describe('hard gating', () => {
  it('SIMULATED latest bar => NOT_ACTIONABLE, exact reason, and NO entry/stop/targets/size/action — every horizon', () => {
    const bars = driftBars(250, { source: 'SIMULATED' });
    for (const horizon of HORIZONS) {
      const ev = evaluateStock(stockInput({ bars, horizon, fundamentals: fundamentalsBundle() }));
      expect(ev.status).toBe('NOT_ACTIONABLE');
      expect(ev.action).toBeNull();
      expect(ev.notActionableReasons).toEqual(['simulated data — not for investment decisions']);
      expect(SIMULATED_REASON).toBe('simulated data — not for investment decisions');
      expect(ev.plan).toBeNull();
      expect(ev.confidence).toBeNull();
      const json = JSON.stringify(ev);
      expect(json).not.toContain('"entryLow"');
      expect(json).not.toContain('"stopLoss"');
      expect(json).not.toContain('"targets"');
    }
  });

  it('a SIMULATED latest bar wins even when older bars are real', () => {
    const bars = driftBars(250);
    bars[249] = { ...(bars[249] as ResearchBar), source: 'SIMULATED' };
    const ev = evaluateStock(stockInput({ bars }));
    expect(ev.status).toBe('NOT_ACTIONABLE');
    expect(ev.notActionableReasons[0]).toBe(SIMULATED_REASON);
  });

  it('older SIMULATED bars do not gate but are disclosed and cost data-quality score', () => {
    const bars = driftBars(250);
    bars[200] = { ...(bars[200] as ResearchBar), source: 'SIMULATED' };
    const ev = evaluateStock(stockInput({ bars }));
    expect(ev.status).toBe('ACTIONABLE');
    expect(ev.dataQuality.sourcesUsed).toEqual(['PROVIDER', 'SIMULATED']);
    expect(ev.dataQuality.nonConfirmedBarsInWindow).toBe(1);
    expect(ev.warnings.join(' ')).toContain('SIMULATED/ESTIMATED');
    const dq = ev.confidence?.components.find((c) => c.name === 'DATA_QUALITY');
    expect(dq?.score.toString()).toBe('72.5'); // 100 - 20 (non-confirmed bars) - 7.5 (price 360 of 1440 min old)
  });

  it('fewer bars than required => NOT_ACTIONABLE (60 short/swing, 200 long)', () => {
    for (const horizon of ['SHORT_TERM', 'SWING'] as const) {
      const ev = evaluateStock(stockInput({ bars: driftBars(59), horizon }));
      expect(ev.status).toBe('NOT_ACTIONABLE');
      expect(ev.notActionableReasons[0]).toContain('insufficient history: 59 daily bars, 60 required for');
      const ok = evaluateStock(stockInput({ bars: driftBars(60), horizon }));
      expect(ok.notActionableReasons.join(' ')).not.toContain('insufficient history');
    }
    const long = evaluateStock(
      stockInput({ bars: driftBars(199), horizon: 'LONG_TERM', fundamentals: fundamentalsBundle() }),
    );
    expect(long.status).toBe('NOT_ACTIONABLE');
    expect(long.notActionableReasons[0]).toContain('199 daily bars, 200 required');
    const long200 = evaluateStock(
      stockInput({ bars: driftBars(200), horizon: 'LONG_TERM', fundamentals: fundamentalsBundle() }),
    );
    expect(long200.notActionableReasons.join(' ')).not.toContain('insufficient history');
  });

  it('stale latest price => NOT_ACTIONABLE', () => {
    const bars = driftBars(250);
    const last = bars[249] as ResearchBar;
    const asOf = new Date(Date.parse(last.ts) + 3 * 86_400_000).toISOString();
    const ev = evaluateStock(
      stockInput({ bars, asOf, marketData: { priceAsOf: last.ts, freshnessLimitMinutes: 60 } }),
    );
    expect(ev.status).toBe('NOT_ACTIONABLE');
    expect(ev.notActionableReasons[0]).toContain(
      'latest price is stale: 4320 minutes old, freshness limit 60 minutes',
    );
    expect(ev.plan).toBeNull();
    // within the limit it passes
    const fresh = evaluateStock(
      stockInput({ bars, asOf, marketData: { priceAsOf: last.ts, freshnessLimitMinutes: 5000 } }),
    );
    expect(fresh.status).toBe('ACTIONABLE');
  });

  it('price timestamp after the decision time is rejected', () => {
    const bars = driftBars(250);
    const ev = evaluateStock(
      stockInput({ bars, marketData: { priceAsOf: '2099-01-01T00:00:00.000Z', freshnessLimitMinutes: 60 } }),
    );
    expect(ev.notActionableReasons[0]).toContain('after the decision time');
  });

  it('invalid bars (not ascending / inconsistent OHLC) => NOT_ACTIONABLE', () => {
    const bars = driftBars(250);
    const swapped = [...bars];
    swapped[100] = bars[101] as ResearchBar;
    swapped[101] = bars[100] as ResearchBar;
    expect(evaluateStock(stockInput({ bars: swapped })).notActionableReasons[0]).toContain(
      'strictly ascending',
    );
    const bad = [...bars];
    bad[50] = { ...(bars[50] as ResearchBar), high: d('1') };
    expect(evaluateStock(stockInput({ bars: bad })).notActionableReasons[0]).toContain('inconsistent OHLC');
    const none = evaluateStock(
      stockInput({
        bars: [],
        asOf: isoDay(300),
        marketData: { priceAsOf: isoDay(300), freshnessLimitMinutes: 60 },
      }),
    );
    expect(none.notActionableReasons[0]).toBe('no price bars supplied');
  });

  it('low liquidity caps the action at WATCHLIST/AVOID (never a BUY), no plan, with a warning', () => {
    const bars = driftBars(250, { volume: 1000 });
    for (const horizon of ['SHORT_TERM', 'SWING'] as const) {
      const ev = evaluateStock(stockInput({ bars, horizon }));
      expect(ev.status).toBe('ACTIONABLE');
      expect(['WATCHLIST', 'AVOID', 'HOLD']).toContain(ev.action);
      expect(ev.action).not.toBe('BUY');
      expect(ev.action).not.toBe('STRONG_BUY');
      expect(ev.plan).toBeNull();
      expect(ev.warnings.join(' ')).toContain('illiquid');
      expect(ev.headline).toContain('liquidity floor');
    }
  });

  it('a configurable liquidity floor lets the same stock through', () => {
    const bars = driftBars(250, { volume: 1000 });
    const ev = evaluateStock(stockInput({ bars, config: { liquidityFloorTradedValue: d('1000') } }));
    expect(ev.warnings.join(' ')).not.toContain('illiquid');
  });

  it('fundamental horizons need fundamentals, others do not', () => {
    for (const horizon of ['LONG_TERM', 'DIVIDEND', 'VALUE', 'GROWTH'] as const) {
      const ev = evaluateStock(stockInput({ horizon }));
      expect(ev.status).toBe('NOT_ACTIONABLE');
      expect(ev.notActionableReasons[0]).toBe(`${horizon} requires fundamentals; none supplied`);
      expect(ev.dataQuality.missingInputs).toContain('fundamentals');
    }
    for (const horizon of ['SHORT_TERM', 'SWING'] as const) {
      expect(evaluateStock(stockInput({ horizon })).status).toBe('ACTIONABLE');
    }
  });

  it('unusable (stale) fundamentals => NOT_ACTIONABLE for the fundamental horizon, with the reason', () => {
    const ev = evaluateStock(
      stockInput({
        horizon: 'LONG_TERM',
        fundamentals: { current: statement({ publishedAt: '2023-01-01T00:00:00.000Z' }) },
      }),
    );
    expect(ev.status).toBe('NOT_ACTIONABLE');
    expect(ev.notActionableReasons[0]).toContain('requires usable fundamentals');
    expect(ev.notActionableReasons[0]).toContain('stale');
  });

  it('bars after the decision time are ignored and reported', () => {
    const bars = driftBars(260);
    const asOf = asOfAfter(bars.slice(0, 250));
    const ev = evaluateStock(
      stockInput({ bars, asOf, marketData: { priceAsOf: bars[249]!.ts, freshnessLimitMinutes: 2000 } }),
    );
    expect(ev.dataQuality.ignoredFutureBars).toBe(10);
    expect(ev.dataQuality.barsUsed).toBe(250);
    expect(ev.dataQuality.latestBarTs).toBe(bars[249]!.ts);
  });
});

describe('BUY recommendation on a synthetic uptrend', () => {
  const ev = evaluateStock(stockInput({ horizon: 'SWING' }));
  const plan = ev.plan!;
  const close = driftBars(250)[249]!.close;

  it('is actionable with a complete plan', () => {
    expect(ev.status).toBe('ACTIONABLE');
    expect(['BUY', 'STRONG_BUY']).toContain(ev.action);
    expect(plan).not.toBeNull();
    expect(plan.targets).toHaveLength(3);
    expect(ev.invalidation.length).toBeGreaterThan(2);
    expect(ev.disclaimer).toContain('Not financial advice');
  });

  it('entry is never above the last close (+ tolerance), the stop is below the entry range', () => {
    expect(plan.entryHigh.lte(close)).toBe(true);
    expect(plan.entryLow.lte(plan.entryHigh)).toBe(true);
    expect(plan.stopLoss.lt(plan.entryLow)).toBe(true);
    expect(plan.stopLoss.gt(0)).toBe(true);
    const tol = evaluateStock(
      stockInput({ config: { entryTolerancePct: d('0.5'), minRiskReward: d('1') } }),
    ).plan!;
    expect(tol.entryHigh.lte(close.times('1.005'))).toBe(true);
  });

  it('targets strictly increase, sit above the entry, and risk:reward is (T - entry)/(entry - stop)', () => {
    let prev = plan.entryHigh;
    for (const t of plan.targets) {
      expect(t.price.gt(prev)).toBe(true);
      prev = t.price;
      const rr = t.price.minus(plan.entryHigh).div(plan.entryHigh.minus(plan.stopLoss));
      expect(t.riskReward.toString()).toBe(rr.toString());
      expect(t.basis.length).toBeGreaterThan(0);
      expect(t.netRiskReward!.lt(t.riskReward)).toBe(true); // fees reduce reward and add to risk
    }
    expect(plan.targets[1]!.riskReward.gte(1.5)).toBe(true);
    expect(plan.downsidePct.gt(0) && plan.targets[0]!.upsidePct.gt(0)).toBe(true);
  });

  it('size respects risk per trade, max position, cash and fees', () => {
    const q = plan.quantity;
    expect(q.gt(0)).toBe(true);
    expect(q.eq(q.floor())).toBe(true);
    const riskAmount = plan.entryHigh.minus(plan.stopLoss).times(q);
    expect(riskAmount.lte(d('1000000').times('0.01'))).toBe(true);
    expect(plan.allocationPct.lte(20)).toBe(true);
    const fees = computeTradeFees(ktradeDefaultSchedule('2024-01-01'), {
      side: 'BUY',
      quantity: q,
      price: plan.entryHigh,
    });
    expect(plan.estimatedBuyFees.toString()).toBe(fees.total.toString());
    expect(plan.estimatedBuyCost.lte(1000000)).toBe(true);
    expect(plan.maxLoss.gt(riskAmount)).toBe(true); // + fees
    expect(plan.holdingPeriod.label).toContain('weeks');
  });

  it('a small cash balance binds the size', () => {
    const small = evaluateStock(
      stockInput({ portfolio: { equity: d('1000000'), cash: d('20000'), holdingQty: d('0') } }),
    );
    if (small.plan) {
      expect(small.plan.estimatedBuyCost.lte(20000)).toBe(true);
      expect(small.plan.sizingBinding).toBe('BUDGET');
    } else {
      expect(small.action).toBe('WATCHLIST');
    }
    const none = evaluateStock(
      stockInput({ portfolio: { equity: d('1000000'), cash: d('100'), holdingQty: d('0') } }),
    );
    expect(none.plan).toBeNull();
    expect(none.action).toBe('WATCHLIST');
    expect(none.headline).toContain('position size is 0');
  });

  it('every reason cites a metric value and a threshold', () => {
    expect(ev.reasons.length).toBeGreaterThan(3);
    for (const r of ev.reasons) {
      expect(r.text).toContain('threshold');
      expect(r.value.length).toBeGreaterThan(0);
      expect(r.threshold.length).toBeGreaterThan(0);
    }
    expect(ev.reasons.every((r) => r.supports === 'BULLISH')).toBe(true);
  });

  it('confidence is the sum of explicit components with weights summing to 100', () => {
    const c = ev.confidence!;
    expect(c.components.map((x) => x.name)).toEqual([
      'DATA_COVERAGE',
      'SIGNAL_AGREEMENT',
      'LIQUIDITY',
      'DATA_QUALITY',
    ]);
    expect(c.components.reduce((a, x) => a + x.weight, 0)).toBe(100);
    const total = c.components.reduce((a, x) => a.plus(x.contribution), d('0'));
    expect(c.score.toString()).toBe(total.toString());
    for (const x of c.components) {
      expect(x.contribution.toString()).toBe(x.score.times(x.weight).div(100).toString());
      expect(x.detail.length).toBeGreaterThan(0);
    }
    expect(c.level).toBe('HIGH');
  });

  it('data quality lists sources, freshness and missing inputs', () => {
    expect(ev.dataQuality.sourcesUsed).toEqual(['PROVIDER']);
    expect(ev.dataQuality.latestBarSource).toBe('PROVIDER');
    expect(ev.dataQuality.priceAgeMinutes?.toString()).toBe('360');
    expect(ev.dataQuality.barsUsed).toBe(250);
  });

  it('is deterministic', () => {
    const a = JSON.stringify(evaluateStock(stockInput()));
    const b = JSON.stringify(evaluateStock(stockInput()));
    expect(a).toBe(b);
  });

  it('an estimated latest bar caps confidence LOW and blocks a BUY', () => {
    const bars = driftBars(250);
    bars[249] = { ...(bars[249] as ResearchBar), source: 'ESTIMATED' };
    const e = evaluateStock(stockInput({ bars }));
    expect(e.status).toBe('ACTIONABLE');
    expect(e.confidence!.level).toBe('LOW');
    expect(e.confidence!.score.lte(39)).toBe(true);
    expect(e.confidence!.caps.join(' ')).toContain('ESTIMATED');
    expect(e.action).not.toBe('BUY');
    expect(e.action).not.toBe('STRONG_BUY');
    expect(e.plan).toBeNull();
  });
});

describe('SELL / AVOID discipline', () => {
  it('a structural downtrend: AVOID when not held, SELL when held (structural rules cited)', () => {
    const flat = evaluateStock(stockInput({ bars: downBars() }));
    expect(flat.action).toBe('AVOID');
    expect(flat.plan).toBeNull();
    const held = evaluateStock(
      stockInput({
        bars: downBars(),
        portfolio: { equity: d('1000000'), cash: d('500000'), holdingQty: d('1000') },
      }),
    );
    expect(held.action).toBe('SELL');
    expect(held.scores!.structuralBearPassed).toBeGreaterThan(0);
    expect(held.reasons.some((r) => r.ruleId === 'T_TREND_DOWN' && r.supports === 'BEARISH')).toBe(true);
    expect(held.plan).toBeNull();
  });

  it('a temporary one-day decline inside an uptrend never produces SELL or AVOID', () => {
    const bars = driftBars(250);
    const prev = bars[248]!.close;
    const c = prev.minus('6');
    bars[249] = { ...bars[249]!, open: prev, high: prev.plus('0.5'), low: c.minus('0.5'), close: c };
    for (const horizon of ['SHORT_TERM', 'SWING'] as const) {
      const ev = evaluateStock(
        stockInput({
          bars,
          horizon,
          portfolio: { equity: d('1000000'), cash: d('500000'), holdingQty: d('1000') },
        }),
      );
      expect(ev.action).not.toBe('SELL');
      expect(ev.action).not.toBe('AVOID');
      expect(ev.scores!.structuralBearPassed).toBe(0);
    }
  });

  it('only trend / fundamental-deterioration rules are structural, and only on the bearish side', () => {
    for (const h of HORIZONS) {
      const ids = new Set<string>();
      for (const r of RULE_TABLE[h]) {
        expect(ids.has(r.id)).toBe(false);
        ids.add(r.id);
        expect(r.weight).toBeGreaterThan(0);
        if (r.structural) {
          expect(r.side).toBe('BEAR');
          expect(r.id).not.toMatch(/RSI|CANDLE|MACD|ADX|VOLUME|MOMENTUM|AD_/);
        }
      }
    }
  });
});

describe('fundamental horizons', () => {
  const longBars = driftBars(250);
  const base = (over: Partial<EvaluateStockInput> = {}): EvaluateStockInput =>
    stockInput({
      bars: longBars,
      horizon: 'LONG_TERM',
      fundamentals: fundamentalsBundle(),
      marketData: { priceAsOf: longBars[249]!.ts, freshnessLimitMinutes: 2000 },
      ...over,
    });

  it('LONG_TERM with fundamentals and peers: valuation separates facts from assumptions', () => {
    const ev = evaluateStock(base());
    expect(ev.status).toBe('ACTIONABLE');
    expect(ev.fundamentals!.ratios.pe.status).toBe('OK');
    const v = ev.valuation!;
    expect(v.status).toBe('OK');
    expect(v.fairValueLow!.toString()).toBe('216'); // EPS 12 x median peer P/E 18
    expect(v.reportedFacts.map((f) => f.name)).toEqual(['annualEps']);
    expect(v.assumptions[0]!.basis).toContain('median P/E of 3 supplied peers');
    expect(ev.reasons.some((r) => r.domain === 'VALUATION')).toBe(true);
    expect(ev.reasons.some((r) => r.domain === 'FUNDAMENTAL')).toBe(true);
    // USER_REPORTED fundamentals cost data-quality points and are listed
    expect(ev.dataQuality.fundamentalsSources).toEqual(['USER_REPORTED']);
    expect(ev.confidence!.components.find((c) => c.name === 'DATA_QUALITY')!.detail).toContain(
      'USER_REPORTED',
    );
  });

  it('with fewer than 3 peers the valuation is refused, not estimated', () => {
    const ev = evaluateStock(
      base({ fundamentals: { current: statement(), priorYear: prior(), peers: peers(['16', '18']) } }),
    );
    expect(ev.valuation).toBeNull();
    expect(ev.dataQuality.missingInputs.join(' ')).toContain('valuation inputs');
    expect(ev.rules.find((r) => r.id === 'V_MARGIN_OF_SAFETY')!.status).toBe('UNAVAILABLE');
  });

  it('a supplied historical P/E is used only when peers are unavailable', () => {
    const ev = evaluateStock(
      base({
        fundamentals: {
          current: statement(),
          priorYear: prior(),
          valuation: { historicalPe: { value: d('15'), basis: 'owner-supplied 5y median' } },
        },
      }),
    );
    expect(ev.valuation!.fairValueLow!.toString()).toBe('180');
    expect(ev.valuation!.assumptions[0]!.basis).toBe('owner-supplied 5y median');
  });

  it('a dividend cut is a structural bearish rule for DIVIDEND', () => {
    const hist = [
      {
        exDate: '2023-06-01T00:00:00.000Z',
        amountPerShare: d('6'),
        currency: 'PKR',
        source: 'USER_REPORTED' as const,
      },
      {
        exDate: '2024-06-01T00:00:00.000Z',
        amountPerShare: d('3'),
        currency: 'PKR',
        source: 'USER_REPORTED' as const,
      },
      {
        exDate: '2022-06-01T00:00:00.000Z',
        amountPerShare: d('6'),
        currency: 'PKR',
        source: 'USER_REPORTED' as const,
      },
    ];
    const ev = evaluateStock(base({ horizon: 'DIVIDEND', dividendHistory: hist }));
    expect(ev.status).toBe('ACTIONABLE');
    const cut = ev.rules.find((r) => r.id === 'F_DIVIDEND_CUT')!;
    expect(cut.status).toBe('PASS');
    expect(cut.structural).toBe(true);
    expect(ev.rules.find((r) => r.id === 'F_DIVIDEND_CONSISTENT')!.status).toBe('PASS');
  });

  it('evaluateAllHorizons returns every horizon with its own gates', () => {
    const all = evaluateAllHorizons({
      ...stockInput({
        bars: longBars,
        marketData: { priceAsOf: longBars[249]!.ts, freshnessLimitMinutes: 2000 },
      }),
      fundamentals: undefined,
    });
    expect(Object.keys(all).sort()).toEqual([...HORIZONS].sort());
    expect(all.SWING.status).toBe('ACTIONABLE');
    expect(all.VALUE.status).toBe('NOT_ACTIONABLE');
  });
});

describe('look-ahead safety (engine)', () => {
  const full = driftBars(260);
  const strip = (e: StockEvaluation): unknown => {
    const j = JSON.parse(JSON.stringify(e)) as {
      dataQuality: { ignoredFutureBars?: number; warnings: string[] };
      warnings: string[];
    };
    delete j.dataQuality.ignoredFutureBars;
    j.dataQuality.warnings = j.dataQuality.warnings.filter((w) => !w.includes('after the decision time'));
    j.warnings = j.warnings.filter((w) => !w.includes('after the decision time'));
    return j;
  };

  it('appending or mutating future bars never changes the evaluation at the decision bar', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 70, max: 249 }),
        fc.integer({ min: 1, max: 500 }),
        fc.boolean(),
        (k, junk, held) => {
          const prefix = full.slice(0, k + 1);
          const asOf = asOfAfter(prefix);
          const mk = (bars: ResearchBar[], horizon: 'SHORT_TERM' | 'SWING'): StockEvaluation =>
            evaluateStock(
              stockInput({
                bars,
                asOf,
                horizon,
                marketData: { priceAsOf: prefix[k]!.ts, freshnessLimitMinutes: 2000 },
                portfolio: { equity: d('1000000'), cash: d('1000000'), holdingQty: held ? d('100') : d('0') },
              }),
            );
          const future = full.slice(k + 1).map((b) => ({
            ...b,
            close: d(String(junk)),
            high: d(String(junk + 7)),
            low: d('0.5'),
            volume: d(String(junk * 1000)),
            source: 'SIMULATED' as const,
          }));
          for (const horizon of ['SHORT_TERM', 'SWING'] as const) {
            const clean = JSON.stringify(strip(mk(prefix, horizon)));
            const polluted = JSON.stringify(strip(mk([...prefix, ...future], horizon)));
            expect(polluted).toBe(clean);
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it('holding advice is equally immune to future bars', () => {
    const k = 200;
    const prefix = full.slice(0, k + 1);
    const asOf = asOfAfter(prefix);
    const run = (bars: ResearchBar[]): string =>
      JSON.stringify(
        evaluateHolding({
          ...stockInput({
            bars,
            asOf,
            marketData: { priceAsOf: prefix[k]!.ts, freshnessLimitMinutes: 2000 },
          }),
          position: { qty: d('100'), avgCost: d('150'), targets: [d('999')] },
        }).pnl,
      );
    const future = full.slice(k + 1).map((b) => ({ ...b, close: d('1'), high: d('5'), low: d('0.5') }));
    expect(run([...prefix, ...future])).toBe(run(prefix));
  });
});

describe('holdings advice', () => {
  const bars = driftBars(250);
  const close = bars[249]!.close;
  const hin = (
    position: Parameters<typeof evaluateHolding>[0]['position'],
    over: Partial<EvaluateStockInput> = {},
  ) => evaluateHolding({ ...stockInput({ bars, ...over }), position });

  it('continue holding: no trigger; P&L uses average cost, sell fees, dividends and realized P&L', () => {
    const r = hin({ qty: d('100'), avgCost: d('180'), realizedPnl: d('500'), dividendsReceived: d('300') });
    expect(r.status).toBe('ACTIONABLE');
    expect(r.advice).toBe('CONTINUE_HOLDING');
    const p = r.pnl!;
    const fees = computeTradeFees(ktradeDefaultSchedule('2024-01-01'), {
      side: 'SELL',
      quantity: '100',
      price: close,
    });
    expect(p.costBasis.toString()).toBe('18000');
    expect(p.marketValue.toString()).toBe(close.times(100).toString());
    expect(p.estimatedSellFees.toString()).toBe(fees.total.toString());
    expect(p.unrealizedNet.toString()).toBe(close.times(100).minus(18000).minus(fees.total).toString());
    expect(p.totalReturn.toString()).toBe(p.unrealizedNet.plus(500).plus(300).toString());
    expect(r.stopLoss?.origin).toBe('SUGGESTED_FROM_ATR');
    expect(r.warnings.join(' ')).toContain('no stop-loss supplied');
    expect(r.reasons.join(' ')).toContain('an unrealized loss alone is not a reason to sell');
    expect(r.suggestedSellQty).toBeNull();
  });

  it('stop hit => EXIT; a stop below the price does not trigger', () => {
    const hit = hin({ qty: d('100'), avgCost: d('150'), stopLoss: close.plus('1') });
    expect(hit.advice).toBe('EXIT');
    expect(hit.suggestedSellQty!.toString()).toBe('100');
    expect(hit.reasons.join(' ')).toContain('stop-loss hit');
    expect(hin({ qty: d('100'), avgCost: d('150'), stopLoss: close.minus('20') }).advice).toBe(
      'CONTINUE_HOLDING',
    );
  });

  it('targets: some reached => PARTIAL_SELL, all reached => TARGET_REACHED', () => {
    const some = hin({
      qty: d('90'),
      avgCost: d('150'),
      targets: [close.minus('5'), close.plus('10'), close.plus('20')],
    });
    expect(some.advice).toBe('PARTIAL_SELL');
    expect(some.targetsReached).toBe(1);
    expect(some.suggestedSellQty!.toString()).toBe('30'); // 1/3 of 90
    const all = hin({ qty: d('90'), avgCost: d('150'), targets: [close.minus('5'), close.minus('1')] });
    expect(all.advice).toBe('TARGET_REACHED');
    expect(all.suggestedSellQty!.toString()).toBe('90');
  });

  it('structural deterioration => EXIT; a temporary decline alone => not EXIT', () => {
    const down = hin({ qty: d('100'), avgCost: d('250') }, { bars: downBars() });
    expect(down.advice).toBe('EXIT');
    expect(down.pnl!.unrealizedNet.isNeg()).toBe(true);
    const b = driftBars(250);
    const prev = b[248]!.close;
    b[249] = {
      ...b[249]!,
      open: prev,
      high: prev.plus('0.5'),
      low: prev.minus('6.5'),
      close: prev.minus('6'),
    };
    const dip = hin({ qty: d('100'), avgCost: d('250') }, { bars: b });
    expect(dip.advice).not.toBe('EXIT');
  });

  it('same hard gates: simulated and stale data give no advice', () => {
    const sim = hin(
      { qty: d('100'), avgCost: d('150'), stopLoss: close.plus('1') },
      { bars: driftBars(250, { source: 'SIMULATED' }) },
    );
    expect(sim.status).toBe('NOT_ACTIONABLE');
    expect(sim.advice).toBeNull();
    expect(sim.notActionableReasons).toEqual([SIMULATED_REASON]);
    expect(sim.pnl).toBeNull();
    const stale = hin(
      { qty: d('100'), avgCost: d('150') },
      {
        asOf: new Date(Date.parse(bars[249]!.ts) + 5 * 86_400_000).toISOString(),
        marketData: { priceAsOf: bars[249]!.ts, freshnessLimitMinutes: 60 },
      },
    );
    expect(stale.advice).toBeNull();
    const fundHorizon = hin({ qty: d('100'), avgCost: d('150') }, { horizon: 'VALUE' });
    expect(fundHorizon.advice).toBeNull();
  });
});

describe('scanner', () => {
  const good = (
    symbol: string,
    over: Partial<EvaluateStockInput> = {},
  ): Omit<EvaluateStockInput, 'horizon'> => {
    const { horizon: _h, ...rest } = stockInput({ symbol, ...over });
    return rest;
  };
  const sim = good('SIM', { bars: driftBars(250, { source: 'SIMULATED' }) });
  const illiquid = good('ILLIQ', { bars: driftBars(250, { volume: 1000 }) });

  it('ranks only ACTIONABLE BUY-class results and explains exclusions', () => {
    const res = rankOpportunities([sim, illiquid, good('GOOD')], 'SWING');
    expect(res.evaluated).toBe(3);
    expect(res.ranked.map((r) => r.symbol)).toEqual(['GOOD']);
    expect(res.ranked[0]!.rank).toBe(1);
    expect(res.excluded.find((e) => e.symbol === 'SIM')!.reason).toContain('NOT_ACTIONABLE: simulated data');
    expect(res.excluded.find((e) => e.symbol === 'ILLIQ')!.reason).toContain('not in filter');
  });

  it('can return an empty list', () => {
    const res = rankOpportunities([sim, illiquid], 'SWING');
    expect(res.ranked).toEqual([]);
    expect(res.excluded).toHaveLength(2);
    expect(rankOpportunities([], 'SWING').ranked).toEqual([]);
  });

  it('deterministic tie-breaks (symbol) independent of input order', () => {
    const u = [good('B'), good('A'), good('C')];
    const fwd = rankOpportunities(u, 'SWING').ranked.map((r) => r.symbol);
    const rev = rankOpportunities([...u].reverse(), 'SWING').ranked.map((r) => r.symbol);
    expect(fwd).toEqual(['A', 'B', 'C']);
    expect(rev).toEqual(fwd);
  });

  it('orders by confidence before symbol, and honours filters and limits', () => {
    const lowerQuality = good('A', {
      marketData: { priceAsOf: isoDay(249), freshnessLimitMinutes: 2000, delayMinutes: 30 },
    });
    const res = rankOpportunities([lowerQuality, good('Z')], 'SWING');
    expect(res.ranked.map((r) => r.symbol)).toEqual(['Z', 'A']);
    expect(rankOpportunities([good('Z'), good('Y')], 'SWING', { maxResults: 1 }).ranked).toHaveLength(1);
    expect(rankOpportunities([good('Z')], 'SWING', { minConfidence: D('101') }).ranked).toEqual([]);
    expect(rankOpportunities([good('Z', { sector: 'X' })], 'SWING', { sectors: ['Y'] }).ranked).toEqual([]);
    expect(rankOpportunities([good('Z')], 'SWING', { excludeSymbols: ['Z'] }).excluded[0]!.reason).toBe(
      'excluded by filter',
    );
    expect(rankOpportunities([good('Z')], 'SWING', { minRiskReward: D('1000') }).ranked).toEqual([]);
  });

  it('every ranked BUY carries a plan; ranks are 1..n', () => {
    const res = rankOpportunities([good('A'), good('B')], 'SHORT_TERM');
    res.ranked.forEach((r, i) => {
      expect(r.rank).toBe(i + 1);
      expect(r.evaluation.plan).not.toBeNull();
    });
  });
});

describe('bar helper sanity', () => {
  it('synthetic bars are labelled by source and ordered', () => {
    const b = driftBars(5);
    expect(b.every((x) => x.source === 'PROVIDER')).toBe(true);
    expect(bar(0, '1', '2', '1', '2', '1').ts).toBe(isoDay(0));
  });
});
