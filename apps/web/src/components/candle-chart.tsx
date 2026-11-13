'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type Time,
} from 'lightweight-charts';
import { useTheme } from 'next-themes';
import type { DataSource } from '@ktrade/shared';
import type { Candle } from '@/lib/api/types';
import { chartNumber, formatDate, formatNumber } from '@/lib/format';
import { PROVENANCE, ProvenanceBadge } from './provenance-badge';

const PKT_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Bar instant → PKT trading date (`YYYY-MM-DD`), the chart's business-day key. */
export function pktDay(ts: string): string {
  return PKT_DATE.format(new Date(ts));
}

/** Ascending, one bar per trading day (a later duplicate wins). */
export function toChartBars(candles: readonly Candle[]): (Candle & { day: string })[] {
  const byDay = new Map<string, Candle & { day: string }>();
  for (const c of candles) byDay.set(pktDay(c.ts), { ...c, day: pktDay(c.ts) });
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** "118 Simulated · 6 Manual" — every source present in the series. */
export function sourceCounts(candles: readonly Candle[]): { source: DataSource; count: number }[] {
  const m = new Map<DataSource, number>();
  for (const c of candles) m.set(c.source, (m.get(c.source) ?? 0) + 1);
  return [...m.entries()].map(([source, count]) => ({ source, count }));
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Daily candlesticks with a volume pane (lightweight-charts v5). Hover shows the bar's OHLC, volume
 * and its own provenance; a table view of recent bars is always available.
 */
export function CandleChart({ symbol, candles }: { symbol: string; candles: readonly Candle[] }) {
  const el = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const bars = useMemo(() => toChartBars(candles), [candles]);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const byDay = useMemo(() => new Map(bars.map((b) => [b.day, b])), [bars]);
  const shown = (hoverDay && byDay.get(hoverDay)) || bars.at(-1);

  useEffect(() => {
    if (!el.current || bars.length === 0) return;
    const gain = cssVar('--gain', '#006300');
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
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
    const price = chart.addSeries(CandlestickSeries, {
      upColor: gain,
      downColor: loss,
      borderUpColor: gain,
      borderDownColor: loss,
      wickUpColor: gain,
      wickDownColor: loss,
      priceLineVisible: false,
    });
    const volume = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, color: axis, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    price.setData(
      bars.map((b) => ({
        time: b.day as Time,
        open: chartNumber(b.open),
        high: chartNumber(b.high),
        low: chartNumber(b.low),
        close: chartNumber(b.close),
      })),
    );
    volume.setData(bars.map((b) => ({ time: b.day as Time, value: chartNumber(b.volume) })));
    chart.panes()[1]?.setHeight(80);
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((p) => setHoverDay(typeof p.time === 'string' ? p.time : null));
    return () => chart.remove();
  }, [bars, resolvedTheme]);

  if (bars.length === 0)
    return <p className="text-sm text-muted-foreground">No price history for {symbol}.</p>;

  const counts = sourceCounts(candles);
  return (
    <figure className="space-y-2">
      {shown && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular" aria-live="polite">
          <span className="font-medium">{formatDate(shown.day)}</span>
          <span>O {formatNumber(shown.open)}</span>
          <span>H {formatNumber(shown.high)}</span>
          <span>L {formatNumber(shown.low)}</span>
          <span>C {formatNumber(shown.close)}</span>
          <span>Vol {formatNumber(shown.volume, { dp: 0 })}</span>
          <ProvenanceBadge source={shown.source} />
        </div>
      )}
      <div
        ref={el}
        className="h-[360px] w-full"
        role="img"
        aria-label={`${symbol} daily candlestick chart, ${bars.length} sessions from ${formatDate(bars[0].day)} to ${formatDate(bars.at(-1)!.day)}`}
      />
      <figcaption className="text-xs text-muted-foreground">
        Each bar keeps its own source:{' '}
        {counts.map((c, i) => (
          <span key={c.source}>
            {i > 0 && ' · '}
            {c.count} {PROVENANCE[c.source].label.toLowerCase()}
          </span>
        ))}
        . Hover a bar to see its source.
      </figcaption>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Show recent bars as a table</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border">
          <table className="w-full text-xs tabular">
            <thead className="sticky top-0 bg-background">
              <tr className="text-left">
                <th className="p-2">Date</th>
                <th className="p-2 text-right">Open</th>
                <th className="p-2 text-right">High</th>
                <th className="p-2 text-right">Low</th>
                <th className="p-2 text-right">Close</th>
                <th className="p-2 text-right">Volume</th>
                <th className="p-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {bars
                .slice(-30)
                .reverse()
                .map((b) => (
                  <tr key={b.day} className="border-t">
                    <td className="p-2">{formatDate(b.day)}</td>
                    <td className="p-2 text-right">{formatNumber(b.open)}</td>
                    <td className="p-2 text-right">{formatNumber(b.high)}</td>
                    <td className="p-2 text-right">{formatNumber(b.low)}</td>
                    <td className="p-2 text-right">{formatNumber(b.close)}</td>
                    <td className="p-2 text-right">{formatNumber(b.volume, { dp: 0 })}</td>
                    <td className="p-2">{PROVENANCE[b.source].label}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
