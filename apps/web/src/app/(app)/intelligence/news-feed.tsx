'use client';

import { AlertTriangle, BriefcaseBusiness, Clock, ExternalLink, Info } from 'lucide-react';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { EmptyState } from '@/components/states';
import { NativeSelect } from '@/components/native-select';
import { StatusPill } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import type { NewsFeed, NewsItem } from '@/lib/api/types';
import { formatDateTime, humanize } from '@/lib/format';

export const WINDOWS = [
  { hours: 24, label: 'Last 24 hours' },
  { hours: 72, label: 'Last 72 hours' },
  { hours: 168, label: 'Last 7 days' },
] as const;

export const CATEGORIES = [
  'FINANCIAL_RESULT',
  'DIVIDEND',
  'BOOK_CLOSURE',
  'BOARD_MEETING',
  'CORPORATE_ACTION',
  'MATERIAL',
  'MACRO',
  'SECTOR',
  'OTHER',
] as const;

/** Nothing added for this long = the feed may be missing news. */
export const STALE_AFTER_HOURS = 24;

export interface FeedFreshness {
  /** null = nothing has ever been added (or the clock is not known yet). */
  ageHours: number | null;
  stale: boolean;
}

export function feedFreshness(lastUpdated: string | null, now: number | null): FeedFreshness {
  if (!lastUpdated) return { ageHours: null, stale: true };
  const t = Date.parse(lastUpdated);
  if (Number.isNaN(t) || now === null) return { ageHours: null, stale: false };
  const ageHours = Math.max(0, (now - t) / 3_600_000);
  return { ageHours, stale: ageHours > STALE_AFTER_HOURS };
}

export function formatAge(hours: number): string {
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) return `${Math.floor(hours)} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** Only real web links are made clickable. */
export const isWebUrl = (u: string | null): u is string => !!u && /^https?:\/\/\S+$/i.test(u);

export function SentimentBadge({ item }: { item: Pick<NewsItem, 'sentiment' | 'sentimentSource'> }) {
  if (!item.sentiment)
    return (
      <StatusPill tone="neutral" className="font-normal">
        Sentiment: not assessed
      </StatusPill>
    );
  const tone = item.sentiment === 'POSITIVE' ? 'good' : item.sentiment === 'NEGATIVE' ? 'bad' : 'neutral';
  const by = item.sentimentSource === 'MANUAL' ? 'entered by you' : 'rules-based';
  return (
    <StatusPill tone={tone}>
      {humanize(item.sentiment)} <span className="font-normal">({by})</span>
    </StatusPill>
  );
}

function FeedItem({ item }: { item: NewsItem }) {
  return (
    <Card className="gap-2 px-4 py-3" data-testid="news-item">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <time dateTime={item.publishedAt}>{formatDateTime(item.publishedAt)}</time>
        <span>{item.sourceName}</span>
        <ProvenanceBadge source={item.source} asOf={item.retrievedAt} note="Added by hand, not fetched." />
        <span>{humanize(item.category)}</span>
      </div>
      <h3 className="font-medium">{item.title}</h3>
      {item.summary && <p className="text-sm text-muted-foreground">{item.summary}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {item.symbols.map((s) => (
          <span key={s} className="rounded-md border px-1.5 py-0.5 text-xs font-medium">
            {s}
          </span>
        ))}
        <SentimentBadge item={item} />
        {item.affectsHoldings && (
          <StatusPill tone="warn" icon={BriefcaseBusiness}>
            Affects your holdings
          </StatusPill>
        )}
      </div>
      {item.affectsHoldings && (
        <p className="text-xs text-muted-foreground" data-testid="affects-why">
          Why: this mentions {item.affectedSymbols.join(', ')}, which you hold.
        </p>
      )}
      {isWebUrl(item.url) ? (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 text-sm underline"
        >
          Original source <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      ) : (
        <p className="text-xs text-muted-foreground">No link was recorded for this item.</p>
      )}
    </Card>
  );
}

export function NewsFeedView({
  feed,
  now,
  windowHours,
  onWindowChange,
  category,
  onCategoryChange,
  isOwner,
}: {
  feed: NewsFeed;
  now: number | null;
  windowHours: number;
  onWindowChange: (hours: number) => void;
  category: string;
  onCategoryChange: (c: string) => void;
  isOwner: boolean;
}) {
  const fresh = feedFreshness(feed.lastUpdated, now);
  const items = category === 'all' ? feed.items : feed.items.filter((i) => i.category === category);
  return (
    <div className="space-y-4">
      <div
        className={
          fresh.stale
            ? 'rounded-lg border border-amber-600/40 bg-amber-500/10 p-4'
            : 'rounded-lg border bg-card p-4'
        }
        data-testid="last-updated"
        data-stale={fresh.stale}
      >
        <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Clock className="size-4" aria-hidden="true" /> Last updated
        </p>
        <p className="text-xl font-semibold">
          {feed.lastUpdated ? formatDateTime(feed.lastUpdated) : 'Never'}
          {fresh.ageHours !== null && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({formatAge(fresh.ageHours)})
            </span>
          )}
        </p>
        {fresh.stale && (
          <p className="mt-1 flex items-start gap-1.5 text-sm text-amber-900 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {feed.lastUpdated
              ? `Stale: nothing has been added for more than ${STALE_AFTER_HOURS} hours, so important news may be missing.`
              : 'Nothing has ever been added, so there is no news to show.'}
          </p>
        )}
      </div>

      <Alert data-testid="coverage-note">
        <Info aria-hidden="true" />
        <AlertTitle>Coverage: {feed.coverage}</AlertTitle>
        <AlertDescription>
          This page does not fetch news. It shows only what you added by hand or imported, so it can be
          incomplete. Always check the company announcement for anything that affects a decision.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44 space-y-1">
          <Label htmlFor="news-window">Time window</Label>
          <NativeSelect
            id="news-window"
            value={windowHours}
            onChange={(e) => onWindowChange(Number(e.target.value))}
          >
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {w.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="w-52 space-y-1">
          <Label htmlFor="news-category">Category</Label>
          <NativeSelect
            id="news-category"
            value={category}
            onChange={(e) => onCategoryChange(e.target.value)}
          >
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <p className="pb-1.5 text-sm text-muted-foreground">
          {items.length} {items.length === 1 ? 'item' : 'items'} in the last {feed.windowHours} hours
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={feed.count === 0 ? 'No announcements in this window' : 'No items in this category'}
          description={
            feed.count === 0
              ? isOwner
                ? 'Nothing is fetched automatically. Use “Add announcement” to enter one from the PSX or company notice, or import a CSV file. Try a longer window to see older items.'
                : 'Nothing is fetched automatically. Items appear only when the owner adds them. Try a longer window.'
              : 'Pick another category or “All categories”.'
          }
        />
      ) : (
        <ul className="space-y-3" aria-label="News feed">
          {items.map((i) => (
            <li key={i.id}>
              <FeedItem item={i} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
