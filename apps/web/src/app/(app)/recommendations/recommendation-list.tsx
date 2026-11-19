'use client';

import { FlaskConical } from 'lucide-react';
import { StatusPill, type StatusTone } from '@/components/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { OutcomeStatus, Recommendation } from '@/lib/api/types';
import { formatDate, formatNumber, formatPercent, humanize } from '@/lib/format';

const OUTCOME_TONE: Record<OutcomeStatus, StatusTone> = {
  OPEN: 'info',
  TARGET_HIT: 'good',
  STOPPED: 'bad',
  EXPIRED: 'neutral',
};
const OUTCOME_LABEL: Record<OutcomeStatus, string> = {
  OPEN: 'Open',
  TARGET_HIT: 'Target hit',
  STOPPED: 'Stopped out',
  EXPIRED: 'Expired',
};

export function OutcomeBadge({ rec }: { rec: Pick<Recommendation, 'status' | 'latestOutcome'> }) {
  const o = rec.latestOutcome;
  if (!o)
    return (
      <StatusPill tone="neutral" className="font-normal">
        {rec.status === 'NOT_ACTIONABLE' ? 'Not tracked' : 'Not evaluated yet'}
      </StatusPill>
    );
  return <StatusPill tone={OUTCOME_TONE[o.status]}>{OUTCOME_LABEL[o.status]}</StatusPill>;
}

export function SimulatedTag() {
  return (
    <StatusPill tone="warn" icon={FlaskConical}>
      Simulated prices: test only
    </StatusPill>
  );
}

export function RecommendationsTable({
  rows,
  onOpen,
}: {
  rows: Recommendation[];
  onOpen: (r: Recommendation) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <Table aria-label="Recommendation history">
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Symbol</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Horizon</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead className="text-right">Return</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={r.id}
              data-testid="rec-row"
              data-outcome={r.latestOutcome?.status ?? 'NONE'}
              className="cursor-pointer"
              onClick={() => onOpen(r)}
            >
              <TableCell className="whitespace-nowrap">{formatDate(r.generatedAt)}</TableCell>
              <TableCell>
                <button
                  type="button"
                  className="font-medium underline-offset-2 hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(r);
                  }}
                  aria-label={`Open ${r.symbol} ${humanize(r.horizon)} recommendation`}
                >
                  {r.symbol}
                </button>
              </TableCell>
              <TableCell>{humanize(r.action)}</TableCell>
              <TableCell>{humanize(r.horizon)}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <StatusPill tone={r.status === 'ACTIONABLE' ? 'info' : 'neutral'}>
                    {humanize(r.status)}
                  </StatusPill>
                  {r.simulated && <SimulatedTag />}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(r.price)}</TableCell>
              <TableCell>
                <OutcomeBadge rec={r} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {r.latestOutcome?.returnPct
                  ? formatPercent(r.latestOutcome.returnPct, { signed: true })
                  : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
