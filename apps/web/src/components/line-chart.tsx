'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries,
  ColorType,
  createChart,
  LineSeries,
  type IChartApi,
  type Time,
} from 'lightweight-charts';
import { useTheme } from 'next-themes';
import { chartNumber, formatDate, formatNumber } from '@/lib/format';
import { pktDay } from './candle-chart';

export interface LinePoint {
  /** ISO instant or YYYY-MM-DD. */
  t: string;
  /** Decimal string. */
  value: string;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

const dayOf = (t: string) => (/^\d{4}-\d{2}-\d{2}$/.test(t) ? t : pktDay(t));

/** One point per trading day, ascending (a later duplicate wins). */
export function toDaily(points: readonly LinePoint[]): { day: string; value: string }[] {
  const m = new Map<string, string>();
  for (const p of points) m.set(dayOf(p.t), p.value);
  return [...m.entries()]
    .map(([day, value]) => ({ day, value }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * A single-series line (lightweight-charts v5) with an optional second pane (e.g. drawdown, drawn as an
 * area below zero). One y-scale per pane, never a dual axis. Hover shows exact decimal values; a table
 * view of the data is always available.
 */
export function LineChart({
  label,
  series,
  seriesName,
  lower,
  lowerName,
  formatValue = (v) => formatNumber(v),
  formatLower = (v) => `${formatNumber(v)}%`,
  height = 300,
}: {
  label: string;
  series: readonly LinePoint[];
  seriesName: string;
  lower?: readonly LinePoint[];
  lowerName?: string;
  formatValue?: (v: string) => string;
  formatLower?: (v: string) => string;
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const main = useMemo(() => toDaily(series), [series]);
  const low = useMemo(() => (lower ? toDaily(lower) : []), [lower]);
  const [hover, setHover] = useState<string | null>(null);
  const mainBy = useMemo(() => new Map(main.map((p) => [p.day, p.value])), [main]);
  const lowBy = useMemo(() => new Map(low.map((p) => [p.day, p.value])), [low]);
  const shownDay = hover && mainBy.has(hover) ? hover : main.at(-1)?.day;

  useEffect(() => {
    if (!el.current || main.length === 0) return;
    const line = cssVar('--chart-1', '#2a78d6');
    const loss = cssVar('--loss', '#c22f2f');
    const grid = cssVar('--chart-grid', '#e1e0d9');
    const axis = cssVar('--chart-axis', '#898781');
    const chart: IChartApi = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: axis,
        attributionLogo: false,
        panes: { separatorColor: grid },
      },
      grid: { vertLines: { visible: false }, horzLines: { color: grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
    const s = chart.addSeries(LineSeries, { color: line, lineWidth: 2, priceLineVisible: false });
    s.setData(main.map((p) => ({ time: p.day as Time, value: chartNumber(p.value) })));
    if (low.length) {
      const dd = chart.addSeries(
        AreaSeries,
        {
          lineColor: loss,
          topColor: `${loss}10`,
          bottomColor: `${loss}55`,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        },
        1,
      );
      // Drawdown is a positive "% below peak"; plot it below zero so deeper reads lower.
      dd.setData(low.map((p) => ({ time: p.day as Time, value: -chartNumber(p.value) })));
      chart.panes()[1]?.setHeight(Math.round(height / 3));
    }
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((p) => setHover(typeof p.time === 'string' ? p.time : null));
    return () => chart.remove();
  }, [main, low, resolvedTheme, height]);

  if (main.length === 0) return <p className="text-sm text-muted-foreground">No data points yet.</p>;
  const shownValue = shownDay ? mainBy.get(shownDay) : undefined;
  const shownLow = shownDay ? lowBy.get(shownDay) : undefined;
  return (
    <figure className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular" aria-live="polite">
        {shownDay && <span className="font-medium">{formatDate(shownDay)}</span>}
        {shownValue !== undefined && (
          <span>
            <span className="text-muted-foreground">{seriesName} </span>
            {formatValue(shownValue)}
          </span>
        )}
        {shownLow !== undefined && lowerName && (
          <span>
            <span className="text-muted-foreground">{lowerName} </span>
            {formatLower(shownLow)}
          </span>
        )}
      </div>
      <div
        ref={el}
        style={{ height }}
        className="w-full"
        role="img"
        aria-label={`${label}: ${main.length} points from ${formatDate(main[0].day)} to ${formatDate(main.at(-1)!.day)}`}
      />
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Show data as a table</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border">
          <table className="w-full text-xs tabular">
            <thead className="sticky top-0 bg-background">
              <tr className="text-left">
                <th className="p-2">Date</th>
                <th className="p-2 text-right">{seriesName}</th>
                {lowerName && <th className="p-2 text-right">{lowerName}</th>}
              </tr>
            </thead>
            <tbody>
              {[...main].reverse().map((p) => (
                <tr key={p.day} className="border-t">
                  <td className="p-2">{formatDate(p.day)}</td>
                  <td className="p-2 text-right">{formatValue(p.value)}</td>
                  {lowerName && (
                    <td className="p-2 text-right">
                      {lowBy.has(p.day) ? formatLower(lowBy.get(p.day)!) : '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
