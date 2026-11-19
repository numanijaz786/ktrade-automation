'use client';

import { Info } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PerformanceStats, RecommendationPerformance } from '@/lib/api/types';
import { formatNumber, formatPercent, humanize } from '@/lib/format';

const pct = (v: string | null, signed = false) =>
  v === null ? 'Not enough data' : formatPercent(v, { signed });

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="gap-1 px-4 py-3">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </Card>
  );
}

export function PerformancePanel({
  perf,
  includeSimulated,
}: {
  perf: RecommendationPerformance;
  includeSimulated: boolean;
}) {
  const horizons = Object.entries(perf.perHorizon) as [string, PerformanceStats][];
  return (
    <div className="space-y-4" data-testid="performance">
      <Alert>
        <Info aria-hidden="true" />
        <AlertDescription>
          {includeSimulated
            ? 'Recommendations priced on simulated data are included. They are for testing only and say nothing about real results.'
            : 'Recommendations priced on simulated data are left out by default.'}{' '}
          Only actionable recommendations are counted. Failed ones (stopped out) are always included.{' '}
          {perf.note}
        </AlertDescription>
      </Alert>
      <p className="text-sm text-muted-foreground" data-testid="perf-counts">
        {perf.recommendations} actionable, {perf.evaluated} evaluated ({perf.open} open, {perf.closed}{' '}
        closed).
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Win rate" value={pct(perf.winRatePct)} hint="Closed ones with a gain" />
        <Stat label="Average return" value={pct(perf.avgReturnPct, true)} hint="Closed ones" />
        <Stat label="Target hit rate" value={pct(perf.targetHitRatePct)} hint="Reached target 1" />
        <Stat label="Stop-out rate" value={pct(perf.stopFrequencyPct)} hint="Closed ones that hit the stop" />
        <Stat
          label="Average days held"
          value={
            perf.avgHoldingDays === null ? 'Not enough data' : formatNumber(perf.avgHoldingDays, { dp: 1 })
          }
        />
        <Stat
          label="KSE-100 comparison"
          value={perf.benchmark ? pct(perf.benchmark.avgReturnPct, true) : 'Not available'}
          hint={
            perf.benchmark
              ? `Average over ${perf.benchmark.samples} closed`
              : (perf.benchmarkNote ?? undefined)
          }
        />
      </div>
      <div className="overflow-x-auto">
        <Table aria-label="Performance by horizon">
          <TableHeader>
            <TableRow>
              <TableHead>Horizon</TableHead>
              <TableHead className="text-right">Counted</TableHead>
              <TableHead className="text-right">Closed</TableHead>
              <TableHead className="text-right">Win rate</TableHead>
              <TableHead className="text-right">Avg return</TableHead>
              <TableHead className="text-right">Target hit</TableHead>
              <TableHead className="text-right">Stop-out</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {horizons.map(([h, s]) => (
              <TableRow key={h} data-testid="horizon-row">
                <TableCell>{humanize(h)}</TableCell>
                <TableCell className="text-right tabular-nums">{s.recommendations}</TableCell>
                <TableCell className="text-right tabular-nums">{s.closed}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {s.winRatePct === null ? '—' : formatPercent(s.winRatePct)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {s.avgReturnPct === null ? '—' : formatPercent(s.avgReturnPct, { signed: true })}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {s.targetHitRatePct === null ? '—' : formatPercent(s.targetHitRatePct)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {s.stopFrequencyPct === null ? '—' : formatPercent(s.stopFrequencyPct)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
