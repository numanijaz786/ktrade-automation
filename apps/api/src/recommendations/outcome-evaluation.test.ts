import { d } from '@ktrade/finance-core';
import { describe, expect, it } from 'vitest';
import { type EvalBar, type EvalInput, evaluateOutcome } from './outcome-evaluation.js';
import { aggregatePerformance, performanceReport } from './performance.js';

const bar = (date: string, o: string, h: string, l: string, c: string): EvalBar => ({
  date,
  open: d(o),
  high: d(h),
  low: d(l),
  close: d(c),
});

const base: EvalInput = {
  action: 'BUY',
  entry: d('100'),
  stop: d('95'),
  targets: [d('105'), d('110'), d('115')],
  asOfBar: '2026-11-02',
  maxDays: 30,
  bars: [],
  today: '2026-11-16',
};

describe('evaluateOutcome (hand-computed)', () => {
  it('returns null when there are no bars after the recommendation bar', () => {
    expect(evaluateOutcome({ ...base, bars: [bar('2026-11-02', '100', '101', '99', '100')] })).toBeNull();
  });

  it('walks to the final target: hits recorded per bar, TARGET_HIT at target 3', () => {
    const r = evaluateOutcome({
      ...base,
      bars: [
        bar('2026-11-03', '100', '102', '99', '101'),
        bar('2026-11-04', '101', '106', '100', '105'),
        bar('2026-11-05', '105', '111', '104', '110'),
        bar('2026-11-06', '110', '116', '109', '115'),
        bar('2026-11-09', '115', '120', '60', '70'), // after close: must be ignored
      ],
    })!;
    expect(r.status).toBe('TARGET_HIT');
    expect(r.targetHitAt).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
    expect(r.stopHitAt).toBeNull();
    expect(r.closedAt).toBe('2026-11-06');
    expect(r.exitPrice!.toFixed()).toBe('115');
    expect(r.returnPct.toFixed(4)).toBe('15.0000');
    expect(r.maxFavourable.toFixed(4)).toBe('16.0000'); // high 116
    expect(r.maxAdverse.toFixed(4)).toBe('-1.0000'); // low 99
    expect(r.holdingDays).toBe(4);
    expect(r.lastBarDate).toBe('2026-11-06');
  });

  it('stop hit: exits at the stop, return -5%', () => {
    const r = evaluateOutcome({ ...base, bars: [bar('2026-11-03', '99', '101', '94', '95')] })!;
    expect(r.status).toBe('STOPPED');
    expect(r.exitPrice!.toFixed()).toBe('95');
    expect(r.returnPct.toFixed(4)).toBe('-5.0000');
    expect(r.maxAdverse.toFixed(4)).toBe('-6.0000');
    expect(r.maxFavourable.toFixed(4)).toBe('0.0000'); // stop bar's favourable excursion is not credited
  });

  it('gap through the stop exits at the open, not the stop', () => {
    const r = evaluateOutcome({ ...base, bars: [bar('2026-11-03', '92', '93', '90', '91')] })!;
    expect(r.status).toBe('STOPPED');
    expect(r.exitPrice!.toFixed()).toBe('92');
    expect(r.returnPct.toFixed(4)).toBe('-8.0000');
  });

  it('stop and target in the SAME bar: the stop wins and the target is not credited', () => {
    const r = evaluateOutcome({ ...base, bars: [bar('2026-11-03', '100', '106', '94', '100')] })!;
    expect(r.status).toBe('STOPPED');
    expect(r.targetHitAt).toEqual([null, null, null]);
    expect(r.stopHitAt).toBe('2026-11-03');
    expect(r.returnPct.toFixed(4)).toBe('-5.0000');
  });

  it('no look-ahead: the recommendation bar itself and bars past expiry are ignored', () => {
    const r = evaluateOutcome({
      ...base,
      maxDays: 10, // expiry 2026-11-12
      bars: [
        bar('2026-11-02', '100', '101', '90', '95'), // same bar as asOfBar: would have stopped out
        bar('2026-11-03', '100', '101', '99', '101'),
        bar('2026-11-13', '101', '130', '60', '70'), // beyond the window
      ],
    })!;
    expect(r.status).toBe('EXPIRED'); // today 2026-11-16 is past expiry
    expect(r.stopHitAt).toBeNull();
    expect(r.closedAt).toBe('2026-11-03');
    expect(r.exitPrice!.toFixed()).toBe('101');
    expect(r.returnPct.toFixed(4)).toBe('1.0000');
  });

  it('still inside the window and nothing hit: OPEN, marked to the last close', () => {
    const r = evaluateOutcome({ ...base, bars: [bar('2026-11-03', '100', '102', '99', '101')] })!;
    expect(r.status).toBe('OPEN');
    expect(r.closedAt).toBeNull();
    expect(r.exitPrice).toBeNull();
    expect(r.returnPct.toFixed(4)).toBe('1.0000');
    expect(r.holdingDays).toBe(1);
  });

  it('target 1 hit but not the final target: stays OPEN with the hit recorded', () => {
    const r = evaluateOutcome({ ...base, bars: [bar('2026-11-03', '100', '106', '99', '105')] })!;
    expect(r.status).toBe('OPEN');
    expect(r.targetHitAt).toEqual(['2026-11-03', null, null]);
  });

  it('SELL mirrors BUY: target below, stop above', () => {
    const r = evaluateOutcome({
      ...base,
      action: 'SELL',
      stop: d('105'),
      targets: [d('95'), null, null],
      bars: [bar('2026-11-03', '100', '104', '94', '96')],
    })!;
    expect(r.status).toBe('TARGET_HIT');
    expect(r.returnPct.toFixed(4)).toBe('5.0000');
    expect(r.maxFavourable.toFixed(4)).toBe('6.0000');
    expect(r.maxAdverse.toFixed(4)).toBe('-4.0000');
  });
});

describe('aggregatePerformance (hand-computed)', () => {
  const o = (
    status: 'OPEN' | 'TARGET_HIT' | 'STOPPED' | 'EXPIRED',
    ret: string,
    days: number,
    t1: boolean,
    bench?: string,
  ) => ({
    status,
    returnPct: d(ret),
    holdingDays: days,
    target1Hit: t1,
    benchmarkReturnPct: bench ? d(bench) : null,
  });

  it('computes rates over the right denominators', () => {
    const s = aggregatePerformance([
      { horizon: 'SHORT_TERM', outcome: o('TARGET_HIT', '10', 4, true) },
      { horizon: 'SHORT_TERM', outcome: o('STOPPED', '-5', 2, false) },
      { horizon: 'MEDIUM_TERM', outcome: o('EXPIRED', '1', 30, false) },
      { horizon: 'MEDIUM_TERM', outcome: o('OPEN', '2', 5, true) },
      { horizon: 'LONG_TERM', outcome: null },
    ]);
    expect(s).toMatchObject({ recommendations: 5, evaluated: 4, open: 1, closed: 3 });
    expect(s.winRatePct).toBe('66.67'); // 2 of 3 closed positive
    expect(s.avgReturnPct).toBe('2.0000'); // (10 - 5 + 1) / 3
    expect(s.targetHitRatePct).toBe('50.00'); // 2 of 4 evaluated reached T1
    expect(s.stopFrequencyPct).toBe('33.33');
    expect(s.avgHoldingDays).toBe('12.00'); // (4 + 2 + 30) / 3
    expect(s.avgBenchmarkReturnPct).toBeNull();
  });

  it('per-horizon breakdown and a null benchmark with a note when no index series exists', () => {
    const rep = performanceReport(
      [
        { horizon: 'SHORT_TERM', outcome: o('TARGET_HIT', '10', 4, true) },
        { horizon: 'SHORT_TERM', outcome: o('STOPPED', '-5', 2, false) },
      ],
      ['SHORT_TERM', 'MEDIUM_TERM', 'LONG_TERM'],
    );
    expect(rep.perHorizon.SHORT_TERM!.winRatePct).toBe('50.00');
    expect(rep.perHorizon.MEDIUM_TERM!.winRatePct).toBeNull();
    expect(rep.benchmark).toBeNull();
    expect(rep.benchmarkNote).toContain('KSE100_INDEX');
  });

  it('reports the benchmark when closed rows carry one', () => {
    const rep = performanceReport(
      [{ horizon: 'SHORT_TERM', outcome: o('TARGET_HIT', '10', 4, true, '3') }],
      ['SHORT_TERM'],
    );
    expect(rep.benchmark).toEqual({ series: 'KSE100_INDEX', avgReturnPct: '3.0000', samples: 1 });
  });
});
