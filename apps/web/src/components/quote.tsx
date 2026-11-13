'use client';

import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime, formatNumber } from '@/lib/format';
import type { Quote } from '@/lib/api/types';
import { PnlText } from './money';
import { ProvenanceBadge } from './provenance-badge';

/** Visible stale marker: icon + word, never colour alone. */
export function StaleBadge({ asOf, className }: { asOf?: string | null; className?: string }) {
  return (
    <span
      data-testid="stale-badge"
      title={asOf ? `Last updated ${formatDateTime(asOf)}` : 'Not updated recently'}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-600/40 bg-amber-500/10 px-1.5 py-px text-[0.6875rem] leading-4 font-medium text-amber-900 dark:text-amber-300',
        className,
      )}
    >
      <Clock className="size-3" aria-hidden="true" />
      Stale
    </span>
  );
}

/** Last price + provenance badge (with asOf) + stale marker. */
export function QuotePrice({
  quote,
  className,
  compact = true,
}: {
  quote: Quote | null | undefined;
  className?: string;
  compact?: boolean;
}) {
  if (!quote) return <span className="text-muted-foreground">No quote</span>;
  const note = quote.delayMinutes > 0 ? `Delayed ${quote.delayMinutes} min` : undefined;
  return (
    <span className={cn('inline-flex items-center gap-1.5 tabular', className)}>
      <span>{formatNumber(quote.last)}</span>
      <ProvenanceBadge source={quote.source} asOf={quote.asOf} note={note} compact={compact} />
      {quote.stale && <StaleBadge asOf={quote.asOf} />}
    </span>
  );
}

export function QuoteChange({ quote, className }: { quote: Quote | null | undefined; className?: string }) {
  if (!quote || quote.changePct === null) return <span className="text-muted-foreground">—</span>;
  return <PnlText value={quote.changePct} percent className={className} />;
}

export function QuoteVolume({ quote }: { quote: Quote | null | undefined }) {
  return <span className="tabular">{quote?.volume ? formatNumber(quote.volume, { dp: 0 }) : '—'}</span>;
}

/** "Data: Simulated · as of 13 Nov 2026, 12:15 PKT". */
export function DataStamp({
  source,
  asOf,
  stale,
  className,
}: {
  source: Quote['source'] | null | undefined;
  asOf: string | null | undefined;
  stale?: boolean;
  className?: string;
}) {
  return (
    <p className={cn('flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <span>Data:</span>
      {source ? <ProvenanceBadge source={source} asOf={asOf ?? undefined} /> : <span>no quotes yet</span>}
      <span>as of {formatDateTime(asOf)}</span>
      {stale && <StaleBadge asOf={asOf} />}
    </p>
  );
}
