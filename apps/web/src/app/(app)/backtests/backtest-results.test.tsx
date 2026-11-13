import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { Backtest } from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import { BacktestResults } from './backtest-results';

// jsdom has no canvas; lightweight-charts itself is not under test here. The stand-in keeps the chart's
// accessible name and the data it was given.
vi.mock('@/components/line-chart', () => ({
  LineChart: ({ label, series, lower }: { label: string; series: unknown[]; lower?: unknown[] }) => (
    <div role="img" aria-label={label} data-points={series.length} data-lower={lower?.length ?? 0} />
  ),
}));

const DISCLAIMER =
  'Past simulated performance does not guarantee future returns. Results exclude market impact and may use simulated or delayed data.';

const bt: Backtest = {
  id: 'b1',
  status: 'SUCCEEDED',
  strategyId: null,
  strategyType: 'MA_CROSSOVER',
  symbol: 'OGDC',
  from: '2025-01-01',
  to: '2026-11-13',
  initialCapital: '1000000',
  slippageBps: '10',
  metrics: {
    initialCapital: '1000000',
    finalEquity: '1123456.78',
    totalReturnPct: '12.345678',
    cagrPct: '6.1',
    annualizedReturnPct: '6.2',
    maxDrawdownPct: '7.5',
    sharpe: '1.234567',
    sortino: '1.9',
    tradeCount: 8,
    winRatePct: '62.5',
    profitFactor: '1.8',
    avgWin: '100',
    avgLoss: '-50',
    riskReward: '2',
    exposurePct: '40',
    feesTotal: '4321.5',
    buyAndHoldReturnPct: '9.9',
  },
  benchmark: { label: 'Buy & hold', totalReturnPct: '9.9' },
  dataSource: 'SIMULATED',
  error: null,
  createdAt: '2026-11-13T00:00:00.000Z',
  finishedAt: '2026-11-13T00:00:01.000Z',
  equityCurve: [
    { t: '2025-01-02T05:00:00.000Z', equity: '1000000', drawdownPct: '0' },
    { t: '2025-01-03T05:00:00.000Z', equity: '990000', drawdownPct: '1' },
  ],
  disclaimer: DISCLAIMER,
};

function setup(b: Backtest = bt) {
  const trades = vi.fn(async () => ({
    data: [
      {
        id: 't1',
        entryTs: '2025-02-01T05:00:00.000Z',
        exitTs: '2025-03-01T05:00:00.000Z',
        quantity: '100',
        entryPrice: '250',
        exitPrice: '260',
        fees: '150',
        pnl: '850',
        exitReason: 'RULE_EXIT' as const,
        open: false,
      },
      {
        id: 't2',
        entryTs: '2026-10-01T05:00:00.000Z',
        exitTs: null,
        quantity: '50',
        entryPrice: '270',
        exitPrice: null,
        fees: '40',
        pnl: null,
        exitReason: null,
        open: true,
      },
    ],
    source: 'SIMULATED' as const,
    disclaimer: DISCLAIMER,
  }));
  renderWithClient(<BacktestResults bt={b} />, mockClient({ backtests: { trades } }));
  return { trades };
}

describe('BacktestResults', () => {
  it('always shows the disclaimer and flags SIMULATED data prominently', async () => {
    setup();
    expect(screen.getByTestId('backtest-disclaimer')).toHaveTextContent(DISCLAIMER);
    const banner = screen.getByTestId('simulated-banner');
    expect(banner).toHaveTextContent(/Simulated price data/);
    expect(banner).toHaveTextContent(/not real PSX history/);
    await screen.findByRole('table', { name: 'Backtest trades' });
  });

  it('renders every metric, the equity/drawdown chart and trades (open ones without P&L)', async () => {
    setup();
    const metrics = screen.getByTestId('metrics');
    for (const label of [
      'Total return',
      'Annualised',
      'CAGR',
      'Max drawdown',
      'Sharpe',
      'Sortino',
      'Win rate',
      'Profit factor',
      'Risk / reward',
      'Fees paid',
      'Buy & hold',
    ])
      expect(within(metrics).getByText(label)).toBeInTheDocument();
    expect(within(metrics).getByText('+12.35%')).toBeInTheDocument();
    expect(within(metrics).getByText('7.50%')).toBeInTheDocument();
    expect(within(metrics).getByText('Rs 4,321.50')).toBeInTheDocument();
    // Results are never presented as confirmed: tiles carry Simulated/Estimated provenance.
    expect(metrics.querySelector('[data-source="BROKER_CONFIRMED"]')).toBeNull();
    const chart = screen.getByRole('img', { name: /Simulated equity for OGDC/ });
    expect(chart).toHaveAttribute('data-points', '2');
    expect(chart).toHaveAttribute('data-lower', '2');
    const trades = await screen.findByRole('table', { name: 'Backtest trades' });
    expect(within(trades).getByText('Open at end')).toBeInTheDocument();
    expect(within(trades).getByText('Still open')).toBeInTheDocument();
  });

  it('keeps the disclaimer on a failed run', () => {
    renderWithClient(
      <BacktestResults bt={{ ...bt, status: 'FAILED', metrics: null, error: 'Not enough daily bars' }} />,
      mockClient({}),
    );
    expect(screen.getByTestId('backtest-disclaimer')).toBeInTheDocument();
    expect(screen.getByText('Not enough daily bars')).toBeInTheDocument();
  });

  it('shows the provider badge instead of the simulated banner for real data', async () => {
    setup({ ...bt, dataSource: 'PROVIDER' });
    expect(screen.queryByTestId('simulated-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('backtest-disclaimer')).toBeInTheDocument();
    await screen.findByRole('table', { name: 'Backtest trades' });
  });
});
