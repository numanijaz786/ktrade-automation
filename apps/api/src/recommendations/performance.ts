import { type Decimal, fromInt, round, sum } from '@ktrade/finance-core';
import type { OutcomeStatus, RecommendationHorizon } from '@ktrade/shared';

/** One ACTIONABLE recommendation with its LATEST outcome row (null = never evaluated yet). */
export interface PerformanceRow {
  horizon: RecommendationHorizon;
  outcome: {
    status: OutcomeStatus;
    returnPct: Decimal | null;
    holdingDays: number;
    target1Hit: boolean;
    benchmarkReturnPct: Decimal | null;
  } | null;
}

export interface PerformanceStats {
  recommendations: number;
  evaluated: number;
  open: number;
  closed: number;
  /** Percent of CLOSED recommendations with a positive realised return; null when none closed. */
  winRatePct: string | null;
  avgReturnPct: string | null;
  /** Percent of evaluated recommendations that reached target 1 (closed or still open). */
  targetHitRatePct: string | null;
  /** Percent of CLOSED recommendations that ended at the stop. */
  stopFrequencyPct: string | null;
  avgHoldingDays: string | null;
  /** Mean benchmark (KSE-100) return over closed rows that have one; null when no benchmark data exists. */
  avgBenchmarkReturnPct: string | null;
  benchmarkSamples: number;
}

const p2 = (num: number, den: number): string | null =>
  den === 0 ? null : round(fromInt(num).div(den).times(100), 2).toFixed(2);
const avg = (values: Decimal[], dp: number): string | null =>
  values.length === 0 ? null : round(sum(values).div(values.length), dp).toFixed(dp);

export function aggregatePerformance(rows: readonly PerformanceRow[]): PerformanceStats {
  const evaluated = rows.filter((r) => r.outcome);
  const closed = evaluated.filter((r) => r.outcome!.status !== 'OPEN');
  const wins = closed.filter((r) => r.outcome!.returnPct?.gt(0)).length;
  const stops = closed.filter((r) => r.outcome!.status === 'STOPPED').length;
  const t1 = evaluated.filter((r) => r.outcome!.target1Hit).length;
  const returns = closed.flatMap((r) => (r.outcome!.returnPct ? [r.outcome!.returnPct] : []));
  const bench = closed.flatMap((r) => (r.outcome!.benchmarkReturnPct ? [r.outcome!.benchmarkReturnPct] : []));
  return {
    recommendations: rows.length,
    evaluated: evaluated.length,
    open: evaluated.length - closed.length,
    closed: closed.length,
    winRatePct: p2(wins, closed.length),
    avgReturnPct: avg(returns, 4),
    targetHitRatePct: p2(t1, evaluated.length),
    stopFrequencyPct: p2(stops, closed.length),
    avgHoldingDays: avg(
      closed.map((r) => fromInt(r.outcome!.holdingDays)),
      2,
    ),
    avgBenchmarkReturnPct: avg(bench, 4),
    benchmarkSamples: bench.length,
  };
}

export const BENCHMARK_MISSING_NOTE =
  'No KSE-100 series (macro series KSE100_INDEX) covers these recommendations, so no benchmark comparison is shown.';

export function performanceReport(
  rows: readonly PerformanceRow[],
  horizons: readonly RecommendationHorizon[],
) {
  const overall = aggregatePerformance(rows);
  return {
    ...overall,
    perHorizon: Object.fromEntries(
      horizons.map((h) => [h, aggregatePerformance(rows.filter((r) => r.horizon === h))]),
    ) as Record<RecommendationHorizon, PerformanceStats>,
    benchmark:
      overall.avgBenchmarkReturnPct === null
        ? null
        : {
            series: 'KSE100_INDEX',
            avgReturnPct: overall.avgBenchmarkReturnPct,
            samples: overall.benchmarkSamples,
          },
    benchmarkNote: overall.avgBenchmarkReturnPct === null ? BENCHMARK_MISSING_NOTE : null,
  };
}
