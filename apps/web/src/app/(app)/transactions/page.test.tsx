import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Portfolio, Transaction } from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import TransactionsPage from './page';

const pf: Portfolio = {
  id: 'p1',
  name: 'KTrade',
  kind: 'LIVE',
  costBasisMethod: 'WEIGHTED_AVERAGE',
  demo: false,
};

const txn = (p: Partial<Transaction>): Transaction => ({
  id: 't1',
  portfolioId: 'p1',
  tradeDate: '2026-11-12',
  type: 'BUY',
  symbol: 'OGDC',
  quantity: '10',
  price: '270',
  grossAmount: '2700',
  fees: '9.32',
  taxes: '1.21',
  netAmount: '-2710.53',
  source: 'USER_REPORTED',
  reference: null,
  orderId: null,
  reversed: false,
  realizedPnl: null,
  feeLines: [
    { component: 'COMMISSION', amount: '8.10', source: 'ESTIMATED' },
    { component: 'CDC_CHARGES', amount: '1.22', source: 'BROKER_CONFIRMED' },
  ],
  ...p,
});

describe('Transactions page', () => {
  it('pages by cursor (load more), marks reversals and shows per-line fee provenance', async () => {
    const user = userEvent.setup();
    const transactions = vi
      .fn()
      .mockResolvedValueOnce({
        data: [txn({}), txn({ id: 't2', symbol: 'HUBC', reversed: true })],
        nextCursor: 't2',
      })
      .mockResolvedValueOnce({
        data: [
          txn({ id: 't3', symbol: 'LUCK', type: 'SELL', realizedPnl: '55.5', source: 'BROKER_CONFIRMED' }),
        ],
        nextCursor: null,
      });
    renderWithClient(
      <TransactionsPage />,
      mockClient({ portfolios: { list: vi.fn(async () => [pf]), transactions } }),
      { portfolios: true },
    );
    const table = await screen.findByRole('table', { name: 'Transactions' });
    expect(transactions).toHaveBeenCalledWith('p1', { cursor: undefined, limit: 50 });

    const reversed = within(table).getByTestId('reversed-badge').closest('tr')!;
    expect(reversed).toHaveAttribute('data-reversed', 'true');
    expect(within(reversed).getByText('HUBC')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Show fee breakdown for BUY OGDC/ }));
    const fees = await screen.findByRole('table', { name: 'Fee breakdown for BUY OGDC' });
    expect(fees.querySelector('[data-source="ESTIMATED"]')).not.toBeNull();
    expect(fees.querySelector('[data-source="BROKER_CONFIRMED"]')).not.toBeNull();
    expect(within(fees).getByText('Rs 10.53')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(transactions).toHaveBeenLastCalledWith('p1', { cursor: 't2', limit: 50 }));
    expect(await within(table).findByText('LUCK')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getByText(/3 transactions loaded/)).toBeInTheDocument();
  });

  it('shows an empty state with no transactions', async () => {
    renderWithClient(
      <TransactionsPage />,
      mockClient({
        portfolios: {
          list: vi.fn(async () => [pf]),
          transactions: vi.fn(async () => ({ data: [], nextCursor: null })),
        },
      }),
      { portfolios: true },
    );
    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();
  });
});
