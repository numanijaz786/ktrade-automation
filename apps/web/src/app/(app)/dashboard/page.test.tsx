import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { notAvailable } from '@/lib/api/errors';
import type { DashboardSummary, Holding, Portfolio } from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import DashboardPage from './page';

const pf: Portfolio = {
  id: 'p1',
  name: 'Paper',
  kind: 'PAPER',
  costBasisMethod: 'WEIGHTED_AVERAGE',
  demo: false,
};

const summary: DashboardSummary = {
  portfolioId: 'p1',
  accountValue: { value: '1002000.0000', source: 'SIMULATED' },
  investedAmount: { value: '27000.0000', source: 'SIMULATED' },
  marketValue: { value: '27050.0000', source: 'PROVIDER' },
  cash: { ledger: { value: '974950.0000', source: 'SIMULATED' }, broker: null },
  realizedPnl: { value: '0.0000', source: 'SIMULATED' },
  unrealizedPnl: { value: '50.0000', source: 'ESTIMATED' },
  todayPnl: null,
  todayPnlPct: null,
  monthPnl: null,
  totalReturnPct: { value: '0.2000', source: 'SIMULATED' },
  twrPct: null,
  xirrPct: null,
  dividendsReceived: { value: '0.0000', source: 'SIMULATED' },
  feesPaid: { value: '81.0000', source: 'ESTIMATED' },
  taxesPaid: { value: '12.1500', source: 'ESTIMATED' },
  activeHoldings: 1,
  pendingOrders: 0,
  unpricedHoldings: 0,
  sourceBreakdown: null,
  pricesAsOf: null,
  priceSource: 'PROVIDER',
};

const holding: Holding = {
  symbol: 'OGDC',
  name: 'OGDC',
  sector: null,
  quantity: '100',
  avgCost: '270',
  lastPrice: { value: '270.5', source: 'PROVIDER', asOf: '2026-11-13T07:00:00.000Z' },
  totalCost: '27000',
  marketValue: '27050',
  unrealizedPnl: '50',
  unrealizedPnlPct: '0.18',
  realizedPnl: '0',
  weight: '1',
  dayChangePct: null,
  source: 'SIMULATED',
  lastConfirmed: null,
};

describe('Dashboard', () => {
  it('shows KPIs with provenance, "not available yet" for null figures and no fake performance chart', async () => {
    renderWithClient(
      <DashboardPage />,
      mockClient({
        portfolios: { list: vi.fn(async () => [pf]), holdings: vi.fn(async () => [holding]) },
        dashboard: {
          summary: vi.fn(async () => summary),
          charts: vi.fn(async () => {
            throw notAvailable();
          }),
        },
        orders: { list: vi.fn(async () => ({ data: [], nextCursor: null })) },
      }),
      { portfolios: true },
    );
    const kpis = await screen.findByTestId('kpis');
    expect(within(kpis).getByText('Rs 1,002,000.00')).toBeInTheDocument();
    expect(within(kpis).getAllByText('Not available yet')).toHaveLength(2);
    expect(within(kpis).getByText('Rs 93.15')).toBeInTheDocument();
    expect(kpis.querySelector('[data-source="ESTIMATED"]')).not.toBeNull();
    expect(within(kpis).getByText('No broker cash statement yet')).toBeInTheDocument();
    expect(await screen.findByTestId('not-available')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Allocation by holding' })).toHaveTextContent('100.0%');
    expect(await screen.findByText('No orders yet')).toBeInTheDocument();
  });
});
