import { describe, expect, it } from 'vitest';
import { GenericTransactionsCsvParser, normaliseDate } from './generic-csv.parser.js';

const p = new GenericTransactionsCsvParser();

describe('GenericTransactionsCsvParser', () => {
  it('detects by required headers (aliases, any case) and .csv extension', () => {
    expect(p.detect('t.csv', 'Trade Date,Scrip,Buy/Sell,Qty,Rate\n')).toBeGreaterThan(0.5);
    expect(p.detect('t.csv', 'date,symbol,side,quantity\n')).toBe(0); // price missing
    expect(p.detect('t.xlsx', 'date,symbol,side,quantity,price\n')).toBe(0);
  });

  it('parses valid rows with thousands separators, quoted fields, BOM and explicit charges', () => {
    const csv =
      '﻿date,symbol,side,qty,price,commission,sst,cdc,contract_no\r\n' +
      '2026-11-02,ogdc,BUY,"1,000",250.50,751.50,112.73,5.00,CN-1\r\n' +
      '03/11/2026,HUBC,s,200,"150.25",,,,\r\n';
    const rows = p.parse(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.errors).toEqual([]);
    expect(rows[0]!.trade).toEqual({
      tradeDate: '2026-11-02',
      symbol: 'OGDC',
      side: 'BUY',
      quantity: '1000',
      price: '250.50',
      fees: [
        { component: 'COMMISSION', amount: '751.50' },
        { component: 'SST_ON_COMMISSION', amount: '112.73' },
        { component: 'CDC_CHARGES', amount: '5.00' },
      ],
      externalRef: 'CN-1',
    });
    expect(rows[1]!.trade).toMatchObject({ tradeDate: '2026-11-03', symbol: 'HUBC', side: 'SELL', quantity: '200', price: '150.25', fees: [] });
    expect(rows[1]!.rowIndex).toBe(3);
  });

  it('reports every problem in a bad row, with its line number', () => {
    const rows = p.parse('date,symbol,side,quantity,price,commission\n2026-02-30,TOO$LONG,HOLD,1.5,-3,abc\n');
    expect(rows[0]!.trade).toBeUndefined();
    expect(rows[0]!.rowIndex).toBe(2);
    expect(rows[0]!.errors).toHaveLength(6);
  });

  it('rejects ragged rows instead of guessing column alignment', () => {
    expect(() => p.parse('date,symbol,side,quantity,price\n2026-01-01,OGDC,BUY,10\n')).toThrow();
  });

  it('normaliseDate validates real calendar dates', () => {
    expect(normaliseDate('2026-11-13')).toBe('2026-11-13');
    expect(normaliseDate('5/1/2026')).toBe('2026-01-05');
    expect(normaliseDate('2026-02-29')).toBeNull();
    expect(normaliseDate('31/04/2026')).toBeNull();
    expect(normaliseDate('2026/11/13')).toBeNull();
  });
});
