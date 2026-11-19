import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CsvImport, parseRowError } from '@/components/csv-import';
import { ApiError } from '@/lib/api/errors';
import { validateAnnouncementForm, EMPTY_ANNOUNCEMENT } from '@/lib/api/research-rules';
import type { NewsFeed, NewsItem } from '@/lib/api/types';
import { feedFreshness, NewsFeedView } from './news-feed';
import { summarizeAnnouncementsImport } from './page';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const item = (over: Partial<NewsItem> = {}): NewsItem => ({
  id: 'n1',
  symbol: 'OGDC',
  symbols: ['OGDC'],
  title: 'Board meeting on results',
  summary: 'Results expected.',
  url: 'https://example.com/notice',
  category: 'BOARD_MEETING',
  source: 'USER_REPORTED',
  sourceName: 'Owner-entered',
  publishedAt: '2026-11-19T06:00:00.000Z',
  retrievedAt: '2026-11-19T07:00:00.000Z',
  sentiment: null,
  sentimentSource: 'NONE',
  relevance: null,
  affectsHoldings: true,
  affectedSymbols: ['OGDC'],
  ...over,
});
const feed = (over: Partial<NewsFeed> = {}): NewsFeed => ({
  generatedAt: '2026-11-19T12:00:00.000Z',
  windowHours: 72,
  lastUpdated: '2026-11-19T07:00:00.000Z',
  coverage: 'sources: owner-entered only',
  count: 1,
  items: [item()],
  note: null,
  ...over,
});
const view = (f: NewsFeed, isOwner = true) =>
  render(
    <TooltipProvider>
      <NewsFeedView
        feed={f}
        now={NOW}
        windowHours={72}
        onWindowChange={() => {}}
        category="all"
        onCategoryChange={() => {}}
        isOwner={isOwner}
      />
    </TooltipProvider>,
  );

describe('feedFreshness', () => {
  it('is stale after 24 hours or when nothing was ever added', () => {
    expect(feedFreshness(null, NOW)).toEqual({ ageHours: null, stale: true });
    expect(feedFreshness('2026-11-19T07:00:00Z', NOW).stale).toBe(false);
    expect(feedFreshness('2026-11-17T07:00:00Z', NOW).stale).toBe(true);
  });
});

describe('NewsFeedView', () => {
  it('shows last updated, the coverage note, source, link, why-flag and "not assessed"', () => {
    view(feed());
    expect(screen.getByTestId('last-updated')).toHaveAttribute('data-stale', 'false');
    expect(screen.getByTestId('last-updated')).toHaveTextContent('Last updated');
    expect(screen.getByTestId('coverage-note')).toHaveTextContent('sources: owner-entered only');
    const card = screen.getByTestId('news-item');
    expect(within(card).getByText('Owner-entered')).toBeInTheDocument();
    expect(within(card).getByText('Sentiment: not assessed')).toBeInTheDocument();
    expect(within(card).getByText('Affects your holdings')).toBeInTheDocument();
    expect(screen.getByTestId('affects-why')).toHaveTextContent('OGDC');
    expect(within(card).getByRole('link', { name: /original source/i })).toHaveAttribute(
      'href',
      'https://example.com/notice',
    );
  });

  it('shows a sentiment badge only when one exists, and no link for unsafe urls', () => {
    view(
      feed({
        items: [
          item({
            sentiment: 'NEGATIVE',
            sentimentSource: 'MANUAL',
            url: 'javascript:alert(1)',
            affectsHoldings: false,
            affectedSymbols: [],
          }),
        ],
      }),
    );
    expect(screen.getByText(/Negative/)).toBeInTheDocument();
    expect(screen.queryByText(/not assessed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /original source/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Affects your holdings')).not.toBeInTheDocument();
  });

  it('warns when the feed is stale', () => {
    view(feed({ lastUpdated: '2026-11-15T07:00:00.000Z' }));
    expect(screen.getByTestId('last-updated')).toHaveAttribute('data-stale', 'true');
    expect(screen.getByTestId('last-updated')).toHaveTextContent(/stale/i);
  });

  it('empty state explains how to add announcements', () => {
    view(feed({ lastUpdated: null, count: 0, items: [] }));
    expect(screen.getByTestId('last-updated')).toHaveTextContent('Never');
    expect(screen.getByText('No announcements in this window')).toBeInTheDocument();
    expect(screen.getByText(/Add announcement/)).toBeInTheDocument();
    expect(screen.getByTestId('coverage-note')).toBeInTheDocument();
  });
});

describe('announcement form rules', () => {
  const ok = { ...EMPTY_ANNOUNCEMENT, title: 'Results out', date: '2026-11-10' };
  it('builds the input and rejects future times', () => {
    const r = validateAnnouncementForm({ ...ok, time: '14:30', symbols: 'ogdc, ppl' }, NOW);
    expect(r).toMatchObject({
      ok: true,
      input: { publishedAt: '2026-11-10T14:30:00+05:00', symbols: ['OGDC', 'PPL'] },
    });
    const bad = validateAnnouncementForm({ ...ok, date: '2026-11-25' }, NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.date).toMatch(/future/);
  });
});

describe('CSV import', () => {
  it('parses row paths', () => {
    expect(parseRowError({ path: 'rows.4.title', message: 'm' })).toEqual({
      line: 4,
      field: 'title',
      message: 'm',
    });
    expect(parseRowError({ path: 'rows.1', message: 'm' })).toEqual({ line: 1, field: null, message: 'm' });
  });

  it('lists row-level errors and says nothing was imported', async () => {
    const mutateAsync = vi.fn().mockRejectedValue(
      new ApiError('VALIDATION_FAILED', 422, 'Validation failed', undefined, {
        errors: [
          { path: 'rows.3.title', message: 'must be at least 3 characters' },
          { path: 'rows.5.publishedAt', message: 'must not be in the future' },
        ],
      }),
    );
    render(
      <CsvImport
        title="t"
        columns="cols"
        example="a,b"
        mutation={{ mutateAsync, isPending: false }}
        summarize={() => 'x'}
      />,
    );
    await userEvent.type(screen.getByLabelText(/paste the csv/i), 'publishedAt,title');
    await userEvent.click(screen.getByRole('button', { name: /import csv/i }));
    const err = await screen.findByTestId('csv-error');
    expect(err).toHaveTextContent('Nothing was imported: 2 problems found');
    expect(err).toHaveTextContent('Line 3 · title: must be at least 3 characters');
    expect(err).toHaveTextContent('Line 5 · publishedAt: must not be in the future');
    expect(screen.queryByTestId('csv-result')).not.toBeInTheDocument();
  });

  it('shows added and skipped (duplicate) counts plainly', async () => {
    const mutateAsync = vi
      .fn()
      .mockResolvedValue({ rows: 5, inserted: 3, skipped: 2, source: 'USER_REPORTED' });
    render(
      <CsvImport
        title="t"
        columns="cols"
        example="a,b"
        mutation={{ mutateAsync, isPending: false }}
        summarize={summarizeAnnouncementsImport}
      />,
    );
    await userEvent.type(screen.getByLabelText(/paste the csv/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: /import csv/i }));
    const res = await screen.findByTestId('csv-result');
    expect(res).toHaveTextContent('3 added');
    expect(res).toHaveTextContent('2 skipped');
  });
});
