import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { ErrorState } from '@/components/states';
import { notAvailable } from '@/lib/api/errors';
import type { MarketOverview, Quote } from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import MarketOverviewPage from './page';

const quote = (symbol: string, changePct: string, extra: Partial<Quote> = {}): Quote => ({
  symbol,
  name: `${symbol} Ltd`,
  sector: 'Banks',
  last: '100.00',
  open: null,
  high: null,
  low: null,
  prevClose: '99.00',
  change: '1.00',
  changePct,
  volume: '5000',
  asOf: '2026-11-13T07:00:00.000Z',
  delayMinutes: 0,
  source: 'SIMULATED',
  stale: false,
  ...extra,
});

const overview: MarketOverview = {
  session: {
    open: false,
    tradingDay: true,
    lastCompletedSession: '2026-11-12',
    hours: 'Mon–Fri 09:30–15:30 PKT',
  },
  breadth: { advancers: 1, decliners: 1, unchanged: 0, total: 2 },
  totalVolume: '10000',
  gainers: [quote('MCB', '1.01')],
  losers: [quote('UBL', '-2.50', { stale: true })],
  mostActive: [quote('MCB', '1.01'), quote('UBL', '-2.50', { stale: true })],
  sectors: [
    {
      sector: 'Banks',
      stocks: 2,
      advancers: 1,
      decliners: 1,
      avgChangePct: '-0.75',
      volume: '10000',
      source: 'SIMULATED',
    },
  ],
  dataSource: 'SIMULATED',
  staleQuotes: 1,
  asOf: '2026-11-13T07:00:00.000Z',
  providerKey: 'simulated',
};

describe('Market overview page', () => {
  it('renders session, breadth, movers, sectors, provenance and stale markers from the client', async () => {
    const overviewFn = vi.fn().mockResolvedValue(overview);
    renderWithClient(<MarketOverviewPage />, mockClient({ market: { overview: overviewFn } }));

    expect(await screen.findByText('Closed')).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 quotes are stale/)).toBeInTheDocument();
    const gainers = screen.getByRole('region', { name: 'Top gainers' });
    expect(within(gainers).getByRole('link', { name: 'MCB' })).toHaveAttribute('href', '/market/MCB');
    const losers = screen.getByRole('region', { name: 'Top losers' });
    expect(within(losers).getByTestId('stale-badge')).toBeInTheDocument();
    const sectors = screen.getByRole('region', { name: 'Sectors' });
    expect(within(sectors).getByText('Banks')).toBeInTheDocument();
    // every price carries its provenance badge
    expect(document.querySelectorAll('[data-source="SIMULATED"]').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText('simulated')).toBeInTheDocument();
    expect(overviewFn).toHaveBeenCalledOnce();
  });

  it('shows an empty state when there are no quotes', async () => {
    renderWithClient(
      <MarketOverviewPage />,
      mockClient({
        market: {
          overview: vi.fn().mockResolvedValue({
            ...overview,
            breadth: { advancers: 0, decliners: 0, unchanged: 0, total: 0 },
            gainers: [],
            losers: [],
            mostActive: [],
            sectors: [],
            staleQuotes: 0,
          }),
        },
      }),
    );
    expect(await screen.findByText('No quotes yet')).toBeInTheDocument();
  });

  it('surfaces API errors', async () => {
    renderWithClient(
      <MarketOverviewPage />,
      mockClient({ market: { overview: vi.fn().mockRejectedValue(new Error('boom')) } }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });
});

describe('NOT_AVAILABLE handling', () => {
  it('renders a clear "not available yet" state, not an error or demo data', () => {
    renderWithClient(<ErrorState error={notAvailable()} />, mockClient({}));
    expect(screen.getByTestId('not-available')).toHaveTextContent(
      'Not available yet — coming in a later phase',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
