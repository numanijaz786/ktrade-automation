import { describe, expect, it } from 'vitest';
import { d } from '@ktrade/finance-core';
import { PsxCalendar } from './calendar.js';
import { parseEodCsv } from './csv-eod.parser.js';
import { rankMovers } from './movers.js';
import { CapitalStakeProvider } from './providers/capital-stake.provider.js';
import { SimulatedMarketDataProvider } from './providers/simulated.provider.js';
import { isStale } from './staleness.js';

const clockAt = (iso: string) => ({ now: () => new Date(iso) });
const cal = new PsxCalendar(['2026-11-09']); // a Monday holiday
const sim = (iso: string) =>
  new SimulatedMarketDataProvider(clockAt(iso), () => cal, new Map([['OGDC', '220.00']]));
const isTick = (v: string) => d(v).times(100).isInteger() && d(v).gt(0);

describe('PSX calendar', () => {
  it('knows weekends, holidays and session hours (09:30–15:30 PKT = 04:30–10:30 UTC)', () => {
    expect(cal.isTradingDay('2026-11-14')).toBe(false); // Saturday
    expect(cal.isTradingDay('2026-11-09')).toBe(false); // configured holiday
    expect(cal.isTradingDay('2026-11-10')).toBe(true);
    expect(cal.isOpen(new Date('2026-11-10T04:29:00Z'))).toBe(false);
    expect(cal.isOpen(new Date('2026-11-10T04:30:00Z'))).toBe(true);
    expect(cal.isOpen(new Date('2026-11-10T10:30:00Z'))).toBe(false);
    expect(cal.lastCompletedSession(new Date('2026-11-10T06:00:00Z'))).toBe('2026-11-06'); // skips weekend + holiday
    expect(cal.previousTradingDay('2026-11-10')).toBe('2026-11-06');
  });
});

describe('SimulatedMarketDataProvider', () => {
  const from = new Date('2026-10-01T00:00:00Z');
  const to = new Date('2026-11-13T23:00:00Z');

  it('is reproducible: two instances (e.g. before/after a restart) produce identical bars', async () => {
    const a = await sim('2026-11-16T12:00:00Z').getBars('OGDC', 'D1', from, to);
    const b = await sim('2026-11-16T12:00:00Z').getBars('OGDC', 'D1', from, to);
    expect(a.length).toBeGreaterThan(20);
    expect(a).toEqual(b);
  });

  it('emits only trading days, on the 0.01 tick, positive, with valid OHLC relationships', async () => {
    const bars = await sim('2026-11-16T12:00:00Z').getBars('OGDC', 'D1', from, to);
    for (const b of bars) {
      const day = new Date(b.ts).toISOString().slice(0, 10);
      expect(cal.isTradingDay(day), day).toBe(true);
      for (const v of [b.open, b.high, b.low, b.close]) expect(isTick(v), `${b.ts} ${v}`).toBe(true);
      expect(d(b.high).gte(d(b.open)) && d(b.high).gte(d(b.close))).toBe(true);
      expect(d(b.low).lte(d(b.open)) && d(b.low).lte(d(b.close))).toBe(true);
      expect(d(b.volume).isInteger() && d(b.volume).gte(0)).toBe(true);
    }
    expect(bars.some((b) => b.ts.startsWith('2026-11-09'))).toBe(false); // holiday
  });

  it('labels everything SIMULATED and never serves the future', async () => {
    const p = sim('2026-11-10T06:00:00Z'); // mid-session
    const [q] = await p.getQuotes(['OGDC']);
    expect(q).toMatchObject({ symbol: 'OGDC', source: 'SIMULATED', providerKey: 'simulated' });
    expect(Date.parse(q!.asOf)).toBeLessThanOrEqual(Date.parse('2026-11-10T06:00:00Z'));
    const bars = await p.getBars('OGDC', 'D1', from, new Date('2026-12-31T00:00:00Z'));
    expect(bars.every((b) => Date.parse(b.ts) <= Date.parse('2026-11-10T06:00:00Z'))).toBe(true);
    expect(isTick(q!.last)).toBe(true);
    // prevClose/change are internally consistent: change = last − prevClose
    expect(d(q!.last).minus(d(q!.prevClose!)).toFixed(2)).toBe(d(q!.change!).toFixed(2));
  });

  it('rejects invalid symbols instead of inventing data', async () => {
    await expect(sim('2026-11-16T12:00:00Z').getQuotes(['bad sym'])).rejects.toThrow();
  });
});

describe('EOD CSV parser', () => {
  const header = 'symbol,date,open,high,low,close,volume';
  it('accepts valid rows', () => {
    const { rows, issues } = parseEodCsv(`${header}\nOGDC,2026-11-10,220.00,225.50,219.00,224.25,1500000\n`, {
      today: '2026-11-13',
    });
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        symbol: 'OGDC',
        date: '2026-11-10',
        open: '220.00',
        high: '225.50',
        low: '219.00',
        close: '224.25',
        volume: '1500000',
      },
    ]);
  });

  it('reports invalid prices, inconsistent OHLC, future dates and missing values with line numbers', () => {
    const csv = [
      header,
      'OGDC,2026-11-10,-1,225,219,224,100', // negative open
      'OGDC,2026-11-11,220,210,219,215,100', // high < low
      'OGDC,2026-12-31,220,225,219,224,100', // future
      'OGDC,2026-11-12,220,225,219,,100', // missing close
    ].join('\n');
    const { issues } = parseEodCsv(csv, { today: '2026-11-13' });
    expect(new Set(issues.map((i) => i.line))).toEqual(new Set([2, 3, 4, 5]));
  });
});

describe('staleness', () => {
  it('during the session a quote older than delay + 5 min is stale; after close the last close is fresh', () => {
    const q = (asOf: string, delayMinutes = 0) => ({ asOf, delayMinutes });
    expect(isStale(q('2026-11-10T05:58:00Z'), new Date('2026-11-10T06:00:00Z'), cal)).toBe(false);
    expect(isStale(q('2026-11-10T05:50:00Z'), new Date('2026-11-10T06:00:00Z'), cal)).toBe(true);
    expect(isStale(q('2026-11-10T05:50:00Z', 15), new Date('2026-11-10T06:00:00Z'), cal)).toBe(false); // delayed feed
    expect(isStale(q('2026-11-10T10:30:00Z'), new Date('2026-11-10T18:00:00Z'), cal)).toBe(false); // evening, last close
    expect(isStale(q('2026-11-06T10:30:00Z'), new Date('2026-11-10T18:00:00Z'), cal)).toBe(true); // days old
    expect(isStale(q('not-a-date'), new Date(), cal)).toBe(true);
  });
});

describe('movers', () => {
  const quotes = [
    { symbol: 'B', changePct: '2.00', volume: '100' },
    { symbol: 'A', changePct: '2.00', volume: '300' },
    { symbol: 'C', changePct: '-1.50', volume: '200' },
    { symbol: 'D', changePct: '0.00', volume: '0' },
    { symbol: 'E', changePct: undefined, volume: undefined },
  ];
  it('ranks gainers/losers by change % (ties alphabetical) and active by volume, excluding non-movers', () => {
    expect(rankMovers(quotes, 'gainers', 10).map((q) => q.symbol)).toEqual(['A', 'B']);
    expect(rankMovers(quotes, 'losers', 10).map((q) => q.symbol)).toEqual(['C']);
    expect(rankMovers(quotes, 'active', 2).map((q) => q.symbol)).toEqual(['A', 'C']);
  });
});

describe('CapitalStakeProvider (licensed vendor, not configured)', () => {
  it('is disabled and refuses every data call rather than guessing endpoints', async () => {
    const p = new CapitalStakeProvider(clockAt('2026-11-10T06:00:00Z'));
    expect(p.enabled).toBe(false);
    await expect(p.getQuotes(['OGDC'])).rejects.toThrow();
    await expect(p.getBars('OGDC', 'D1', new Date(), new Date())).rejects.toThrow();
    expect((await p.healthCheck()).ok).toBe(false);
  });
});
