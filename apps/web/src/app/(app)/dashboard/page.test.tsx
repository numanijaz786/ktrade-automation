import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DashboardSummary, Holding, Portfolio, PortfolioPerformance } from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import DashboardPage from './page';

// jsdom has no canvas; lightweight-charts itself is not under test here.
vi.mock('@/components/line-chart', () => ({
  LineChart: ({ label, series }: { label: string; series: unknown[] }) => (
    <div role="img" aria-label={label} data-points={series.length} />
  ),
}));

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

const owner = {
  id: 'u1',
  email: 'o@example.com',
  displayName: 'Owner',
  role: 'OWNER' as const,
  totpEnabled: false,
};

const emptyPerf: PortfolioPerformance = {
  portfolioId: 'p1',
  range: '3M',
  from: null,
  to: null,
  source: 'SIMULATED',
  methodology: null,
  note: 'No snapshots yet — run POST /portfolios/:id/snapshots/backfill',
  series: [],
  twr: { valuePct: null, baseDate: null, source: 'SIMULATED' },
  maxDrawdown: null,
  monthly: [],
  simpleReturn: { valuePct: null, asOf: null, source: 'SIMULATED' },
  xirr: { valuePct: null, asOf: null, source: 'SIMULATED' },
};

const perf: PortfolioPerformance = {
  ...emptyPerf,
  from: '2026-08-14',
  to: '2026-11-13',
  note: null,
  methodology: 'Snapshots value the portfolio at each PSX close.',
  series: [
    { date: '2026-11-12', totalValue: '1000000.0000', dailyPnl: '0.0000', twrIndex: '1.0000000000' },
    { date: '2026-11-13', totalValue: '1002000.0000', dailyPnl: '2000.0000', twrIndex: '1.0020000000' },
  ],
  twr: { valuePct: '0.2000', baseDate: '2026-08-13', source: 'SIMULATED' },
  maxDrawdown: {
    valuePct: '1.5000',
    peakDate: '2026-09-01',
    troughDate: '2026-09-10',
    recoveryDate: null,
    source: 'SIMULATED',
  },
  monthly: [
    { month: '2026-10', pnl: '-500.0000', days: 21, source: 'SIMULATED' },
    { month: '2026-11', pnl: '2000.0000', days: 9, source: 'SIMULATED' },
  ],
  simpleReturn: { valuePct: '0.2000', asOf: '2026-11-13', source: 'SIMULATED' },
  xirr: { valuePct: null, asOf: '2026-11-13', source: 'SIMULATED' },
};

function setup(
  over: {
    summary?: DashboardSummary;
    performance?: (pf: string, r: string) => Promise<PortfolioPerformance>;
    onBackfill?: () => void;
  } = {},
) {
  const performance = vi.fn(over.performance ?? (async () => perf));
  const backfillSnapshots = vi.fn(async () => {
    over.onBackfill?.();
    return {
      portfolioId: 'p1',
      from: '2026-01-02',
      to: '2026-11-13',
      tradingDays: 210,
      unpricedSymbols: [],
    };
  });
  renderWithClient(
    <DashboardPage />,
    mockClient({
      auth: { me: vi.fn(async () => owner) },
      portfolios: { list: vi.fn(async () => [pf]), holdings: vi.fn(async () => [holding]) },
      dashboard: {
        summary: vi.fn(async () => over.summary ?? summary),
        performance,
        backfillSnapshots,
      },
      orders: { list: vi.fn(async () => ({ data: [], nextCursor: null })) },
    }),
    { portfolios: true },
  );
  return { performance, backfillSnapshots };
}

describe('Dashboard', () => {
  it('shows KPIs with provenance and "not available yet" for null snapshot figures', async () => {
    setup();
    const kpis = await screen.findByTestId('kpis');
    expect(within(kpis).getByText('Rs 1,002,000.00')).toBeInTheDocument();
    expect(within(kpis).getAllByText('Not available yet')).toHaveLength(2);
    expect(within(kpis).getByText('Rs 93.15')).toBeInTheDocument();
    expect(kpis.querySelector('[data-source="ESTIMATED"]')).not.toBeNull();
    expect(within(kpis).getByText('No broker cash statement yet')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Allocation by holding' })).toHaveTextContent('100.0%');
    expect(await screen.findByText('No orders yet')).toBeInTheDocument();
  });

  it('explains the basis of today’s and this month’s P&L in a tooltip', async () => {
    setup({
      summary: {
        ...summary,
        todayPnl: {
          value: '-1250.5000',
          source: 'PROVIDER',
          basis: 'LIVE_VS_PREVIOUS_SNAPSHOT',
          tradingDate: '2026-11-13',
          previousCloseDate: '2026-11-12',
        },
        todayPnlPct: { value: '-0.4100', source: 'PROVIDER' },
        monthPnl: {
          value: '3000.0000',
          source: 'SIMULATED',
          basis: 'SNAPSHOTS',
          month: '2026-11',
          sessions: 9,
        },
      },
    });
    const kpis = await screen.findByTestId('kpis');
    expect(within(kpis).getByText('−Rs 1,250.50')).toBeInTheDocument();
    const today = within(kpis).getByRole('button', { name: /Live vs previous close/ });
    expect(today).toHaveAttribute('data-basis', 'LIVE_VS_PREVIOUS_SNAPSHOT');
    expect(within(kpis).getByRole('button', { name: /Close snapshots/ })).toHaveAttribute(
      'data-basis',
      'SNAPSHOTS',
    );
    await userEvent.hover(today);
    expect(
      (await screen.findAllByText(/Current quotes compared with the previous close snapshot/)).length,
    ).toBeGreaterThan(0);
  });

  it('renders performance metrics with provenance, flags SIMULATED and shows XIRR n/a', async () => {
    const { performance } = setup();
    const metrics = await screen.findByTestId('performance-metrics');
    expect(screen.getByTestId('simulated-banner')).toHaveTextContent('Simulated performance');
    expect(within(metrics).getByText('TWR (3M)')).toBeInTheDocument();
    expect(within(metrics).getByText('1.50%')).toBeInTheDocument();
    expect(within(metrics).getByText('n/a')).toBeInTheDocument();
    expect(metrics.querySelectorAll('[data-source="SIMULATED"]')).toHaveLength(4);
    expect(screen.getByRole('img', { name: 'Portfolio value' })).toHaveAttribute('data-points', '2');
    const monthly = screen.getByRole('table', { name: 'Monthly P&L' });
    expect(within(monthly).getAllByRole('row')).toHaveLength(3);
    expect(within(monthly).getByText('−Rs 500.00')).toBeInTheDocument();
    expect(performance).toHaveBeenCalledWith('p1', '3M');
    await userEvent.click(screen.getByRole('button', { name: '1Y' }));
    await waitFor(() => expect(performance).toHaveBeenCalledWith('p1', '1Y'));
    expect(screen.getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows an empty state with "Backfill history" when there are no snapshots, then the data', async () => {
    let backfilled = false;
    const { backfillSnapshots } = setup({
      performance: async () => (backfilled ? perf : emptyPerf),
      onBackfill: () => (backfilled = true),
    });
    expect(await screen.findByText('No performance history yet')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Backfill history/ }));
    expect(backfillSnapshots).toHaveBeenCalledWith('p1');
    expect(await screen.findByTestId('performance-metrics')).toBeInTheDocument();
    expect(screen.queryByText('No performance history yet')).not.toBeInTheDocument();
  });
});
