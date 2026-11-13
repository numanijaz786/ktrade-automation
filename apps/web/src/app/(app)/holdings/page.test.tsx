import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Holding, Portfolio } from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import HoldingsPage from './page';

const pf: Portfolio = {
  id: 'p1',
  name: 'KTrade',
  kind: 'LIVE',
  costBasisMethod: 'WEIGHTED_AVERAGE',
  demo: false,
};

const holding = (p: Partial<Holding>): Holding => ({
  symbol: 'OGDC',
  name: 'Oil & Gas Development',
  sector: 'Energy',
  quantity: '100',
  avgCost: '250.000000',
  lastPrice: { value: '270.5', source: 'PROVIDER', asOf: new Date().toISOString() },
  totalCost: '25000.0000',
  marketValue: '27050.0000',
  unrealizedPnl: '2050.0000',
  unrealizedPnlPct: '8.2',
  realizedPnl: '0.0000',
  weight: '0.6',
  dayChangePct: null,
  source: 'USER_REPORTED',
  lastConfirmed: null,
  ...p,
});

const rows = [
  holding({}),
  holding({
    symbol: 'HUBC',
    name: 'Hub Power',
    quantity: '50',
    lastPrice: { value: '150', source: 'SIMULATED', asOf: '2026-01-01T00:00:00.000Z' },
    marketValue: '7500.0000',
    unrealizedPnl: '-500.0000',
    unrealizedPnlPct: '-6.25',
    realizedPnl: '120.0000',
    weight: '0.4',
  }),
  holding({
    symbol: 'MARI',
    name: 'Mari Energies',
    lastPrice: null,
    marketValue: null,
    unrealizedPnl: null,
    unrealizedPnlPct: null,
    weight: null,
  }),
];

function setup() {
  renderWithClient(
    <HoldingsPage />,
    mockClient({
      portfolios: { list: vi.fn(async () => [pf]), holdings: vi.fn(async () => rows) },
    }),
    { portfolios: true },
  );
}

describe('Holdings page', () => {
  it('renders positions with price provenance, stale markers and no invented values', async () => {
    setup();
    const table = await screen.findByRole('table', { name: 'Holdings' });
    const ogdc = within(table).getByRole('link', { name: 'OGDC' }).closest('tr')!;
    expect(within(ogdc).getByText('Oil & Gas Development')).toBeInTheDocument();
    expect(ogdc.querySelector('[data-source="PROVIDER"]')).not.toBeNull();
    expect(ogdc.querySelector('[data-source="USER_REPORTED"]')).not.toBeNull();
    // Unrealised P&L is an estimate.
    expect(ogdc.querySelector('[data-source="ESTIMATED"]')).not.toBeNull();
    expect(within(ogdc).queryByTestId('stale-badge')).toBeNull();

    const hubc = within(table).getByRole('link', { name: 'HUBC' }).closest('tr')!;
    expect(hubc.querySelector('[data-source="SIMULATED"]')).not.toBeNull();
    expect(within(hubc).getByTestId('stale-badge')).toBeInTheDocument();
    expect(within(hubc).getByText('40.0%')).toBeInTheDocument();

    const mari = within(table).getByRole('link', { name: 'MARI' }).closest('tr')!;
    expect(within(mari).getByText('No quote')).toBeInTheDocument();
  });

  it('searches by company name and sorts by a decimal column', async () => {
    const user = userEvent.setup();
    setup();
    const table = await screen.findByRole('table', { name: 'Holdings' });
    await user.type(screen.getByLabelText('Search Holdings'), 'hub power');
    expect(
      within(table)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['HUBC']);
    await user.clear(screen.getByLabelText('Search Holdings'));
    await user.click(within(table).getByRole('button', { name: /Realised/ }));
    const order = () =>
      within(table)
        .getAllByRole('link')
        .map((l) => l.textContent);
    expect(order()[order().length - 1]).toBe('HUBC');
  });
});
