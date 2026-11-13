import { describe, expect, it } from 'vitest';
import { d } from '@ktrade/finance-core';
import { dailyFields, performanceFromSnapshots, rangeBaseDate, type SnapshotPoint } from './snapshot-math.js';

const v = (date: string, totalValue: string, netContributions: string) => ({
  date,
  totalValue: d(totalValue),
  netContributions: d(netContributions),
});

describe('dailyFields (docs/06 §5, flows at end of day)', () => {
  it('a deposit on the same day is a flow, not P&L', () => {
    // V_{t−1}=10,000; deposit 5,000; close at 15,500 → P&L 500, r = (15,500 − 5,000)/10,000 − 1 = 5%
    const f = dailyFields(v('2026-11-12', '10000', '10000'), v('2026-11-13', '15500', '15000'));
    expect(f.netFlow.toString()).toBe('5000');
    expect(f.dailyPnl.toString()).toBe('500');
    expect(f.dailyReturn?.toString()).toBe('0.05');
  });

  it('withdrawal: value falls but P&L is only the market move', () => {
    const f = dailyFields(v('2026-11-12', '10000', '10000'), v('2026-11-13', '7100', '7000'));
    expect(f.dailyPnl.toString()).toBe('100');
    expect(f.dailyReturn?.toString()).toBe('0.01');
  });

  it('zero-value previous day: return undefined (null), P&L still defined', () => {
    const first = dailyFields(null, v('2026-11-13', '100120', '100000'));
    expect(first.dailyPnl.toString()).toBe('120');
    expect(first.dailyReturn).toBeNull();
    const empty = dailyFields(v('2026-11-12', '0', '0'), v('2026-11-13', '0', '0'));
    expect(empty.dailyPnl.isZero()).toBe(true);
    expect(empty.dailyReturn).toBeNull();
  });
});

describe('performanceFromSnapshots', () => {
  const p = (
    date: string,
    totalValue: string,
    netContributions: string,
    dailyPnl: string,
  ): SnapshotPoint => ({
    date,
    totalValue: d(totalValue),
    netContributions: d(netContributions),
    dailyPnl: d(dailyPnl),
  });

  it('links TWR across a deposit and skips leading zero-capital days', () => {
    const pts = [
      p('2026-10-29', '0', '0', '0'),
      p('2026-10-30', '10000', '10000', '0'), // first capital: TWR base
      p('2026-11-02', '11000', '10000', '1000'), // +10%
      p('2026-11-03', '16500', '15000', '500'), // +4.5454…% then deposit 5,000
      p('2026-11-04', '14850', '13350', '0'), // 0% then withdraw 1,650
    ];
    const r = performanceFromSnapshots(null, pts);
    expect(r.twr?.toFixed(10)).toBe('0.1500000000'); // 1.1 × 11500/11000 − 1
    expect(r.twrBaseDate).toBe('2026-10-30');
    expect(r.series[0]!.twrIndex).toBeNull();
    expect(r.series[1]!.twrIndex?.toString()).toBe('1');
    expect(r.maxDrawdown?.value.isZero()).toBe(true);
    expect(r.monthly.map((m) => [m.month, m.pnl.toString(), m.days])).toEqual([
      ['2026-10', '0', 2],
      ['2026-11', '1500', 3],
    ]);
  });

  it('uses the base point for the first in-range return; drawdown on the TWR index', () => {
    const base = p('2026-10-30', '100', '100', '0');
    const r = performanceFromSnapshots(base, [
      p('2026-11-02', '120', '100', '20'),
      p('2026-11-03', '90', '100', '-30'),
      p('2026-11-04', '99', '100', '9'),
    ]);
    expect(r.series).toHaveLength(3);
    expect(r.twr?.toFixed(4)).toBe('-0.0100');
    expect(r.maxDrawdown?.value.toString()).toBe('0.25');
    expect(r.maxDrawdown?.peakDate).toBe('2026-11-02');
    expect(r.monthly.map((m) => [m.month, m.pnl.toString(), m.days])).toEqual([['2026-11', '-1', 3]]);
  });

  it('TWR null with a single point or no capital', () => {
    expect(performanceFromSnapshots(null, [p('2026-11-02', '100', '100', '0')]).twr).toBeNull();
    expect(performanceFromSnapshots(null, [p('2026-11-02', '0', '0', '0')]).twr).toBeNull();
  });
});

describe('rangeBaseDate', () => {
  it('month arithmetic clamps to month end; YTD bases on the previous year end', () => {
    expect(rangeBaseDate('1M', '2026-03-31')).toBe('2026-02-28');
    expect(rangeBaseDate('3M', '2026-11-16')).toBe('2026-08-16');
    expect(rangeBaseDate('1Y', '2026-11-16')).toBe('2025-11-16');
    expect(rangeBaseDate('YTD', '2026-11-16')).toBe('2025-12-31');
    expect(rangeBaseDate('ALL', '2026-11-16')).toBeNull();
  });
});
