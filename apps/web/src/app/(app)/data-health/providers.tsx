'use client';

import { AlertTriangle, FlaskConical } from 'lucide-react';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { StatusPill, type StatusTone } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import type { DataSource, ProviderRow, ProviderStatusKind, Quote } from '@/lib/api/types';
import { formatDateTime, humanize } from '@/lib/format';

const TONE: Record<ProviderStatusKind, StatusTone> = {
  OK: 'good',
  DEGRADED: 'warn',
  FAILED: 'bad',
  NOT_CONFIGURED: 'neutral',
};
const LABEL: Record<ProviderStatusKind, string> = {
  OK: 'OK',
  DEGRADED: 'Degraded',
  FAILED: 'Failed',
  NOT_CONFIGURED: 'Not configured',
};

export function ProviderStatusBadge({ status }: { status: ProviderStatusKind }) {
  return <StatusPill tone={TONE[status]}>{LABEL[status]}</StatusPill>;
}

export function formatFreshness(minutes: number | null): string {
  if (minutes === null) return 'Not reported';
  if (minutes < 90) return `${minutes} min old`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h old`;
  return `${Math.round(minutes / 1440)} days old`;
}

/** The API's own text is shown as written; items that mention USER_ACTION_REQUIRED are marked as owner tasks. */
export function MissingList({ items }: { items: string[] }) {
  return (
    <div data-testid="missing" className="space-y-1">
      <p className="text-xs font-medium">What is missing</p>
      <ul className="list-disc space-y-0.5 pl-5 text-xs">
        {items.map((m, i) => (
          <li key={i}>
            {m}
            {m.includes('USER_ACTION_REQUIRED') && (
              <span className="ml-1 rounded border border-amber-600/40 px-1 text-[0.6875rem]">
                Owner task: see USER_ACTION_REQUIRED in the project files
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderRow }) {
  return (
    <Card className="gap-2 px-4 py-3" data-testid="provider-card" data-status={p.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">
            {p.displayName}
            {p.active && <span className="ml-2 text-xs font-normal text-muted-foreground">(active)</span>}
          </h3>
          <p className="text-xs text-muted-foreground">{p.dataType}</p>
        </div>
        <div className="flex items-center gap-2">
          <ProvenanceBadge source={p.source} />
          <ProviderStatusBadge status={p.status} />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Timeliness</dt>
          <dd>{p.timeliness}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last success</dt>
          <dd>{p.lastSuccessAt ? formatDateTime(p.lastSuccessAt) : 'Never'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Freshness</dt>
          <dd>{formatFreshness(p.freshnessMinutes)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Licence</dt>
          <dd className="text-xs">{p.licenseNote ?? 'Not stated'}</dd>
        </div>
      </dl>
      {p.message && <p className="text-xs text-muted-foreground">{p.message}</p>}
      {p.status === 'NOT_CONFIGURED' && p.missing.length > 0 && <MissingList items={p.missing} />}
      {p.status === 'NOT_CONFIGURED' && p.missing.length === 0 && (
        <p className="text-xs text-muted-foreground">Not configured. The API did not say what is missing.</p>
      )}
    </Card>
  );
}

export function ProviderList({ rows }: { rows: ProviderRow[] }) {
  return (
    <ul className="grid gap-3 lg:grid-cols-2" aria-label="Data providers">
      {rows.map((p) => (
        <li key={p.key}>
          <ProviderCard p={p} />
        </li>
      ))}
    </ul>
  );
}

// ─── price freshness ───────────────────────────────────────────────────────

export interface PriceFreshness {
  total: number;
  bySource: Partial<Record<DataSource, number>>;
  stale: number;
  allSimulated: boolean;
}

export function summarizeQuotes(quotes: Pick<Quote, 'source' | 'stale'>[]): PriceFreshness {
  const bySource: PriceFreshness['bySource'] = {};
  let stale = 0;
  for (const q of quotes) {
    bySource[q.source] = (bySource[q.source] ?? 0) + 1;
    if (q.stale) stale++;
  }
  return {
    total: quotes.length,
    bySource,
    stale,
    allSimulated: quotes.length > 0 && quotes.every((q) => q.source === 'SIMULATED'),
  };
}

export function SimulatedBanner() {
  return (
    <Alert variant="destructive" data-testid="all-simulated">
      <FlaskConical aria-hidden="true" />
      <AlertTitle>All prices are simulated — recommendations are disabled</AlertTitle>
      <AlertDescription>
        Every price comes from the built-in simulator, not the market. Connect a licensed or imported price
        source to get real recommendations.
      </AlertDescription>
    </Alert>
  );
}

export function FreshnessSummary({ f }: { f: PriceFreshness }) {
  if (f.total === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="freshness-empty">
        No prices are stored yet.
      </p>
    );
  const kinds = (Object.keys(f.bySource) as DataSource[]).sort();
  return (
    <div className="space-y-2" data-testid="freshness-summary">
      <ul className="flex flex-wrap gap-3" aria-label="Price sources">
        {kinds.map((s) => (
          <li key={s} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <ProvenanceBadge source={s} />
            <span>
              {f.bySource[s]} of {f.total} prices
            </span>
          </li>
        ))}
      </ul>
      <p className="flex items-center gap-1.5 text-sm" data-testid="stale-count">
        {f.stale > 0 && <AlertTriangle className="size-4 text-amber-600" aria-hidden="true" />}
        {f.stale === 0
          ? 'No stale prices.'
          : `${f.stale} ${f.stale === 1 ? 'price is' : 'prices are'} stale.`}
        <span className="text-muted-foreground">
          {' '}
          Mix: {kinds.map((s) => `${humanize(s)} ${f.bySource[s]}`).join(', ')}.
        </span>
      </p>
    </div>
  );
}
