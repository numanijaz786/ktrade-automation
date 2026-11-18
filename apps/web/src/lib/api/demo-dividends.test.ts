import { describe, expect, it } from 'vitest';
import { Dec } from '../decimal';
import { DemoApiClient, LIVE_PORTFOLIO_ID } from './demo-client';
import { addBusinessDays, eligibleShares, lookupDemoWht } from './demo-dividends';
import type { LedgerEntry } from '../demo/ledger';
import type { DividendMarkPaidInput, TaxRate } from './types';

const NOW = Date.parse('2026-11-13T07:15:00Z');
const client = () => new DemoApiClient({ latencyMs: 0, tickMs: 0, now: () => NOW });

describe('demo dividends — rules mirror the API (ADR-031)', () => {
  it('estimates are NOT_CONFIGURED without verified rates: WHT and net are null, gross is ESTIMATED', async () => {
    const c = client();
    const { data } = await c.dividends.entitlements(LIVE_PORTFOLIO_ID);
    const estimates = data.filter((e) => e.status === 'ENTITLED');
    expect(estimates.length).toBeGreaterThan(0);
    for (const e of estimates) {
      expect(e.taxStatus).toBe('NOT_CONFIGURED');
      expect(e.whtAmount).toBeNull();
      expect(e.netAmount).toBeNull();
      expect(e.whtRate).toBeNull();
      expect(e.source).toBe('ESTIMATED');
      expect(e.taxNote).toMatch(/verified/i);
    }
    // Paid rows report what was recorded, never as an estimate.
    for (const e of data.filter((x) => x.status === 'PAID' || x.status === 'RECONCILED')) {
      expect(e.taxStatus).toBe('AS_PAID');
      expect(e.source).not.toBe('ESTIMATED');
    }
  });

  it('marks the book closure in the future as provisional and returns the settlement assumption', async () => {
    const c = client();
    const r = await c.dividends.compute(LIVE_PORTFOLIO_ID);
    expect(r.settlement).toMatchObject({ days: 1, basis: 'DEFAULT' });
    expect(r.settlement.note).toMatch(/must confirm/);
    const ffc = r.data.find((e) => e.symbol === 'FFC');
    expect(ffc?.provisional).toBe(true);
    // Idempotent.
    const again = await c.dividends.compute(LIVE_PORTFOLIO_ID);
    expect(again.counts.created).toBe(0);
    expect(again.counts.updated).toBe(0);
  });

  it('mark-paid requires WHT from the payment advice and surfaces unexplained differences', async () => {
    const c = client();
    const { data } = await c.dividends.entitlements(LIVE_PORTFOLIO_ID);
    const e = data.find((x) => x.status === 'ENTITLED' && !x.provisional)!;
    await expect(
      c.dividends.markPaid(e.id, { paidAt: '2026-11-12', netAmount: '100' } as DividendMarkPaidInput),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'whtAmount' }] });
    await expect(
      c.dividends.markPaid(e.id, { paidAt: '2026-11-12', netAmount: '100', whtAmount: '' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      c.dividends.markPaid(e.id, { paidAt: '2026-12-31', netAmount: '100', whtAmount: '0' }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE' });

    const cashBefore = (await c.portfolios.cashMovements(LIVE_PORTFOLIO_ID)).length;
    const r = await c.dividends.markPaid(e.id, {
      paidAt: '2026-11-12',
      netAmount: '100.00',
      whtAmount: '10',
    });
    expect(r.whtBasis).toBe('REPORTED');
    expect(r.estimate.taxStatus).toBe('NOT_CONFIGURED');
    expect(r.differences.netAmount).toBeNull();
    expect(r.differences.whtAmount).toBeNull();
    // gross − 0 − 10 − 100
    expect(r.unexplainedDifference).toBe(Dec.of(e.grossAmount).sub('110').toFixed(4));
    expect(r.warnings[0]).toMatch(/check the share count/);
    expect(r.entitlement).toMatchObject({ status: 'PAID', source: 'USER_REPORTED', whtAmount: '10.0000' });
    expect((await c.portfolios.cashMovements(LIVE_PORTFOLIO_ID)).length).toBe(cashBefore + 1);

    // Paid twice → refused; declaration now locked.
    await expect(
      c.dividends.markPaid(e.id, { paidAt: '2026-11-12', netAmount: '1', whtAmount: '0' }),
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_NOT_PAYABLE' });
    const decl = (await c.dividends.declarations()).find((d) => d.id === e.dividendId)!;
    expect(decl.locked).toBe(true);
    await expect(c.dividends.deleteDeclaration(decl.id)).rejects.toMatchObject({ code: 'DIVIDEND_LOCKED' });
    await expect(c.dividends.updateDeclaration(decl.id, { paymentDate: '2026-12-01' })).rejects.toMatchObject(
      {
        code: 'DIVIDEND_LOCKED',
      },
    );

    const rec = await c.dividends.reconcile(e.id);
    expect(rec).toMatchObject({ status: 'RECONCILED', source: 'BROKER_CONFIRMED' });
    await expect(c.dividends.reconcile(e.id)).rejects.toMatchObject({ code: 'ENTITLEMENT_NOT_RECONCILABLE' });
  });

  it('validates declarations like the API and clears estimates on edit', async () => {
    const c = client();
    await expect(
      c.dividends.createDeclaration({
        symbol: 'OGDC',
        bookClosureFrom: '2026-12-10',
        announcementDate: '2026-12-11',
        dividendPerShare: '2',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'announcementDate' }] });
    await expect(
      c.dividends.createDeclaration({ symbol: 'OGDC', bookClosureFrom: '2026-12-10', dividendPerShare: '0' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      c.dividends.createDeclaration({ symbol: 'NOPE', bookClosureFrom: '2026-12-10', dividendPerShare: '1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const d = await c.dividends.createDeclaration({
      symbol: 'ogdc',
      bookClosureFrom: '2026-11-10',
      dividendPerShare: '1.5',
    });
    expect(d).toMatchObject({ symbol: 'OGDC', source: 'USER_REPORTED', locked: false });
    await expect(
      c.dividends.createDeclaration({ symbol: 'OGDC', bookClosureFrom: '2026-11-10', dividendPerShare: '1' }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    await c.dividends.compute(LIVE_PORTFOLIO_ID);
    await expect(c.dividends.updateDeclaration(d.id, { paymentDate: '2026-11-01' })).rejects.toMatchObject({
      code: 'INVALID_DATE_ORDER',
    });
    const u = await c.dividends.updateDeclaration(d.id, { dividendPerShare: '2' });
    expect(u.estimatedEntitlementsCleared).toBe(1);
    expect((await c.dividends.entitlements(LIVE_PORTFOLIO_ID)).data.some((e) => e.dividendId === d.id)).toBe(
      false,
    );
  });

  it('uses only verified rates, and never maps an UNKNOWN filer status to a rate', () => {
    const rate = (verified: boolean): TaxRate => ({
      id: 't',
      type: 'DIVIDEND_WITHHOLDING',
      filerStatus: 'FILER',
      ratePct: '15',
      effectiveFrom: '2026-07-01',
      verified,
      note: '',
    });
    expect(lookupDemoWht([rate(false)], 'FILER', '2026-11-01').status).toBe('NOT_CONFIGURED');
    expect(lookupDemoWht([rate(true)], 'UNKNOWN', '2026-11-01').status).toBe('NOT_CONFIGURED');
    const ok = lookupDemoWht([rate(true)], 'FILER', '2026-11-01');
    expect(ok.status === 'CONFIGURED' && ok.rate.toFixed(8)).toBe('0.15000000');
  });

  it('counts only shares settled strictly before the book closure (T+1, weekends skipped)', () => {
    const buy = (tradeDate: string, quantity: string): LedgerEntry => ({
      kind: 'txn',
      txn: {
        id: tradeDate,
        portfolioId: 'p',
        tradeDate,
        type: 'BUY',
        symbol: 'OGDC',
        quantity,
        price: '1',
        grossAmount: '1',
        fees: '0',
        netAmount: '-1',
        source: 'SIMULATED',
        reference: null,
        orderId: null,
      },
    });
    expect(addBusinessDays('2026-11-13', 1)).toBe('2026-11-16'); // Fri → Mon
    // Book closure starts Tue 17th: Fri 13th settles Mon 16th (counted); Mon 16th settles Tue 17th (not).
    const ledger = [buy('2026-11-13', '100'), buy('2026-11-16', '50')];
    expect(eligibleShares(ledger, 'OGDC', '2026-11-17', 1).toString()).toBe('100');
  });
});
