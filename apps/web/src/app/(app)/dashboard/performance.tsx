'use client';

import { useState, type ReactNode } from 'react';
import type { DataSource } from '@ktrade/shared';
import { FlaskConical, History, Info } from 'lucide-react';
import { toast } from 'sonner';
import { Section } from '@/components/page-header';
import { LineChart } from '@/components/line-chart';
import { PnlText } from '@/components/money';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { StatTile } from '@/components/stat-tile';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api/errors';
import { useBackfillSnapshots, useMe, usePortfolioPerformance } from '@/lib/api/hooks';
import {
  PERFORMANCE_RANGES,
  type PerformanceRange,
  type PnlBasis,
  type PnlFigure,
  type PortfolioPerformance,
} from '@/lib/api/types';
import { formatDate, formatPercent, formatPKR } from '@/lib/format';

/** What each P&L basis means — shown in a tooltip next to every snapshot-backed figure (ADR-027). */
export const BASIS_TEXT: Record<PnlBasis, { label: string; explain: string }> = {
  SNAPSHOT: {
    label: 'Close snapshot',
    explain: 'From the stored close-of-day snapshot of the last completed PSX session.',
  },
  LIVE_VS_PREVIOUS_SNAPSHOT: {
    label: 'Live vs previous close',
    explain:
      'Current quotes compared with the previous close snapshot, net of deposits and withdrawals since. Changes until the close snapshot is taken.',
  },
  SNAPSHOTS: {
    label: 'Close snapshots',
    explain: 'Sum of the daily P&L of this month’s close snapshots.',
  },
  SNAPSHOTS_PLUS_LIVE_TODAY: {
    label: 'Snapshots + live today',
    explain: 'This month’s close snapshots plus today’s live figure (current quotes vs the previous close).',
  },
};

/** "Basis: …" hint with an explanatory tooltip (dates included). */
export function BasisHint({ figure }: { figure: PnlFigure }) {
  if (!figure.basis) return figure.note ? <span>{figure.note}</span> : null;
  const b = BASIS_TEXT[figure.basis];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-help items-center gap-1 underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-basis={figure.basis}
        >
          <Info className="size-3" aria-hidden="true" />
          {b.label}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-left">
        <p>{b.explain}</p>
        {figure.tradingDate && <p className="opacity-80">Trading day {formatDate(figure.tradingDate)}</p>}
        {figure.previousCloseDate && (
          <p className="opacity-80">Measured against the {formatDate(figure.previousCloseDate)} close</p>
        )}
        {figure.month && (
          <p className="opacity-80">
            {figure.month}
            {figure.sessions !== undefined && ` · ${figure.sessions} session(s)`}
          </p>
        )}
        {figure.note && <p className="opacity-80">{figure.note}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

const NA = <span className="text-base font-normal text-muted-foreground">n/a</span>;

function pct(v: string | null, signed = true) {
  if (v === null) return NA;
  return signed ? <PnlText value={v} percent showIcon={false} /> : formatPercent(v);
}

export function PerformanceSection({ portfolioId }: { portfolioId: string }) {
  const [range, setRange] = useState<PerformanceRange>('3M');
  const perf = usePortfolioPerformance(portfolioId, range);
  return (
    <Section
      title="Performance"
      description="From daily close snapshots of this portfolio."
      actions={
        <div role="group" aria-label="Performance range" className="flex flex-wrap gap-1">
          {PERFORMANCE_RANGES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={range === r ? 'secondary' : 'ghost'}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {r}
            </Button>
          ))}
        </div>
      }
    >
      {perf.isPending ? (
        <LoadingBlock rows={6} label="Loading performance" />
      ) : perf.isError ? (
        <ErrorState error={perf.error} onRetry={() => void perf.refetch()} />
      ) : perf.data.series.length === 0 ? (
        <NoSnapshots portfolioId={portfolioId} note={perf.data.note} />
      ) : (
        <PerformanceBody p={perf.data} />
      )}
    </Section>
  );
}

function NoSnapshots({ portfolioId, note }: { portfolioId: string; note: string | null }) {
  const me = useMe();
  const backfill = useBackfillSnapshots();
  const isOwner = me.data?.role === 'OWNER';
  return (
    <EmptyState
      icon={<History className="size-8" />}
      title="No performance history yet"
      description={
        <>
          Performance is computed from daily close snapshots, and this portfolio has none yet.{' '}
          {isOwner
            ? 'Backfill rebuilds them from your first activity to the last completed session.'
            : 'The owner can backfill them.'}
          {note && <span className="mt-1 block text-xs">{note}</span>}
        </>
      }
      action={
        isOwner && (
          <Button
            size="sm"
            disabled={backfill.isPending}
            onClick={() =>
              backfill.mutate(portfolioId, {
                onSuccess: (r) => {
                  toast.success(
                    `Backfilled ${r.tradingDays} trading day(s): ${formatDate(r.from)} – ${formatDate(r.to)}`,
                  );
                  if (r.unpricedSymbols.length)
                    toast.warning(
                      `No close for ${r.unpricedSymbols.join(', ')} on some days — valued at cost (Estimated).`,
                    );
                },
                onError: (e) => toast.error(errorMessage(e)),
              })
            }
          >
            <History aria-hidden="true" /> {backfill.isPending ? 'Backfilling…' : 'Backfill history'}
          </Button>
        )
      }
    />
  );
}

function SourceBanner({ source }: { source: DataSource }) {
  if (source === 'SIMULATED')
    return (
      <Alert className="border-fuchsia-600/40 bg-fuchsia-600/5" data-testid="simulated-banner">
        <FlaskConical aria-hidden="true" />
        <AlertTitle>Simulated performance</AlertTitle>
        <AlertDescription>
          These figures come from paper trading or simulated prices — not real account results.
        </AlertDescription>
      </Alert>
    );
  if (source === 'ESTIMATED')
    return (
      <Alert data-testid="estimated-banner">
        <Info aria-hidden="true" />
        <AlertTitle>Includes estimated valuations</AlertTitle>
        <AlertDescription>
          Some days had holdings without a close price; they were valued at cost.
        </AlertDescription>
      </Alert>
    );
  return null;
}

function PerformanceBody({ p }: { p: PortfolioPerformance }) {
  const dd = p.maxDrawdown;
  return (
    <div className="space-y-3">
      <SourceBanner source={p.source} />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="performance-metrics">
        <StatTile
          label={`TWR (${p.range})`}
          value={pct(p.twr.valuePct)}
          source={p.twr.source}
          hint={p.twr.baseDate ? `Since the ${formatDate(p.twr.baseDate)} close` : 'Time-weighted'}
        />
        <StatTile
          label={`Max drawdown (${p.range})`}
          value={dd && dd.valuePct !== null ? `${formatPercent(dd.valuePct)}` : NA}
          source={dd?.source ?? p.source}
          hint={
            dd?.peakDate && dd.troughDate
              ? `${formatDate(dd.peakDate)} → ${formatDate(dd.troughDate)}${dd.recoveryDate ? ` · recovered ${formatDate(dd.recoveryDate)}` : ' · not recovered'}`
              : 'Peak-to-trough on the TWR index'
          }
        />
        <StatTile
          label="Simple return"
          value={pct(p.simpleReturn.valuePct)}
          source={p.simpleReturn.source}
          hint="Since inception, on net deposits"
        />
        <StatTile
          label="XIRR"
          value={pct(p.xirr.valuePct)}
          source={p.xirr.source}
          hint={
            p.xirr.valuePct === null ? 'Not computable from these cash flows' : 'Since inception, annualised'
          }
        />
      </div>
      <div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardContent className="space-y-2 pt-4">
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              Portfolio value at each close, {p.from ? formatDate(p.from) : '—'} –{' '}
              {p.to ? formatDate(p.to) : '—'}
              <ProvenanceBadge source={p.source} note={p.methodology ?? undefined} />
            </p>
            <LineChart
              label="Portfolio value"
              seriesName="Value"
              series={p.series.map((x) => ({ t: x.date, value: x.totalValue }))}
              formatValue={(v) => formatPKR(v)}
              height={260}
            />
          </CardContent>
        </Card>
        <MonthlyTable p={p} />
      </div>
      {p.methodology && <p className="text-xs text-muted-foreground">{p.methodology}</p>}
    </div>
  );
}

function MonthlyTable({ p }: { p: PortfolioPerformance }): ReactNode {
  const rows = [...p.monthly].reverse();
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="mb-2 text-sm font-medium">Monthly P&L</p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No full sessions in this range.</p>
        ) : (
          <div className="max-h-80 overflow-auto">
            <Table aria-label="Monthly P&L">
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => (
                  <TableRow key={m.month}>
                    <TableCell>{m.month}</TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center gap-1.5">
                        <PnlText value={m.pnl} showIcon={false} />
                        <ProvenanceBadge source={m.source} compact />
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular">{m.days}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
