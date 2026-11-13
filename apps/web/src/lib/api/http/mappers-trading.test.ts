import { describe, expect, it, vi } from 'vitest';
import { HttpApiClient } from '../http-client';
import {
  mapBacktest,
  mapBacktestTrades,
  mapComparison,
  mapEvaluation,
  mapSignal,
  mapStrategy,
  mapTemplate,
  mapTransaction,
  mapValidation,
  toApiStrategyInput,
  toApiStrategyUpdate,
  type ApiBacktest,
  type ApiSignal,
  type ApiStrategy,
  type ApiTransaction,
} from './mappers';

const DISCLAIMER =
  'Past simulated performance does not guarantee future returns. Results exclude market impact and may use simulated or delayed data.';

const apiStrategy: ApiStrategy = {
  id: 's1',
  name: 'EMA',
  portfolioId: 'p1',
  symbol: 'OGDC',
  type: 'MA_CROSSOVER',
  mode: 'LIVE',
  isActive: true,
  autoExecute: false,
  version: 2,
  parameters: { fastPeriod: 9, slowPeriod: 21, maType: 'EMA' },
  stopLossPct: '5',
  takeProfitPct: null,
  trailingStopPct: null,
  cooldownBars: 1,
  maxInvestment: '100000',
  maxPositionQty: null,
  riskPerTradePct: null,
  lastEvaluatedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
};

const apiSignal: ApiSignal = {
  id: 'g1',
  strategyId: 's1',
  strategyName: 'EMA',
  symbol: 'OGDC',
  mode: 'LIVE',
  type: 'ENTRY',
  reason: 'RULE_ENTRY',
  side: 'BUY',
  barTs: '2026-11-12T10:30:00.000Z',
  price: { value: '271.5', source: 'PROVIDER' },
  suggestedQty: '100',
  status: 'NEW',
  orderId: null,
  createdAt: '2026-11-12T10:35:00.000Z',
};

const apiBacktest: ApiBacktest = {
  id: 'b1',
  status: 'SUCCEEDED',
  strategyId: null,
  strategyType: 'RSI',
  symbol: 'OGDC',
  from: '2025-01-01',
  to: '2026-11-13',
  initialCapital: '1000000',
  finalEquity: '1100000',
  totalReturnPct: '10',
  maxDrawdownPct: '4.5',
  sharpe: '1.1',
  winRatePct: '55',
  tradesCount: 7,
  feesTotal: '1234.5',
  benchmark: { label: 'Buy & hold', totalReturnPct: '8' },
  metrics: {
    initialCapital: '1000000',
    finalEquity: '1100000',
    totalReturnPct: '10',
    cagrPct: '5.1',
    annualizedReturnPct: '5.2',
    maxDrawdownPct: '4.5',
    sharpe: '1.1',
    sortino: '1.6',
    tradeCount: 7,
    winRatePct: '55',
    profitFactor: null,
    avgWin: '100',
    avgLoss: '-50',
    riskReward: '2',
    exposurePct: '40',
    feesTotal: '1234.5',
    buyAndHoldReturnPct: '8',
  },
  dataSource: 'SIMULATED',
  error: null,
  createdAt: '2026-11-13T00:00:00.000Z',
  finishedAt: '2026-11-13T00:00:01.000Z',
  params: { slippageBps: '10' },
  equityCurve: [
    { t: '2025-01-02T00:00:00.000Z', equity: '1000000', drawdown: '0' },
    { t: '2025-01-03T00:00:00.000Z', equity: null, drawdown: null },
    { t: '2025-01-06T00:00:00.000Z', equity: '990000', drawdown: '1' },
  ],
  disclaimer: DISCLAIMER,
};

describe('trading mappers', () => {
  it('mapTransaction keeps per-line fee provenance, the reversed flag and realised P&L', () => {
    const t: ApiTransaction = {
      id: 't1',
      symbol: 'OGDC',
      type: 'SELL',
      tradeDate: '2026-11-12',
      quantity: '10',
      price: '270',
      grossAmount: '2700',
      feesTotal: '9.32',
      taxesTotal: '1.21',
      netAmount: '2689.47',
      realizedPnl: '120.5',
      source: 'USER_REPORTED',
      reversed: true,
      fees: [
        { component: 'COMMISSION', amount: '8.10', source: 'ESTIMATED' },
        { component: 'CDC_CHARGES', amount: '1.22', source: 'BROKER_CONFIRMED' },
      ],
    };
    const m = mapTransaction(t, 'p1');
    expect(m).toMatchObject({ reversed: true, realizedPnl: '120.5', fees: '9.32', taxes: '1.21' });
    expect(m.feeLines?.map((f) => f.source)).toEqual(['ESTIMATED', 'BROKER_CONFIRMED']);
  });

  it('mapTemplate keeps the parameter schema; mapStrategy renames isActive', () => {
    const t = mapTemplate({
      type: 'RSI',
      label: 'RSI',
      description: 'd',
      params: [
        {
          name: 'period',
          type: 'INT',
          default: 14,
          min: '2',
          max: '50',
          options: null,
          required: false,
          description: 'p',
        },
      ],
      overlays: ['stopLossPct'],
    });
    expect(t.params[0]).toMatchObject({ name: 'period', type: 'INT', min: '2', max: '50' });
    expect(mapStrategy(apiStrategy)).toMatchObject({ active: true, mode: 'LIVE', stopLossPct: '5' });
  });

  it('strategy request bodies omit unset overlays; updates send null to clear', () => {
    expect(
      toApiStrategyInput({
        name: 'x',
        portfolioId: 'p',
        symbol: 'OGDC',
        type: 'RSI',
        parameters: { period: 14 },
        stopLossPct: null,
        autoExecute: false,
        maxInvestment: '1000',
      }),
    ).toEqual({
      name: 'x',
      portfolioId: 'p',
      symbol: 'OGDC',
      autoExecute: false,
      type: 'RSI',
      parameters: { period: 14 },
      maxInvestment: '1000',
    });
    expect(toApiStrategyUpdate({ stopLossPct: null, name: undefined, maxInvestment: '5' })).toEqual({
      stopLossPct: null,
      maxInvestment: '5',
    });
  });

  it('mapSignal keeps price provenance with the bar time as asOf', () => {
    expect(mapSignal(apiSignal).price).toEqual({
      value: '271.5',
      source: 'PROVIDER',
      asOf: '2026-11-12T10:30:00.000Z',
    });
  });

  it('mapValidation turns dry-run traces into the explainability shape', () => {
    const v = mapValidation({
      valid: true,
      warmupBars: 21,
      parameters: { fastPeriod: '9' },
      dryRun: {
        symbol: 'OGDC',
        bars: 250,
        from: '2025-11-01T00:00:00.000Z',
        to: '2026-11-12T00:00:00.000Z',
        dataSource: 'SIMULATED',
        warmupComplete: true,
        note: 'n',
        signals: [
          {
            type: 'ENTRY',
            reason: 'RULE_ENTRY',
            side: 'BUY',
            ts: '2026-10-01T00:00:00.000Z',
            price: '250',
            summary: 's',
            score: { total: '60', direction: 'BULLISH', components: [] },
            trace: {
              rule: {
                result: true,
                warm: true,
                trace: [
                  {
                    path: '$.entryRules',
                    kind: 'crossesAbove',
                    result: true,
                    operands: [{ label: 'EMA(9)', value: '251.2', history: ['250', '251.2'] }],
                    text: 'EMA(9)=251.2 crossed above EMA(21)=250.85 -> true',
                  },
                ],
              },
              overlays: [],
              summary: 'entry',
            },
            wouldFill: true,
            barIndex: 10,
          },
        ],
        disclaimer: DISCLAIMER,
      },
    });
    const s = v.dryRun!.signals[0];
    expect(s.trace.rule!.trace[0]).toEqual({
      path: '$.entryRules',
      kind: 'crossesAbove',
      result: true,
      operands: [{ label: 'EMA(9)', value: '251.2' }],
      text: 'EMA(9)=251.2 crossed above EMA(21)=250.85 -> true',
    });
    expect(s.note).toBeNull();
    expect(v.dryRun!.dataSource).toBe('SIMULATED');
  });

  it('mapEvaluation maps the signal and never invents an order', () => {
    const e = mapEvaluation({
      execution: {
        id: 'x',
        mode: 'LIVE',
        status: 'SUCCEEDED',
        startedAt: 'a',
        finishedAt: 'b',
        barTs: 'c',
        signalsGenerated: 1,
        details: {},
        error: null,
      },
      signal: apiSignal,
      duplicate: false,
      order: null,
      note: 'LIVE strategy: signal recorded only.',
    });
    expect(e.order).toBeNull();
    expect(e.signal?.id).toBe('g1');
    expect(e.execution).not.toHaveProperty('details');
  });

  it('mapBacktest keeps SIMULATED, the disclaimer and slippage; drops null equity points', () => {
    const b = mapBacktest(apiBacktest);
    expect(b.dataSource).toBe('SIMULATED');
    expect(b.disclaimer).toBe(DISCLAIMER);
    expect(b.slippageBps).toBe('10');
    expect(b.metrics).toMatchObject({ sortino: '1.6', profitFactor: null, tradeCount: 7 });
    expect(b.equityCurve).toEqual([
      { t: '2025-01-02T00:00:00.000Z', equity: '1000000', drawdownPct: '0' },
      { t: '2025-01-06T00:00:00.000Z', equity: '990000', drawdownPct: '1' },
    ]);
  });

  it('mapBacktest falls back to the summary columns when stored metrics are missing (list rows)', () => {
    const b = mapBacktest({ ...apiBacktest, metrics: null, equityCurve: undefined, params: undefined });
    expect(b.metrics).toMatchObject({ totalReturnPct: '10', sortino: null, tradeCount: 7 });
    expect(b.equityCurve).toEqual([]);
    expect(b.slippageBps).toBeNull();
    expect(mapBacktest({ ...apiBacktest, status: 'FAILED', metrics: null }).metrics).toBeNull();
  });

  it('mapBacktestTrades keeps open positions without P&L; mapComparison keeps the benchmark', () => {
    const t = mapBacktestTrades({
      data: [
        {
          id: 'x',
          entryTs: 'a',
          exitTs: null,
          quantity: '10',
          entryPrice: '1',
          exitPrice: null,
          fees: '0.1',
          pnl: null,
          exitReason: null,
          open: true,
        },
      ],
      source: 'SIMULATED',
      disclaimer: DISCLAIMER,
    });
    expect(t.data[0]).toMatchObject({ open: true, pnl: null });
    const c = mapComparison({
      symbol: 'OGDC',
      interval: 'D1',
      from: '2025-01-01',
      to: '2026-01-01',
      initialCapital: '1',
      slippageBps: '0',
      bars: 200,
      dataSource: 'PROVIDER',
      rows: [
        {
          label: 'A',
          strategyId: null,
          strategyType: 'RSI',
          metrics: { totalReturnPct: '3', tradeCount: 2 },
        },
      ],
      benchmark: { label: 'Buy & hold', totalReturnPct: '1.5' },
      disclaimer: DISCLAIMER,
    });
    expect(c.rows[0].metrics).toMatchObject({ totalReturnPct: '3', sharpe: null, tradeCount: 2 });
    expect(c.benchmark.totalReturnPct).toBe('1.5');
  });
});

function client(responses: Response[]) {
  const fetchMock = vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 }));
  const c = new HttpApiClient({
    fetch: fetchMock as unknown as typeof fetch,
    readCookie: (n) => (n === 'ktrade_csrf' ? 'tok' : undefined),
    now: () => Date.parse('2026-11-13T05:00:00Z'),
  });
  return { c, calls: fetchMock.mock.calls as unknown as [string, RequestInit][] };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const headers = (init: RequestInit) => init.headers as Record<string, string>;

describe('HttpApiClient trading endpoints', () => {
  it('step-up sends exactly the proof given (password when TOTP is off)', async () => {
    const { c, calls } = client([
      json({ stepUpToken: 's', expiresIn: 300 }),
      json({ stepUpToken: 't', expiresIn: 300 }),
    ]);
    await c.auth.stepUp({ password: '123456' });
    await c.auth.stepUp({ totpCode: '654321' });
    expect(calls[0][1].body).toBe(JSON.stringify({ password: '123456' }));
    expect(calls[1][1].body).toBe(JSON.stringify({ totpCode: '654321' }));
  });

  it('pages transactions and orders by cursor', async () => {
    const { c, calls } = client([json({ data: [], nextCursor: 'c2' }), json({ data: [], nextCursor: null })]);
    expect((await c.portfolios.transactions('p1', { cursor: 'c1', limit: 25 })).nextCursor).toBe('c2');
    await c.orders.list({ status: 'FILLED', portfolioId: 'p1', cursor: 'o1' });
    expect(calls[0][0]).toBe('/bff/portfolios/p1/transactions?limit=25&cursor=c1');
    expect(calls[1][0]).toBe('/bff/orders?status=FILLED&portfolioId=p1&cursor=o1&limit=50');
  });

  it('preview uses the ticket’s Idempotency-Key', async () => {
    const { c, calls } = client([
      json({ ...minimalOrder, estimate: { notional: null, fees: null, total: null, source: 'ESTIMATED' } }),
    ]);
    await c.orders.preview({
      portfolioId: 'p1',
      symbol: 'OGDC',
      side: 'BUY',
      type: 'MARKET',
      quantity: '10',
      origin: 'MANUAL',
      idempotencyKey: 'ticket-key-123',
    });
    expect(headers(calls[0][1])['Idempotency-Key']).toBe('ticket-key-123');
    expect(JSON.parse(String(calls[0][1].body))).not.toHaveProperty('idempotencyKey');
  });

  it('LIVE activation sends the step-up header; deactivation never does', async () => {
    const { c, calls } = client([json(apiStrategy), json({ ...apiStrategy, isActive: false })]);
    await c.strategies.setActive('s1', true, 'su');
    await c.strategies.setActive('s1', false, 'su');
    expect(calls[0][0]).toBe('/bff/strategies/s1/activate');
    expect(headers(calls[0][1])['X-Step-Up-Token']).toBe('su');
    expect(calls[1][0]).toBe('/bff/strategies/s1/deactivate');
    expect(headers(calls[1][1])['X-Step-Up-Token']).toBeUndefined();
  });

  it('signals per strategy, backtests list, trades and compare hit the API routes', async () => {
    const { c, calls } = client([
      json([apiSignal]),
      json({ data: [apiBacktest], disclaimer: DISCLAIMER }),
      json({ data: [], source: 'SIMULATED', disclaimer: DISCLAIMER }),
      json({
        symbol: 'OGDC',
        from: 'a',
        to: 'b',
        initialCapital: '1',
        slippageBps: '0',
        bars: 2,
        dataSource: 'SIMULATED',
        rows: [],
        benchmark: { label: 'Buy & hold', totalReturnPct: null },
        disclaimer: DISCLAIMER,
      }),
    ]);
    expect((await c.strategies.signals({ strategyId: 's1' }))[0].symbol).toBe('OGDC');
    expect((await c.backtests.list())[0].dataSource).toBe('SIMULATED');
    await c.backtests.trades('b1');
    await c.backtests.compare({
      strategyIds: ['s1'],
      definitions: [{ type: 'RSI', parameters: {}, label: 'R' }],
      from: '2025-01-01',
      to: '2026-01-01',
      initialCapital: '1000',
      slippageBps: '5',
    });
    expect(calls.map((x) => x[0])).toEqual([
      '/bff/strategies/s1/signals?limit=100',
      '/bff/backtests?limit=50',
      '/bff/backtests/b1/trades',
      '/bff/backtests/compare',
    ]);
    expect(JSON.parse(String(calls[3][1].body)).definitions).toEqual([
      { type: 'RSI', parameters: {}, label: 'R' },
    ]);
  });

  it('createPaper reads the full portfolio back instead of guessing defaults', async () => {
    const { c } = client([
      json({ id: 'p9', name: 'Paper', kind: 'PAPER' }, 201),
      json([{ id: 'p9', name: 'Paper', kind: 'PAPER', costBasisMethod: 'FIFO', initialCash: '5000' }]),
    ]);
    expect(await c.portfolios.createPaper({ name: 'Paper', initialCash: '5000' })).toMatchObject({
      id: 'p9',
      costBasisMethod: 'FIFO',
      demo: false,
    });
  });
});

const minimalOrder = {
  id: 'o1',
  portfolioId: 'p1',
  symbol: 'OGDC',
  companyName: 'OGDC',
  mode: 'PAPER',
  origin: 'MANUAL',
  side: 'BUY',
  type: 'MARKET',
  quantity: '10',
  limitPrice: null,
  stopPrice: null,
  referencePrice: null,
  status: 'PREVIEWED',
  filledQuantity: '0',
  avgFillPrice: null,
  previewHash: null,
  previewExpiresAt: null,
  rejectionReason: null,
  brokerOrderRef: null,
  createdAt: '2026-11-13T05:00:00.000Z',
};
