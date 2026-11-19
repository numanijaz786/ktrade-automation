import { describe, expect, it } from 'vitest';
import { RECOMMENDATION_HORIZONS } from '@ktrade/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  Recommendation,
  RecommendationDetail,
  RecommendationOutcome,
  RecommendationPerformance,
} from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import RecommendationsPage from './page';

const outcome = (
  status: RecommendationOutcome['status'],
  over: Partial<RecommendationOutcome> = {},
): RecommendationOutcome => ({
  id: `o-${status}`,
  evaluatedAt: '2026-11-10T00:00:00.000Z',
  lastBarDate: '2026-11-10',
  status,
  maxFavourablePct: null,
  maxAdversePct: null,
  target1HitAt: null,
  target2HitAt: null,
  target3HitAt: null,
  stopHitAt: null,
  closedAt: null,
  exitPrice: null,
  returnPct: null,
  holdingDays: 3,
  benchmarkReturnPct: null,
  ...over,
});

const rec = (id: string, symbol: string, over: Partial<Recommendation> = {}): Recommendation => ({
  id,
  symbol,
  horizon: 'SHORT_TERM',
  action: 'BUY',
  status: 'ACTIONABLE',
  generatedAt: '2026-11-05T05:00:00.000Z',
  asOfBar: '2026-11-04',
  price: '100.00',
  priceSource: 'PROVIDER',
  simulated: false,
  entryLow: '99',
  entryHigh: '101',
  stop: '95',
  target1: '110',
  target2: null,
  target3: null,
  riskReward: '2.0000',
  holdingPeriod: '2-4 weeks',
  holdingDaysMax: 30,
  confidence: '70.00',
  confidenceLevel: 'MEDIUM',
  reasons: ['Trend above SMA50'],
  invalidations: ['Close below stop'],
  dataQuality: {
    latestBarSource: 'PROVIDER',
    latestBarTs: null,
    barsUsed: 120,
    missingInputs: [],
    warnings: [],
  },
  engineVersion: 'v1',
  latestOutcome: null,
  ...over,
});

const stopped = rec('r2', 'HBL', {
  latestOutcome: outcome('STOPPED', {
    returnPct: '-5.0000',
    stopHitAt: '2026-11-10',
    closedAt: '2026-11-10',
  }),
});
const hit = rec('r1', 'OGDC', {
  latestOutcome: outcome('TARGET_HIT', { returnPct: '10.0000', target1HitAt: '2026-11-09' }),
});
const open = rec('r3', 'PPL', { latestOutcome: outcome('OPEN') });
const expired = rec('r4', 'LUCK', { latestOutcome: outcome('EXPIRED', { returnPct: '0.5000' }) });
const sim = rec('r5', 'MCB', {
  status: 'NOT_ACTIONABLE',
  action: 'HOLD',
  simulated: true,
  priceSource: 'SIMULATED',
  price: null,
  reasons: ['simulated data — not for investment decisions'],
});

const stats = (over = {}) => ({
  recommendations: 4,
  evaluated: 3,
  open: 1,
  closed: 2,
  winRatePct: '50.00',
  avgReturnPct: '2.5000',
  targetHitRatePct: '33.33',
  stopFrequencyPct: '50.00',
  avgHoldingDays: '6.50',
  avgBenchmarkReturnPct: null,
  benchmarkSamples: 0,
  ...over,
});
const perf = (over: Partial<RecommendationPerformance> = {}): RecommendationPerformance => ({
  ...stats(),
  scope: { onlyActionable: true, includesSimulated: false },
  perHorizon: Object.fromEntries(
    RECOMMENDATION_HORIZONS.map((h) => [
      h,
      h === 'SHORT_TERM' ? stats() : stats({ recommendations: 0, closed: 0, winRatePct: null }),
    ]),
  ) as RecommendationPerformance['perHorizon'],
  benchmark: null,
  benchmarkNote: 'No KSE-100 series covers these recommendations.',
  note: 'Past outcomes are not a prediction.',
  ...over,
});

const detail = (r: Recommendation, outcomes: RecommendationOutcome[]): RecommendationDetail => ({
  ...r,
  outcomes,
});

describe('RecommendationsPage', () => {
  const calls: Array<boolean | undefined> = [];
  const client = () =>
    mockClient({
      auth: {
        me: async () => ({ id: 'u', email: 'e', displayName: 'd', role: 'OWNER', totpEnabled: false }),
      },
      recommendations: {
        list: async () => ({ total: 5, data: [hit, stopped, open, expired, sim] }),
        performance: async (q) => {
          calls.push(q?.includeSimulated);
          return perf();
        },
        get: async (id) =>
          id === 'r2'
            ? detail(stopped, [
                outcome('OPEN'),
                outcome('STOPPED', { stopHitAt: '2026-11-10', returnPct: '-5.0000' }),
              ])
            : detail(rec(id, 'X'), []),
        evaluateOutcomes: async () => ({
          considered: 1,
          appended: 1,
          closed: 0,
          noNewData: 0,
          evaluatedAt: 'e',
        }),
      },
    });

  it('lists every outcome kind including failed ones, never hiding them', async () => {
    renderWithClient(<RecommendationsPage />, client());
    const rows = await screen.findAllByTestId('rec-row');
    expect(rows).toHaveLength(5);
    const text = rows.map((r) => r.textContent).join(' | ');
    expect(text).toContain('Stopped out');
    expect(text).toContain('Target hit');
    expect(text).toContain('Open');
    expect(text).toContain('Expired');
    expect(text).toContain('Not tracked');
    expect(text).toContain('Simulated prices: test only');
    expect(rows[1]).toHaveAttribute('data-outcome', 'STOPPED');
  });

  it('shows performance, the "not available" KSE-100 comparison and the simulated note', async () => {
    renderWithClient(<RecommendationsPage />, client());
    const panel = await screen.findByTestId('performance');
    expect(panel).toHaveTextContent('Win rate');
    expect(panel).toHaveTextContent('50.00%');
    expect(panel).toHaveTextContent('Not available');
    expect(panel).toHaveTextContent('left out by default');
    expect(within(panel).getAllByTestId('horizon-row')).toHaveLength(RECOMMENDATION_HORIZONS.length);
  });

  it('the include-simulated toggle re-queries with includeSimulated=true', async () => {
    renderWithClient(<RecommendationsPage />, client());
    await screen.findByTestId('performance');
    await userEvent.click(screen.getByLabelText(/include simulated-price/i));
    await waitFor(() => expect(calls).toContain(true));
    expect(await screen.findByTestId('performance')).toHaveTextContent(
      /included\. They are for testing only/,
    );
  });

  it('opens the drawer with levels, reasons, invalidations, data quality and the outcome timeline', async () => {
    renderWithClient(<RecommendationsPage />, client());
    await userEvent.click(await screen.findByRole('button', { name: /open HBL/i }));
    const d = await screen.findByTestId('rec-detail');
    expect(d).toHaveTextContent('Stop-loss');
    expect(d).toHaveTextContent('Trend above SMA50');
    expect(d).toHaveTextContent('Close below stop');
    expect(d).toHaveTextContent('Latest price source: Provider');
    expect(within(d).getAllByTestId('outcome-step')).toHaveLength(2);
    expect(d).toHaveTextContent('Stopped');
  });

  it('owner can evaluate outcomes', async () => {
    renderWithClient(<RecommendationsPage />, client());
    expect(await screen.findByRole('button', { name: /evaluate outcomes/i })).toBeEnabled();
  });
});
