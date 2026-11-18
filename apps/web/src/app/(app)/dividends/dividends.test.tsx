import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  declarationPatch,
  summarizeDividendIncome,
  validateDeclarationForm,
  validateMarkPaidForm,
  WHT_REQUIRED_MESSAGE,
  type DeclarationFormValues,
} from '@/lib/api/dividends-rules';
import type {
  DividendDeclaration,
  DividendEntitlement,
  DividendMarkPaidInput,
  DividendMarkPaidResult,
} from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import { DeclarationForm } from './declaration-form';
import { EntitlementsTable } from './entitlements-table';
import { MarkPaidForm } from './mark-paid-dialog';

const base: DeclarationFormValues = {
  symbol: 'ogdc',
  announcementDate: '2026-10-01',
  bookClosureFrom: '2026-10-20',
  bookClosureTo: '2026-10-22',
  paymentDate: '2026-11-05',
  dividendPerShare: '4.25',
};
const errorsOf = (v: Partial<DeclarationFormValues>) => {
  const r = validateDeclarationForm({ ...base, ...v });
  return r.ok ? {} : r.errors;
};

const entitlement: DividendEntitlement = {
  id: 'e1',
  dividendId: 'd1',
  portfolioId: 'p1',
  symbol: 'OGDC',
  bookClosureFrom: '2026-10-20',
  bookClosureTo: null,
  paymentDate: '2026-11-05',
  dividendPerShare: '4.25',
  sharesEligible: '1000',
  grossAmount: '4250.0000',
  whtRate: null,
  whtAmount: null,
  zakatAmount: '0.0000',
  netAmount: null,
  netBeforeWht: '4250.0000',
  taxStatus: 'NOT_CONFIGURED',
  taxNote: 'No verified dividend WHT rate for FILER on 2026-11-05.',
  status: 'ENTITLED',
  source: 'ESTIMATED',
  provisional: true,
  paidAt: null,
  cashMovementId: null,
  reconciledAt: null,
  updatedAt: '2026-11-13T05:00:00.000Z',
};

describe('validateDeclarationForm', () => {
  it('builds the API input (upper-case symbol, empty optional dates → null)', () => {
    const r = validateDeclarationForm({ ...base, announcementDate: '', bookClosureTo: '', paymentDate: '' });
    expect(r).toEqual({
      ok: true,
      input: {
        symbol: 'OGDC',
        announcementDate: null,
        bookClosureFrom: '2026-10-20',
        bookClosureTo: null,
        paymentDate: null,
        dividendPerShare: '4.25',
      },
    });
  });

  it('rejects non-decimal DPS before any numeric check, then zero / negative / > 6 dp', () => {
    for (const dividendPerShare of ['abc', '1e3', '12.', '', '1,000'])
      expect(errorsOf({ dividendPerShare }).dividendPerShare, dividendPerShare).toMatch(/Enter a number/);
    expect(errorsOf({ dividendPerShare: '0' }).dividendPerShare).toBe('Must be greater than zero');
    expect(errorsOf({ dividendPerShare: '-1' }).dividendPerShare).toBe('Must be greater than zero');
    expect(errorsOf({ dividendPerShare: '1.1234567' }).dividendPerShare).toBe('At most 6 decimal places');
    expect(errorsOf({ dividendPerShare: '1.123456' })).toEqual({});
  });

  it('mirrors the API date order (announcement ≤ start ≤ end ≤ payment)', () => {
    expect(errorsOf({ announcementDate: '2026-10-21' }).announcementDate).toMatch(/on or before/);
    expect(errorsOf({ bookClosureTo: '2026-10-19' }).bookClosureTo).toMatch(/on or after its start/);
    expect(errorsOf({ paymentDate: '2026-10-21' }).paymentDate).toMatch(/on or after the book closure/);
    // Without an end date, payment only needs to be on or after the start.
    expect(errorsOf({ bookClosureTo: '', paymentDate: '2026-10-20' })).toEqual({});
    expect(errorsOf({ bookClosureFrom: '' }).bookClosureFrom).toBe('Required');
    expect(errorsOf({ paymentDate: '2026-02-30' }).paymentDate).toMatch(/Enter a date/);
    expect(errorsOf({ symbol: 'BAD SYMBOL' }).symbol).toBe('Invalid symbol');
  });

  it('declarationPatch sends only what changed (DPS compared as decimals)', () => {
    const d: DividendDeclaration = {
      id: 'd1',
      symbol: 'OGDC',
      companyName: null,
      announcementDate: '2026-10-01',
      bookClosureFrom: '2026-10-20',
      bookClosureTo: '2026-10-22',
      paymentDate: '2026-11-05',
      dividendPerShare: '4.250000',
      source: 'USER_REPORTED',
      locked: false,
      createdAt: '2026-10-01T00:00:00Z',
    };
    const r = validateDeclarationForm({ ...base, paymentDate: '' });
    expect(r.ok && declarationPatch(d, r.input)).toEqual({ paymentDate: null });
  });

  it('the form shows errors and does not call the API when invalid', async () => {
    const createDeclaration = vi.fn();
    renderWithClient(
      <DeclarationForm onDone={() => undefined} />,
      mockClient({ dividends: { createDeclaration } }),
    );
    await userEvent.type(screen.getByLabelText('Symbol'), 'OGDC');
    await userEvent.type(screen.getByLabelText('Dividend per share (Rs)'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Record dividend' }));
    expect(await screen.findByText(/Enter a number/)).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(createDeclaration).not.toHaveBeenCalled();
  });
});

describe('EntitlementsTable', () => {
  it('shows WHT and net as "not configured" (never a number) when no verified rate applies', () => {
    renderWithClient(
      <EntitlementsTable
        rows={[entitlement]}
        isOwner
        onMarkPaid={() => undefined}
        onReconcile={() => undefined}
      />,
      mockClient({}),
    );
    const row = screen.getByTestId('entitlement-OGDC');
    const placeholders = within(row).getAllByTestId('tax-not-configured');
    expect(placeholders).toHaveLength(2);
    expect(placeholders[0]).toHaveTextContent('not configured');
    expect(placeholders[0]).toHaveAccessibleName(/verified tax rates/);
    expect(within(row).getByText('Not configured')).toBeInTheDocument();
    expect(within(row).getByText('Provisional')).toBeInTheDocument();
    // Gross is shown; nothing is presented as a 0 WHT.
    expect(row).toHaveTextContent('4,250.00');
    expect(row).not.toHaveTextContent('Rs 0.00');
    expect(within(row).getByRole('button', { name: /Provenance: Estimated/ })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Mark paid/ })).toBeInTheDocument();
  });

  it('shows recorded figures for a paid row and offers reconcile (owner only)', () => {
    const paid: DividendEntitlement = {
      ...entitlement,
      status: 'PAID',
      source: 'USER_REPORTED',
      taxStatus: 'AS_PAID',
      whtAmount: '600.0000',
      netAmount: '3650.0000',
      provisional: false,
      paidAt: '2026-11-05',
    };
    const { unmount } = renderWithClient(
      <EntitlementsTable rows={[paid]} isOwner onMarkPaid={() => undefined} onReconcile={() => undefined} />,
      mockClient({}),
    );
    const row = screen.getByTestId('entitlement-OGDC');
    expect(within(row).queryByTestId('tax-not-configured')).toBeNull();
    expect(row).toHaveTextContent('600.00');
    expect(row).toHaveTextContent('3,650.00');
    expect(within(row).getByRole('button', { name: /Reconcile/ })).toBeInTheDocument();
    unmount();
    renderWithClient(
      <EntitlementsTable
        rows={[paid]}
        isOwner={false}
        onMarkPaid={() => undefined}
        onReconcile={() => undefined}
      />,
      mockClient({}),
    );
    expect(screen.queryByRole('button', { name: /Reconcile/ })).toBeNull();
  });
});

describe('mark paid', () => {
  it('validateMarkPaidForm requires WHT (0 allowed), rejects the future and WHT above gross', () => {
    const ctx = { today: '2026-11-13', grossAmount: '4250.0000' };
    const ok = { paidAt: '2026-11-10', netAmount: '3650', whtAmount: '600', zakatAmount: '' };
    expect(validateMarkPaidForm(ok, ctx)).toEqual({
      ok: true,
      input: { paidAt: '2026-11-10', netAmount: '3650', whtAmount: '600' },
    });
    const err = (v: Partial<typeof ok>) => {
      const r = validateMarkPaidForm({ ...ok, ...v }, ctx);
      return r.ok ? {} : r.errors;
    };
    expect(err({ whtAmount: '' }).whtAmount).toBe(WHT_REQUIRED_MESSAGE);
    expect(err({ whtAmount: '0' })).toEqual({});
    expect(err({ whtAmount: 'x' }).whtAmount).toMatch(/Enter a number/);
    expect(err({ whtAmount: '-1' }).whtAmount).toBe('Must not be negative');
    expect(err({ whtAmount: '4250.0001' }).whtAmount).toMatch(/exceeds the gross/);
    expect(err({ netAmount: '0' }).netAmount).toBe('Must be greater than zero');
    expect(err({ netAmount: '1.12345' }).netAmount).toBe('At most 4 decimal places');
    expect(err({ paidAt: '2026-11-14' }).paidAt).toBe('Cannot be in the future');
    expect(err({ zakatAmount: '-2' }).zakatAmount).toMatch(/non-negative/);
  });

  it('the dialog blocks submit without WHT, then shows the API’s unexplained difference prominently', async () => {
    const result: DividendMarkPaidResult = {
      entitlement: {
        ...entitlement,
        status: 'PAID',
        source: 'USER_REPORTED',
        taxStatus: 'AS_PAID',
        whtAmount: '600.0000',
        netAmount: '3600.0000',
        paidAt: '2026-11-10',
      },
      cashMovementId: 'c1',
      whtBasis: 'REPORTED',
      unexplainedDifference: '50.0000',
      warnings: [
        'gross − zakat − withholding − received = 50.0000: check the share count and the payment advice',
      ],
      estimate: { netAmount: null, whtAmount: null, grossAmount: '4250.0000', taxStatus: 'NOT_CONFIGURED' },
      differences: { netAmount: null, whtAmount: null, grossAmount: '-50.0000' },
    };
    const markPaid = vi.fn<(id: string, input: DividendMarkPaidInput) => Promise<DividendMarkPaidResult>>(
      async () => result,
    );
    renderWithClient(
      <MarkPaidForm entitlement={entitlement} today="2026-11-13" onClose={() => undefined} />,
      mockClient({ dividends: { markPaid } }),
    );
    // The estimate shows WHT as not configured, never as a number.
    expect(screen.getByTestId('tax-not-configured')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Net received (Rs)'), '3600');
    await userEvent.click(screen.getByRole('button', { name: 'Mark paid' }));
    expect(await screen.findByText(WHT_REQUIRED_MESSAGE)).toBeInTheDocument();
    expect(markPaid).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/WHT deducted/), '600');
    await userEvent.click(screen.getByRole('button', { name: 'Mark paid' }));
    await waitFor(() => expect(markPaid).toHaveBeenCalledTimes(1));
    expect(markPaid.mock.calls[0]).toEqual([
      'e1',
      { paidAt: '2026-11-05', netAmount: '3600', whtAmount: '600' },
    ]);
    const banner = await screen.findByTestId('unexplained-difference');
    expect(banner).toHaveTextContent('Unexplained difference: Rs 50.0000');
    expect(banner).toHaveTextContent(/NOT booked as tax/);
    expect(screen.getByText(/check the share count/)).toBeInTheDocument();
    expect(screen.getAllByText('n/a — no verified WHT estimate')).toHaveLength(2);
  });
});

describe('summarizeDividendIncome', () => {
  it('sums recorded figures with the weakest provenance; pending is gross and ESTIMATED', () => {
    const s = summarizeDividendIncome([
      entitlement,
      {
        ...entitlement,
        id: 'e2',
        status: 'RECONCILED',
        source: 'BROKER_CONFIRMED',
        taxStatus: 'AS_PAID',
        whtAmount: '100.0000',
        netAmount: '900.0000',
      },
      {
        ...entitlement,
        id: 'e3',
        status: 'PAID',
        source: 'USER_REPORTED',
        taxStatus: 'AS_PAID',
        whtAmount: '0.5000',
        netAmount: '10.2500',
      },
    ]);
    expect(s.receivedNet).toEqual({ value: '910.2500', source: 'USER_REPORTED', count: 2 });
    expect(s.whtWithheld).toEqual({ value: '100.5000', source: 'USER_REPORTED', count: 2 });
    expect(s.pendingGross).toEqual({ value: '4250.0000', source: 'ESTIMATED', count: 1 });
    expect(s.pendingWithoutTax).toBe(1);
    expect(summarizeDividendIncome([]).receivedNet.source).toBeNull();
  });
});
