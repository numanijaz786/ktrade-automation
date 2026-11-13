import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { validateParams } from '@/components/strategy-params';
import type {
  Portfolio,
  Strategy,
  StrategyTemplate,
  StrategyValidation,
  TemplateParam,
} from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import { StrategyForm } from './strategy-form';

const params: TemplateParam[] = [
  {
    name: 'fastPeriod',
    type: 'INT',
    default: 9,
    min: '2',
    max: '100',
    options: null,
    required: false,
    description: 'Fast MA bars',
  },
  {
    name: 'slowPeriod',
    type: 'INT',
    default: 21,
    min: '5',
    max: '250',
    options: null,
    required: false,
    description: 'Slow MA bars',
  },
  {
    name: 'maType',
    type: 'ENUM',
    default: 'EMA',
    min: null,
    max: null,
    options: ['EMA', 'SMA'],
    required: false,
    description: 'Average',
  },
  {
    name: 'bandPct',
    type: 'DECIMAL',
    default: '0.5',
    min: '0',
    max: '10',
    options: null,
    required: false,
    description: 'Band',
  },
  {
    name: 'confirm',
    type: 'BOOL',
    default: false,
    min: null,
    max: null,
    options: null,
    required: false,
    description: 'Confirm',
  },
];
const templates: StrategyTemplate[] = [
  {
    type: 'MA_CROSSOVER',
    label: 'Moving-average crossover',
    description: 'Trend following.',
    params,
    overlays: [],
  },
  { type: 'CUSTOM_RULES', label: 'Custom rules', description: 'DSL', params: [], overlays: [] },
];
const paper: Portfolio = {
  id: 'pp',
  name: 'Paper',
  kind: 'PAPER',
  costBasisMethod: 'WEIGHTED_AVERAGE',
  demo: false,
};
const live: Portfolio = {
  id: 'pl',
  name: 'KTrade',
  kind: 'LIVE',
  costBasisMethod: 'WEIGHTED_AVERAGE',
  demo: false,
};

const validation: StrategyValidation = {
  valid: true,
  warmupBars: 21,
  parameters: {},
  dryRun: {
    symbol: 'OGDC',
    bars: 250,
    from: '2025-11-01T00:00:00.000Z',
    to: '2026-11-12T00:00:00.000Z',
    dataSource: 'SIMULATED',
    warmupComplete: true,
    note: null,
    signals: [
      {
        type: 'ENTRY',
        reason: 'RULE_ENTRY',
        side: 'BUY',
        ts: '2026-10-01T00:00:00.000Z',
        price: '250',
        summary: 'entry: fast crossed above slow',
        score: { total: '62', direction: 'BULLISH', components: [] },
        trace: {
          rule: {
            result: true,
            warm: true,
            trace: [
              {
                path: '$.entryRules',
                kind: 'crossesAbove',
                result: true,
                operands: [],
                text: 'EMA(9)=251.2 crossed above EMA(21)=250.85 -> true',
              },
            ],
          },
          overlays: [],
          summary: 'entry',
        },
        wouldFill: true,
        note: null,
      },
    ],
    disclaimer: 'Past simulated performance does not guarantee future returns.',
  },
};

function setup(portfolio = paper) {
  const strategies = {
    create: vi.fn(async () => ({}) as Strategy),
    validate: vi.fn(async () => validation),
  };
  const onDone = vi.fn();
  renderWithClient(
    <StrategyForm
      templates={templates}
      portfolios={[portfolio]}
      defaultPortfolioId={portfolio.id}
      onDone={onDone}
    />,
    mockClient({ strategies }),
  );
  return { strategies, onDone };
}

describe('validateParams', () => {
  it('checks bounds exactly and types values from the schema', () => {
    expect(
      validateParams(params, {
        fastPeriod: '9',
        slowPeriod: '21',
        maType: 'SMA',
        bandPct: '2.5',
        confirm: true,
      }),
    ).toEqual({
      ok: true,
      values: { fastPeriod: 9, slowPeriod: 21, maType: 'SMA', bandPct: '2.5', confirm: true },
    });
    const bad = validateParams(params, {
      fastPeriod: '1',
      slowPeriod: '9.5',
      maType: 'WMA',
      bandPct: '10.0001',
      confirm: false,
    });
    expect(bad).toEqual({
      ok: false,
      errors: {
        fastPeriod: 'At least 2',
        slowPeriod: 'Whole number',
        maType: 'Pick one of EMA, SMA',
        bandPct: 'At most 10',
      },
    });
  });
});

describe('StrategyForm', () => {
  it('generates fields from the template schema and creates a strategy', async () => {
    const user = userEvent.setup();
    const { strategies, onDone } = setup();
    // CUSTOM_RULES needs the DSL, so it is not offered in the form.
    expect(screen.getByLabelText(/Fast period/i)).toHaveValue('9');
    expect(screen.getByLabelText(/Slow period/i)).toHaveValue('21');
    expect(screen.getByLabelText(/Band %/)).toHaveValue('0.5');
    expect(screen.getByRole('checkbox', { name: 'Confirm' })).not.toBeChecked();

    await user.clear(screen.getByLabelText(/Fast period/i));
    await user.type(screen.getByLabelText(/Fast period/i), '1');
    await user.type(screen.getByLabelText('Name'), 'EMA test');
    await user.type(screen.getByLabelText('Symbol'), 'ogdc');
    await user.click(screen.getByRole('button', { name: 'Create strategy' }));
    expect(await screen.findByText('Fast Period: At least 2')).toBeInTheDocument();
    expect(strategies.create).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(/Fast period/i));
    await user.type(screen.getByLabelText(/Fast period/i), '12');
    await user.type(screen.getByLabelText('Stop-loss %'), '5');
    await user.click(screen.getByRole('checkbox', { name: /Auto-execute paper orders/ }));
    await user.click(screen.getByRole('button', { name: 'Create strategy' }));
    await waitFor(() => expect(strategies.create).toHaveBeenCalled());
    expect(strategies.create).toHaveBeenCalledWith({
      type: 'MA_CROSSOVER',
      parameters: { fastPeriod: 12, slowPeriod: 21, maType: 'EMA', bandPct: '0.5', confirm: false },
      stopLossPct: '5',
      takeProfitPct: null,
      trailingStopPct: null,
      name: 'EMA test',
      maxInvestment: '100000',
      autoExecute: true,
      portfolioId: 'pp',
      symbol: 'OGDC',
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('does not offer auto-execution for a LIVE portfolio', () => {
    setup(live);
    expect(screen.queryByRole('checkbox', { name: /Auto-execute/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('live-no-auto')).toHaveTextContent(/auto-execution is not offered/);
  });

  it('dry-runs and shows signal traces, the data source and the disclaimer', async () => {
    const user = userEvent.setup();
    const { strategies } = setup();
    await user.type(screen.getByLabelText('Symbol'), 'OGDC');
    await user.click(screen.getByRole('button', { name: /Dry run/ }));
    const run = await screen.findByTestId('dry-run');
    expect(strategies.validate).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'OGDC', bars: 250, type: 'MA_CROSSOVER' }),
    );
    expect(within(run).getByText('EMA(9)=251.2 crossed above EMA(21)=250.85 -> true')).toBeInTheDocument();
    expect(run.querySelector('[data-source="SIMULATED"]')).not.toBeNull();
    expect(within(run).getByTestId('disclaimer')).toHaveTextContent('Past simulated performance');
  });
});
