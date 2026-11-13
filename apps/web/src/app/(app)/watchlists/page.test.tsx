import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Watchlist } from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import WatchlistsPage from './page';

const list: Watchlist = {
  id: 'w1',
  name: 'Banks',
  createdAt: '2026-11-01T00:00:00.000Z',
  items: [
    {
      symbol: 'MCB',
      addedAt: '2026-11-01T00:00:00.000Z',
      quote: {
        symbol: 'MCB',
        name: 'MCB Bank',
        sector: 'Banks',
        last: '250.10',
        open: null,
        high: null,
        low: null,
        prevClose: '249.00',
        change: '1.10',
        changePct: '0.44',
        volume: '1000',
        asOf: '2026-11-13T07:00:00.000Z',
        delayMinutes: 0,
        source: 'USER_REPORTED',
        stale: true,
      },
    },
    { symbol: 'UBL', addedAt: '2026-11-01T00:00:00.000Z', quote: null },
  ],
};

function setup(lists: Watchlist[] = [list]) {
  const market = {
    watchlists: vi.fn().mockResolvedValue(lists),
    createWatchlist: vi.fn().mockResolvedValue({ ...list, id: 'w2', name: 'Energy', items: [] }),
    renameWatchlist: vi.fn().mockResolvedValue(list),
    deleteWatchlist: vi.fn().mockResolvedValue(undefined),
    addToWatchlist: vi.fn().mockResolvedValue(list),
    removeFromWatchlist: vi.fn().mockResolvedValue(list),
  };
  renderWithClient(<WatchlistsPage />, mockClient({ market }));
  return market;
}

describe('Watchlists page', () => {
  it('lists watchlists with quote columns, provenance and stale markers', async () => {
    setup();
    expect(await screen.findByRole('link', { name: 'MCB' })).toHaveAttribute('href', '/market/MCB');
    expect(screen.getByText('250.10')).toBeInTheDocument();
    expect(document.querySelector('[data-source="USER_REPORTED"]')).not.toBeNull();
    expect(screen.getAllByTestId('stale-badge').length).toBeGreaterThan(0);
    expect(screen.getByText('No quote')).toBeInTheDocument();
  });

  it('creates, renames, adds and removes through the client', async () => {
    const user = userEvent.setup();
    const market = setup();
    await screen.findByRole('link', { name: 'MCB' });

    await user.type(screen.getByLabelText('New watchlist'), 'Energy');
    await user.click(screen.getByRole('button', { name: /create/i }));
    await waitFor(() => expect(market.createWatchlist).toHaveBeenCalledWith('Energy', undefined));

    await user.type(screen.getByLabelText('Add symbol'), 'hubc');
    await user.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(market.addToWatchlist).toHaveBeenCalledWith('w1', 'HUBC'));

    await user.click(screen.getByRole('button', { name: 'Remove MCB' }));
    await waitFor(() => expect(market.removeFromWatchlist).toHaveBeenCalledWith('w1', 'MCB'));

    await user.click(screen.getByRole('button', { name: 'Rename Banks' }));
    const input = screen.getByLabelText('Watchlist name');
    await user.clear(input);
    await user.type(input, 'Big banks');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(market.renameWatchlist).toHaveBeenCalledWith('w1', 'Big banks'));
  });

  it('confirms before deleting a watchlist', async () => {
    const user = userEvent.setup();
    const market = setup();
    await screen.findByRole('link', { name: 'MCB' });
    await user.click(screen.getByRole('button', { name: /delete/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(market.deleteWatchlist).toHaveBeenCalledWith('w1'));
  });

  it('shows an empty state with no watchlists', async () => {
    setup([]);
    expect(await screen.findByText('No watchlists yet')).toBeInTheDocument();
  });
});
