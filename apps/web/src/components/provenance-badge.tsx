'use client';

import type { DataSource } from '@ktrade/shared';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTime, formatPercent } from '@/lib/format';
import type { SourceBreakdown } from '@/lib/api/types';
import { DATA_SOURCES } from '@ktrade/shared';

export interface ProvenanceMeta {
  icon: string;
  label: string;
  description: string;
  className: string;
}

/** docs/02 §6 — one badge per DataSource. */
export const PROVENANCE: Record<DataSource, ProvenanceMeta> = {
  BROKER_CONFIRMED: {
    icon: '✅',
    label: 'Confirmed',
    description: 'From a contract note or broker/CDC statement.',
    className: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300',
  },
  BROKER_DISPLAYED: {
    icon: '👁',
    label: 'Broker-displayed',
    description: 'Read from the broker UI or API, not yet matched to a statement.',
    className: 'border-sky-600/30 bg-sky-600/10 text-sky-800 dark:text-sky-300',
  },
  PROVIDER: {
    icon: '📡',
    label: 'Market data',
    description: 'From a licensed market-data provider (delay shown where applicable).',
    className: 'border-indigo-600/30 bg-indigo-600/10 text-indigo-800 dark:text-indigo-300',
  },
  USER_REPORTED: {
    icon: '✍',
    label: 'Manual',
    description: 'Entered by you. Upgraded to Confirmed when a contract note reconciles it.',
    className: 'border-violet-600/30 bg-violet-600/10 text-violet-800 dark:text-violet-300',
  },
  ESTIMATED: {
    icon: '≈',
    label: 'Estimated',
    description: 'Computed from fee/tax tables or reference prices; the contract note may differ.',
    className: 'border-amber-600/40 bg-amber-500/10 text-amber-900 dark:text-amber-300',
  },
  SIMULATED: {
    icon: '🧪',
    label: 'Simulated',
    description: 'Paper, backtest, demo or sample data — not real market or account data.',
    className: 'border-fuchsia-600/30 bg-fuchsia-600/10 text-fuchsia-800 dark:text-fuchsia-300',
  },
};

export interface ProvenanceBadgeProps {
  source: DataSource;
  asOf?: string;
  note?: string;
  /** Icon-only (label stays available to screen readers and in the tooltip). */
  compact?: boolean;
  className?: string;
}

export function ProvenanceBadge({ source, asOf, note, compact = false, className }: ProvenanceBadgeProps) {
  const meta = PROVENANCE[source];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-source={source}
          aria-label={`Provenance: ${meta.label}. ${meta.description}`}
          className={cn(
            'inline-flex shrink-0 cursor-help items-center gap-1 rounded-full border px-1.5 py-px text-[0.6875rem] leading-4 font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring',
            meta.className,
            className,
          )}
        >
          <span aria-hidden="true">{meta.icon}</span>
          {!compact && <span aria-hidden="true">{meta.label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-left">
        <p className="font-semibold">
          {meta.icon} {meta.label}
        </p>
        <p>{meta.description}</p>
        {asOf && <p className="opacity-80">As of {formatDateTime(asOf)}</p>}
        {note && <p className="opacity-80">{note}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

/** "82% confirmed / 18% estimated" for aggregates. */
export function SourceBreakdownText({ breakdown, className }: { breakdown?: SourceBreakdown; className?: string }) {
  if (!breakdown) return null;
  const parts = DATA_SOURCES.filter((s) => breakdown[s] && breakdown[s] !== '0').map(
    (s) => `${formatPercent(breakdown[s], { fraction: true, dp: 0 })} ${PROVENANCE[s].label.toLowerCase()}`,
  );
  if (!parts.length) return null;
  return <span className={cn('text-xs text-muted-foreground', className)}>{parts.join(' / ')}</span>;
}
