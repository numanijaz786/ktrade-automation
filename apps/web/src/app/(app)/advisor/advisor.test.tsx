import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiClientProvider } from '@/lib/api/client';
import { HttpApiClient } from '@/lib/api/http-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BuyCard } from '@/components/advisor/buy-card';
import { HoldingList } from '@/components/advisor/holding-list';
import { RiskPerTradeForm } from '@/components/advisor/risk-panel';
import { ScannerResults } from '@/components/advisor/scanner-view';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  mapDailyReport,
  mapEvaluation,
  mapHoldingAdvice,
  mapScannerReport,
} from '@/lib/api/http/mappers-advisor';
import type { Portfolio } from '@/lib/api/types';
import { baseReport, fixtureBuy } from '@/test/advisor-fixtures';
import { mockClient, renderWithClient } from '@/test/render';
import AdvisorPage from './page';

const pf: Portfolio = {
  id: 'p1',
  name: 'Main',
  kind: 'LIVE',
  costBasisMethod: 'WEIGHTED_AVERAGE',
  demo: false,
};
const me = { id: 'u1', email: 'a@b.c', displayName: 'A', role: 'OWNER' };

function setup(report: unknown) {
  const client = mockClient({
    auth: { me: () => Promise.resolve(me) } as never,
    portfolios: { list: () => Promise.resolve([pf]) } as never,
    advisor: { dailyReport: () => Promise.resolve(mapDailyReport(report)) } as never,
    system: { killSwitch: () => Promise.resolve({ liveTradingEnabled: false }) } as never,
  });
  return renderWithClient(<AdvisorPage />, client, { portfolios: true });
}

describe('daily report', () => {
  it('(a) not enough data: headline, quality banner, reasons first "simulated", and NO level anywhere', async () => {
    // Even if a (buggy) payload carried buys, none may be rendered while notEnoughData is set.
    setup({ ...baseReport, topBuys: [fixtureBuy], opportunities: [fixtureBuy] });
    expect(await screen.findByTestId('advisor-headline')).toHaveTextContent(
      'Not enough verified data to recommend anything',
    );
    expect(screen.getByTestId('data-quality')).toHaveTextContent('Simulated: 3');
    const why = screen.getByTestId('not-enough-data');
    expect(within(why).getByText(/simulated data — not for investment decisions/)).toBeInTheDocument();
    expect(within(why).getByRole('link', { name: 'Data providers' })).toHaveAttribute('href', '/data-health');
    expect(screen.queryByTestId('buy-card')).toBeNull();
    expect(screen.getByTestId('buys-withheld')).toBeInTheDocument();
    const text = screen.getByTestId('daily-report').textContent ?? '';
    expect(text).not.toMatch(/Stop-loss|Target 1|Buy between|Confidence|Prepare order preview/);
    expect(text).not.toContain('TESTCO');
    expect(screen.getByTestId('disclaimer')).toBeInTheDocument();
  });

  it('(c) no strong opportunity: says so, valid empty state, banner still visible', async () => {
    setup({
      ...baseReport,
      headline: 'No strong buying opportunity today',
      notEnoughData: null,
      dataQuality: { ...baseReport.dataQuality, sources: { PROVIDER: 5 }, simulatedShare: '0.00' },
    });
    expect(await screen.findByTestId('advisor-headline')).toHaveTextContent(
      'No strong buying opportunity today',
    );
    expect(screen.getByTestId('data-quality')).toBeInTheDocument();
    expect(screen.getByText('Nothing to buy today')).toBeInTheDocument();
    expect(screen.queryByTestId('not-enough-data')).toBeNull();
    expect(screen.queryByTestId('buy-card')).toBeNull();
  });

  it('(b) synthetic API response (TEST FIXTURE): a full buy card with plan, sources and the preview link', async () => {
    setup({
      ...baseReport,
      headline: '1 buy candidate today; the best ranked is TESTCO',
      notEnoughData: null,
      topBuys: [fixtureBuy],
      opportunities: [fixtureBuy],
    });
    const card = await screen.findByTestId('buy-card');
    expect(within(card).getByText('TESTCO')).toBeInTheDocument();
    expect(within(card).getByText('98.00 – 101.00')).toBeInTheDocument();
    expect(within(card).getByText(/94\.00/)).toBeInTheDocument();
    expect(within(card).getByText('Target 1')).toBeInTheDocument();
    expect(within(card).getByText('Target 2')).toBeInTheDocument();
    expect(within(card).getByText(/2-4 weeks/)).toBeInTheDocument();
    expect(within(card).getByText(/73 \/ 100/)).toBeInTheDocument(); // 72.5 rounds half up for display
    expect(within(card).getByText(/Technical reasons/)).toBeInTheDocument();
    expect(within(card).getByText(/Fundamental reasons/)).toBeInTheDocument();
    expect(within(card).getByText('Close below 94')).toBeInTheDocument();
    expect(within(card).getByText('Thin volume')).toBeInTheDocument();
    expect(within(card).getByText(/Do not chase the price/)).toBeInTheDocument();
    const link = within(card).getByRole('link', { name: /Prepare order preview/ });
    expect(link).toHaveAttribute('href', '/trade?symbol=TESTCO&side=BUY&qty=200&type=LIMIT&limit=101');
    expect(await within(card).findByTestId('live-disabled')).toBeInTheDocument();
  });
});

describe('buy card labels', () => {
  const card = (over: Record<string, unknown>) => {
    render(
      <TooltipProvider>
        <QueryClientProvider client={new QueryClient()}>
          <ApiClientProvider
            client={new HttpApiClient({ fetch: (() => Promise.reject(new Error('x'))) as never })}
          >
            <BuyCard ev={mapEvaluation({ ...fixtureBuy, ...over })} />
          </ApiClientProvider>
        </QueryClientProvider>
      </TooltipProvider>,
    );
  };
  it('shows source, as-of time and a Delayed label for a verified provider bar', () => {
    card({});
    expect(screen.getByTestId('price-label')).toHaveTextContent('Delayed (daily close)');
    expect(screen.getByText(/Source: Market data/)).toBeInTheDocument();
  });
  it('labels a simulated price as Simulated, never live', () => {
    card({ price: { ...fixtureBuy.price, source: 'SIMULATED', verified: false } });
    expect(screen.getByTestId('price-label')).toHaveTextContent('Simulated');
    expect(screen.queryByText(/Live/)).toBeNull();
  });
  it('labels a stale provider price as stale, and tells you to wait when above the entry range', () => {
    card({ price: { ...fixtureBuy.price, value: '120', verified: false } });
    expect(screen.getByTestId('price-label')).toHaveTextContent(/stale/i);
    expect(screen.getByTestId('when-to-buy')).toHaveAttribute('data-timing', 'wait');
  });
  it('shows "unavailable" and no levels when the API returned no plan or confidence', () => {
    card({ plan: null, confidence: null, price: null });
    expect(screen.getByTestId('no-plan')).toBeInTheDocument();
    expect(screen.queryByText(/Stop-loss/)).toBeNull();
    expect(screen.getAllByTestId('unavailable').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Prepare order preview' })).toBeDisabled();
  });
  it('expands the confidence components', async () => {
    card({});
    await userEvent.click(screen.getByText('How the confidence number is made'));
    expect(screen.getByText(/7 of 10 rules agree/)).toBeVisible();
  });
});

describe('sell advice', () => {
  const holding = (over: Record<string, unknown>) =>
    mapHoldingAdvice({
      symbol: 'OGDC',
      name: 'Oil & Gas',
      quantity: '100',
      avgCost: '120',
      price: {
        value: '100',
        source: 'PROVIDER',
        asOfBar: '2026-11-19',
        barTs: '2026-11-19T10:00:00.000Z',
        verified: true,
      },
      marketValue: '10000',
      pnl: {
        lastPrice: '100',
        costBasis: '12000',
        marketValue: '10000',
        unrealizedGross: '-2000',
        estimatedSellFees: '60',
        unrealizedNet: '-2060',
        unrealizedNetPct: '-17.17',
        dividendsReceived: '300',
        priceSource: 'PROVIDER',
      },
      status: 'ACTIONABLE',
      advice: 'CONTINUE_HOLDING',
      headline: 'Continue holding OGDC',
      reasons: ['Trend intact'],
      invalidations: ['Close below 90'],
      stop: { price: '90', origin: 'SUPPLIED' },
      targets: [{ n: 1, price: '130' }],
      sellRange: { low: '130', high: '130', basis: 'plan' },
      ...over,
    });

  it('shows the temporary-decline text when advice is HOLD during a drawdown, with fees-aware P&L', () => {
    render(<HoldingList holdings={[holding({})]} mode="portfolio" />);
    const card = screen.getByTestId('holding-card');
    expect(within(card).getByTestId('decline-note')).toHaveTextContent(
      /Never sell just because of a temporary decline/,
    );
    const pnl = within(card).getByTestId('pnl');
    expect(pnl).toHaveTextContent('Estimated selling fees');
    expect(pnl).toHaveTextContent('Rs 60.00');
    expect(within(card).getByText('Continue holding')).toBeInTheDocument();
    expect(within(card).getByText('Close below 90')).toBeInTheDocument();
  });

  it('does not show the decline note for an EXIT, and lists exits first', () => {
    render(
      <HoldingList
        holdings={[holding({}), holding({ symbol: 'PPL', advice: 'EXIT', headline: 'Exit PPL: stop hit' })]}
        mode="sell"
      />,
    );
    const cards = screen.getAllByTestId('holding-card');
    expect(cards[0]).toHaveAttribute('data-symbol', 'PPL');
    expect(within(cards[0]!).queryByTestId('decline-note')).toBeNull();
    expect(within(cards[1]!).getByTestId('decline-note')).toBeInTheDocument();
    expect(screen.getByTestId('decline-banner')).toBeInTheDocument();
  });

  it('simulated-price holdings: facts only, "unavailable" for net figures, flagged for testing only', () => {
    render(
      <HoldingList
        holdings={[
          holding({
            advice: null,
            status: 'NOT_ACTIONABLE',
            price: { value: '100', source: 'SIMULATED', asOfBar: '', barTs: '', verified: false },
            pnl: {
              lastPrice: '100',
              costBasis: '12000',
              marketValue: '10000',
              unrealizedGross: '-2000',
              priceSource: 'SIMULATED',
            },
            stop: null,
            sellRange: null,
            targets: [],
          }),
        ]}
        mode="sell"
      />,
    );
    const card = screen.getByTestId('holding-card');
    expect(within(card).getByTestId('price-label')).toHaveTextContent('Simulated');
    expect(within(card).getByText(/for testing only/)).toBeInTheDocument();
    expect(within(card).queryByTestId('exit-plan')).toBeNull();
    expect(within(card).queryByTestId('decline-note')).toBeNull();
  });
});

describe('scanner', () => {
  it('shows the plain empty state — "that is a valid result"', () => {
    render(
      <ScannerResults
        report={mapScannerReport({
          horizon: 'SWING',
          filter: 'breakout',
          results: [],
          note: 'No stock matches this filter on verified data.',
        })}
      />,
    );
    expect(screen.getByText(/No stock meets this filter today/)).toBeInTheDocument();
    expect(screen.getByText(/valid result/)).toBeInTheDocument();
  });
  it('shows matched metric, value and threshold plainly', () => {
    render(
      <TooltipProvider>
        <ScannerResults
          report={mapScannerReport({
            horizon: 'VALUE',
            filter: 'undervalued',
            verifiedEvaluations: 4,
            results: [
              {
                rank: 1,
                symbol: 'TESTCO',
                action: 'BUY',
                matched: { metric: 'P/E', value: '8.00', threshold: '<= 12' },
                price: null,
                confidence: null,
              },
            ],
          })}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('matched')).toHaveTextContent('P/E: 8.00 (needed <= 12)');
  });
});

describe('risk per trade form', () => {
  const setupForm = (
    onPut = vi.fn((v: string) => Promise.resolve({ riskPerTradePct: v, isDefault: false })),
  ) => {
    const client = mockClient({ advisor: { updateSettings: onPut } as never });
    renderWithClient(<RiskPerTradeForm current="1" isOwner />, client);
    return onPut;
  };
  it.each(['0', '5.5', 'abc'])('rejects %s without calling the API', async (v) => {
    const put = setupForm();
    const input = screen.getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, v);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
  });
  it('saves a valid value (0 < r <= 5)', async () => {
    const put = setupForm();
    const input = screen.getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, '2.5');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('2.5'));
  });
  it('is read-only for a non-owner', () => {
    renderWithClient(<RiskPerTradeForm current="1" isOwner={false} />, mockClient({}));
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
