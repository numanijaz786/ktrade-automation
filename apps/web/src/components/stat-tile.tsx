'use client';

import type { ReactNode } from 'react';
import type { DataSource } from '@ktrade/shared';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ProvenanceBadge, SourceBreakdownText } from './provenance-badge';
import type { SourceBreakdown } from '@/lib/api/types';

export interface StatTileProps {
  label: string;
  value: ReactNode;
  source?: DataSource;
  asOf?: string;
  note?: string;
  breakdown?: SourceBreakdown;
  delta?: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  className?: string;
}

/** KPI tile: label · value · provenance · optional delta and hint. */
export function StatTile({
  label,
  value,
  source,
  asOf,
  note,
  breakdown,
  delta,
  hint,
  icon,
  loading,
  className,
}: StatTileProps) {
  return (
    <Card className={cn('gap-1.5 px-4 py-3.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {icon && <span aria-hidden="true">{icon}</span>}
          {label}
        </span>
        {source && !loading && <ProvenanceBadge source={source} asOf={asOf} note={note} compact />}
      </div>
      {loading ? (
        <Skeleton className="h-7 w-32" />
      ) : (
        <div className="text-xl font-semibold tracking-tight tabular sm:text-2xl">{value}</div>
      )}
      {(delta || hint || breakdown) && !loading && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {delta}
          {hint && <span className="text-muted-foreground">{hint}</span>}
          <SourceBreakdownText breakdown={breakdown} />
        </div>
      )}
    </Card>
  );
}
