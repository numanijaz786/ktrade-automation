import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { MarketProvider, ProviderRow, Quote, ResearchProviderStatus } from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import { researchProviderRow } from '@/lib/api/http/mappers-research';
import DataHealthPage from './page';
import { FreshnessSummary, ProviderList, summarizeQuotes } from './providers';

const wrap = (rows: ProviderRow[]) =>
  render(
    <TooltipProvider>
      <ProviderList rows={rows} />
    </TooltipProvider>,
  );

const sbp: ResearchProviderStatus = {
  providerKey: 'sbp',
  displayName: 'SBP EasyData',
  dataType: 'MACRO',
  enabled: false,
  source: 'PROVIDER',
  status: 'NOT_CONFIGURED',
  lastAttemptAt: 'a',
  lastSuccessAt: null,
  freshnessMinutes: null,
  message: 'Disabled until a key exists',
  freshness: [],
  delayMinutes: 0,
  licenseNote: 'Official SBP data; free account key needed.',
  commercialUseAllowed: false,
  missing: ['Free SBP EasyData account (USER_ACTION_REQUIRED #8)', 'API key issued to that account'],
};
const manual: ResearchProviderStatus = {
  ...sbp,
  providerKey: 'm',
  displayName: 'Owner-entered macro',
  enabled: true,
  status: 'OK',
  source: 'USER_REPORTED',
  lastSuccessAt: '2026-11-19T07:00:00.000Z',
  freshnessMinutes: 300,
  freshness: ['historical'],
  missing: [],
};

describe('provider status rendering', () => {
  it('NOT_CONFIGURED shows exactly what is missing, with no invented links', () => {
    wrap([researchProviderRow(sbp)]);
    const card = screen.getByTestId('provider-card');
    expect(card).toHaveAttribute('data-status', 'NOT_CONFIGURED');
    expect(within(card).getByText('Not configured')).toBeInTheDocument();
    const missing = within(card).getByTestId('missing');
    expect(missing).toHaveTextContent('Free SBP EasyData account (USER_ACTION_REQUIRED #8)');
    expect(missing).toHaveTextContent('API key issued to that account');
    expect(missing).toHaveTextContent(/USER_ACTION_REQUIRED in the project files/);
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();
    expect(card).toHaveTextContent('Official SBP data; free account key needed.');
  });

  it('OK shows last success, freshness and timeliness, and no missing list', () => {
    wrap([researchProviderRow(manual)]);
    const card = screen.getByTestId('provider-card');
    expect(within(card).getByText('OK')).toBeInTheDocument();
    expect(card).toHaveTextContent('5 h old');
    expect(card).toHaveTextContent('Historical only');
    expect(within(card).queryByTestId('missing')).not.toBeInTheDocument();
  });

  it('DEGRADED is labelled', () => {
    wrap([{ ...researchProviderRow(manual), status: 'DEGRADED' }]);
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });
});

const q = (source: Quote['source'], stale = false): Quote =>
  ({ symbol: 'X', source, stale }) as unknown as Quote;

describe('price freshness', () => {
  it('counts the source mix and stale prices', () => {
    const f = summarizeQuotes([q('SIMULATED'), q('USER_REPORTED', true), q('PROVIDER', true)]);
    expect(f).toMatchObject({ total: 3, stale: 2, allSimulated: false });
    render(
      <TooltipProvider>
        <FreshnessSummary f={f} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('stale-count')).toHaveTextContent('2 prices are stale');
  });
});

const market = (source: MarketProvider['source']): MarketProvider => ({
  key: 'sim',
  displayName: 'Simulated provider',
  source,
  enabled: true,
  active: true,
  disabledReason: null,
  capabilities: {
    quotes: true,
    intradayBars: true,
    eodBars: true,
    corporateActions: false,
    streaming: true,
    delayMinutes: 0,
  },
  health: { ok: true, checkedAt: 'c' },
});

describe('DataHealthPage', () => {
  it('shows the simulated banner when every price is simulated', async () => {
    const client = mockClient({
      market: {
        providers: async () => [market('SIMULATED')],
        quotes: async () => [q('SIMULATED'), q('SIMULATED')],
      },
      research: { providers: async () => [sbp] },
    });
    renderWithClient(<DataHealthPage />, client);
    expect(await screen.findByTestId('all-simulated')).toHaveTextContent(
      'All prices are simulated — recommendations are disabled',
    );
    expect(await screen.findByText('SBP EasyData')).toBeInTheDocument();
  });

  it('hides the banner when real prices exist', async () => {
    const client = mockClient({
      market: {
        providers: async () => [market('PROVIDER')],
        quotes: async () => [q('USER_REPORTED'), q('SIMULATED')],
      },
      research: { providers: async () => [manual] },
    });
    renderWithClient(<DataHealthPage />, client);
    expect(await screen.findByTestId('freshness-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('all-simulated')).not.toBeInTheDocument();
  });
});
