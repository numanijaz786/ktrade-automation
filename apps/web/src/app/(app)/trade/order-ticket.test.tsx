import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Order, Portfolio, RiskCheck } from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import { OrderTicket, ticketSchema } from './order-ticket';

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

const passing: RiskCheck[] = [
  { rule: 'BUYING_POWER', passed: true, observed: '2700', limit: '100000', message: 'enough cash' },
  { rule: 'MAX_ORDER_QTY', passed: true, observed: '10', limit: '10000', message: 'within limit' },
];

function order(p: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    portfolioId: 'pp',
    mode: 'PAPER',
    status: 'PREVIEWED',
    executionPath: 'PAPER_AUTO',
    symbol: 'OGDC',
    side: 'BUY',
    type: 'MARKET',
    quantity: '10',
    limitPrice: null,
    stopPrice: null,
    timeInForce: null,
    origin: 'MANUAL',
    referencePrice: { value: '270.00', source: 'PROVIDER', asOf: '2026-11-13T07:00:00.000Z' },
    estimate: {
      notional: '2700.0000',
      fees: [
        { component: 'COMMISSION', amount: '8.10', source: 'ESTIMATED' },
        { component: 'SST_ON_COMMISSION', amount: '1.22', source: 'ESTIMATED' },
      ],
      totalFees: '9.32',
      total: '2709.3200',
    },
    riskChecks: passing,
    previewHash: 'a'.repeat(64),
    previewExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    warnings: [],
    createdAt: '2026-11-13T07:00:00.000Z',
    rejectionReason: null,
    brokerOrderRef: null,
    filledQuantity: '0',
    avgFillPrice: null,
    events: [],
    executions: [],
    ...p,
  };
}

function setup({
  portfolio = paper,
  preview = order(),
  approved,
  liveTradingEnabled = true,
}: {
  portfolio?: Portfolio;
  preview?: Order;
  approved?: Order;
  liveTradingEnabled?: boolean;
} = {}) {
  let current = preview;
  const orders = {
    preview: vi.fn(async () => current),
    get: vi.fn(async () => current),
    approve: vi.fn(async () => {
      current = approved ?? current;
      return current;
    }),
    markPlaced: vi.fn(async () => {
      current = { ...current, status: 'PLACED_BY_USER' as const };
      return current;
    }),
    recordFill: vi.fn(async (_id: string, f: { quantity: string; price: string; executedAt: string }) => {
      current = {
        ...current,
        status: 'FILLED' as const,
        filledQuantity: f.quantity,
        executions: [
          {
            id: 'x1',
            orderId: current.id,
            symbol: current.symbol,
            side: current.side,
            quantity: f.quantity,
            price: f.price,
            executedAt: f.executedAt,
            source: 'USER_REPORTED' as const,
          },
        ],
      };
      return current;
    }),
  };
  const auth = {
    me: vi.fn(async () => ({
      id: 'u',
      email: 'e',
      displayName: 'O',
      role: 'OWNER' as const,
      totpEnabled: false,
    })),
    stepUp: vi.fn(async () => ({ token: 'su-token', expiresAt: '2026-11-13T08:00:00.000Z' })),
  };
  const client = mockClient({
    portfolios: { list: vi.fn(async () => [portfolio]) },
    system: { killSwitch: vi.fn(async () => ({ liveTradingEnabled })) },
    market: { stocks: vi.fn(async () => ({ total: 0, data: [] })) },
    orders,
    auth,
  });
  renderWithClient(<OrderTicket onReset={() => undefined} />, client, { portfolios: true });
  return { orders, auth };
}

async function fillTicket(user: ReturnType<typeof userEvent.setup>, qty = '10') {
  await waitFor(() => expect(screen.getByRole('combobox', { name: /portfolio/i })).toHaveTextContent(/·/));
  await user.type(screen.getByLabelText('Symbol'), 'ogdc');
  await user.type(screen.getByLabelText('Quantity (shares)'), qty);
}

describe('ticketSchema', () => {
  it('requires whole shares and a limit price for LIMIT orders', () => {
    const base = { portfolioId: 'p', symbol: 'OGDC', side: 'BUY', type: 'MARKET', quantity: '10' } as const;
    expect(ticketSchema.safeParse(base).success).toBe(true);
    expect(ticketSchema.safeParse({ ...base, quantity: '1.5' }).success).toBe(false);
    expect(ticketSchema.safeParse({ ...base, quantity: '0' }).success).toBe(false);
    expect(ticketSchema.safeParse({ ...base, type: 'LIMIT' }).success).toBe(false);
    expect(ticketSchema.safeParse({ ...base, type: 'LIMIT', limitPrice: '-1' }).success).toBe(false);
    expect(ticketSchema.safeParse({ ...base, type: 'LIMIT', limitPrice: '270.55' }).success).toBe(true);
  });
});

describe('Order ticket', () => {
  it('shows validation errors and does not preview an invalid ticket', async () => {
    const user = userEvent.setup();
    const { orders } = setup();
    await waitFor(() => expect(screen.getByRole('combobox', { name: /portfolio/i })).toHaveTextContent(/·/));
    await user.click(screen.getByRole('button', { name: 'Preview order' }));
    expect(await screen.findByText('Enter a symbol')).toBeInTheDocument();
    expect(screen.getByText('Enter a quantity')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Symbol'), 'OGDC');
    await user.type(screen.getByLabelText('Quantity (shares)'), '2.5');
    await user.click(screen.getByRole('button', { name: 'Limit' }));
    await user.click(screen.getByRole('button', { name: 'Preview order' }));
    expect(await screen.findByText('Whole shares only')).toBeInTheDocument();
    expect(screen.getByText('A limit price is required')).toBeInTheDocument();
    expect(orders.preview).not.toHaveBeenCalled();
  });

  it('paper: preview (idempotency key, fees, risk checks) → approve with password step-up → simulated fill', async () => {
    const user = userEvent.setup();
    const filled = order({
      status: 'FILLED',
      filledQuantity: '10',
      avgFillPrice: '270.1350',
      executions: [
        {
          id: 'x',
          orderId: 'o1',
          symbol: 'OGDC',
          side: 'BUY',
          quantity: '10',
          price: '270.1350',
          executedAt: '2026-11-13T07:01:00.000Z',
          source: 'SIMULATED',
        },
      ],
      previewHash: null,
    });
    const { orders, auth } = setup({ approved: filled });
    await fillTicket(user);
    await user.click(screen.getByRole('button', { name: 'Preview order' }));

    const card = await screen.findByTestId('order-preview');
    const req = orders.preview.mock.calls[0] as unknown as [{ idempotencyKey: string; symbol: string }];
    expect(req[0]).toMatchObject({ symbol: 'OGDC', quantity: '10', type: 'MARKET', origin: 'MANUAL' });
    expect(req[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(within(card).getByTestId('execution-path')).toHaveTextContent('Paper auto-fill');
    expect(
      within(card).getByRole('list', { name: 'Risk checks' }).querySelectorAll('[data-passed="true"]'),
    ).toHaveLength(2);
    expect(
      within(card).getByRole('table', { name: 'Fee breakdown' }).querySelector('[data-source="ESTIMATED"]'),
    ).not.toBeNull();
    expect(within(card).getByRole('timer')).toHaveTextContent(/Approve within [45]:\d\d/);

    await user.click(screen.getByRole('button', { name: 'Approve order…' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Account password'), 'correct horse battery');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(orders.approve).toHaveBeenCalledWith(
        'o1',
        expect.objectContaining({ previewHash: 'a'.repeat(64), stepUpToken: 'su-token' }),
      ),
    );
    expect(auth.stepUp).toHaveBeenCalledWith({ password: 'correct horse battery' });
    const result = await screen.findByTestId('paper-result');
    expect(within(result).getByText(/Simulated fill/)).toBeInTheDocument();
    expect(result.querySelector('[data-source="SIMULATED"]')).not.toBeNull();
  });

  it('live: approval yields a manual ticket; "I placed it" and "Record fill" go to the API', async () => {
    const user = userEvent.setup();
    const preview = order({ portfolioId: 'pl', mode: 'LIVE', executionPath: 'MANUAL_TICKET' });
    const { orders } = setup({
      portfolio: live,
      preview,
      approved: { ...preview, status: 'AWAITING_MANUAL_PLACEMENT', previewHash: null },
    });
    await fillTicket(user);
    await user.click(screen.getByRole('button', { name: 'Preview order' }));
    expect(await screen.findByTestId('execution-path')).toHaveTextContent('Manual ticket');
    await user.click(screen.getByRole('button', { name: 'Approve order…' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Account password'), 'pw-pw-pw-pw');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    const ticket = await screen.findByTestId('manual-ticket');
    expect(within(ticket).getByText('Place this exact order in the KTrade app')).toBeInTheDocument();
    expect(within(ticket).getByTestId('no-fills')).toHaveTextContent('has not executed');
    await user.type(within(ticket).getByLabelText(/KTrade order reference/), 'KT-77');
    await user.click(within(ticket).getByRole('button', { name: 'I placed it' }));
    await waitFor(() =>
      expect(orders.markPlaced).toHaveBeenCalledWith('o1', { orderId: 'o1', brokerOrderRef: 'KT-77' }),
    );

    const form = await screen.findByRole('form', { name: 'Record fill' });
    await user.clear(within(form).getByLabelText('Fill price (Rs)'));
    await user.type(within(form).getByLabelText('Fill price (Rs)'), '270.50');
    fireEvent.change(within(form).getByLabelText(/Executed at/), { target: { value: '2026-11-13T12:05' } });
    await user.click(within(form).getByRole('button', { name: 'Record fill' }));
    await waitFor(() => expect(orders.recordFill).toHaveBeenCalled());
    const [, fill] = orders.recordFill.mock.calls[0] as unknown as [
      string,
      { quantity: string; price: string; executedAt: string },
    ];
    expect(fill).toMatchObject({ quantity: '10', price: '270.50' });
    expect(fill.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    expect(await screen.findByRole('table', { name: 'Fills' })).toBeInTheDocument();
  });

  it('live with the kill switch engaged: explains how to enable it and offers no approval', async () => {
    const user = userEvent.setup();
    const rejected = order({
      portfolioId: 'pl',
      mode: 'LIVE',
      executionPath: 'MANUAL_TICKET',
      status: 'REJECTED_BY_RISK',
      previewHash: null,
      rejectionReason: 'KILL_SWITCH',
      riskChecks: [
        { rule: 'KILL_SWITCH', passed: false, message: 'live trading is disabled by the kill switch' },
        ...passing,
      ],
    });
    setup({ portfolio: live, preview: rejected, liveTradingEnabled: false });
    // Shown up-front for a LIVE portfolio while live trading is off…
    expect(await screen.findByTestId('kill-switch-notice')).toBeInTheDocument();
    await fillTicket(user);
    await user.click(screen.getByRole('button', { name: 'Preview order' }));
    // …and on the rejected preview, with the only supported way to enable it.
    expect(await screen.findByTestId('risk-rejected')).toBeInTheDocument();
    const notice = screen.getByTestId('kill-switch-notice');
    expect(within(notice).getByRole('link', { name: /Settings → Kill switch/ })).toHaveAttribute(
      'href',
      '/settings#kill-switch',
    );
    expect(notice).toHaveTextContent(/step-up/);
    expect(notice).not.toHaveTextContent(/bypass|override/i);
    expect(document.querySelector('[data-rule="KILL_SWITCH"][data-passed="false"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve order…' })).not.toBeInTheDocument();
  });
});
