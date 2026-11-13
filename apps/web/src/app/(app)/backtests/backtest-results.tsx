'use client';

import { AlertTriangle, Info } from 'lucide-react';
import { LineChart } from '@/components/line-chart';
import { PnlText } from '@/components/money';
import { Section } from '@/components/page-header';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { StatTile } from '@/components/stat-tile';
import { ErrorState, LoadingBlock } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useBacktestTrades } from '@/lib/api/hooks';
import type { Backtest, BacktestMetrics, DataSource } from '@/lib/api/types';
import { formatDate, formatNumber, formatPercent, formatPKR, formatQty, humanize } from '@/lib/format';

/** The disclaimer every backtest carries. Always rendered, never collapsible. */
export function Disclaimer({ text }: { text: string }) {
  return (
    <Alert data-testid="backtest-disclaimer">
      <Info aria-hidden="true" />
      <AlertTitle>Backtest disclaimer</AlertTitle>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

/** SIMULATED price history is flagged prominently; other sources get their provenance badge. */
export function DataSourceBanner({ source }: { source: DataSource }) {
  if (source === 'SIMULATED')
    return (
      <Alert variant="destructive" data-testid="simulated-banner">
        <AlertTriangle aria-hidden="true" />
        <AlertTitle className="flex items-center gap-2">
          Simulated price data <ProvenanceBadge source="SIMULATED" />
        </AlertTitle>
        <AlertDescription>
          This test ran on synthetic prices, not real PSX history. The results say nothing about how the
          strategy would have performed in the real market.
        </AlertDescription>
      </Alert>
    );
  return (
    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
      Price data: <ProvenanceBadge source={source} />
    </p>
  );
}

const pct = (v: string | null) => (v === null ? '—' : <PnlText value={v} percent showIcon={false} />);
const plain = (v: string | null, dp = 2) => (v === null ? '—' : formatNumber(v, { dp }));

export function MetricTiles({ m, benchmark }: { m: BacktestMetrics; benchmark: string | null }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="metrics">
      <StatTile label="Total return" value={pct(m.totalReturnPct)} source="SIMULATED" />
      <StatTile label="Annualised" value={pct(m.annualizedReturnPct)} source="SIMULATED" />
      <StatTile label="CAGR" value={pct(m.cagrPct)} source="SIMULATED" />
      <StatTile
        label="Max drawdown"
        value={m.maxDrawdownPct === null ? '—' : formatPercent(m.maxDrawdownPct)}
        source="SIMULATED"
        hint="Largest fall from a peak"
      />
      <StatTile label="Sharpe" value={plain(m.sharpe)} source="SIMULATED" />
      <StatTile label="Sortino" value={plain(m.sortino)} source="SIMULATED" />
      <StatTile
        label="Win rate"
        value={m.winRatePct === null ? '—' : formatPercent(m.winRatePct, { dp: 1 })}
        source="SIMULATED"
        hint={`${m.tradeCount} closed trade${m.tradeCount === 1 ? '' : 's'}`}
      />
      <StatTile label="Profit factor" value={plain(m.profitFactor)} source="SIMULATED" />
      <StatTile
        label="Risk / reward"
        value={plain(m.riskReward)}
        source="SIMULATED"
        hint="Avg win ÷ avg loss"
      />
      <StatTile
        label="Fees paid"
        value={m.feesTotal === null ? '—' : formatPKR(m.feesTotal)}
        source="ESTIMATED"
        hint="KTrade fee schedule"
      />
      <StatTile
        label="Final equity"
        value={m.finalEquity === null ? '—' : formatPKR(m.finalEquity)}
        source="SIMULATED"
      />
      <StatTile
        label="Buy & hold"
        value={pct(benchmark ?? m.buyAndHoldReturnPct)}
        source="SIMULATED"
        hint="Benchmark"
      />
    </div>
  );
}

export function BacktestResults({ bt }: { bt: Backtest }) {
  return (
    <div className="space-y-6" data-testid="backtest-results">
      <Disclaimer text={bt.disclaimer} />
      <DataSourceBanner source={bt.dataSource} />
      <p className="text-sm text-muted-foreground">
        {humanize(bt.strategyType)} on {bt.symbol} · {formatDate(bt.from)} – {formatDate(bt.to)} · starting
        capital {formatPKR(bt.initialCapital)}
        {bt.slippageBps !== null && ` · slippage ${bt.slippageBps} bps`}
      </p>
      {bt.status === 'FAILED' ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Backtest failed</AlertTitle>
          <AlertDescription>{bt.error ?? 'Unknown error'}</AlertDescription>
        </Alert>
      ) : (
        <>
          {bt.metrics && <MetricTiles m={bt.metrics} benchmark={bt.benchmark.totalReturnPct} />}
          <Section
            title="Equity curve and drawdown"
            description="Simulated equity; drawdown below as % from the peak."
          >
            <LineChart
              label={`Simulated equity for ${bt.symbol}`}
              seriesName="Equity"
              series={bt.equityCurve.map((p) => ({ t: p.t, value: p.equity }))}
              lowerName="Drawdown"
              lower={bt.equityCurve.map((p) => ({ t: p.t, value: p.drawdownPct }))}
              formatValue={(v) => formatPKR(v)}
              formatLower={(v) => `−${formatNumber(v)}%`}
            />
          </Section>
          <Trades id={bt.id} />
        </>
      )}
    </div>
  );
}

function Trades({ id }: { id: string }) {
  const q = useBacktestTrades(id);
  return (
    <Section title="Trades">
      {q.isPending ? (
        <LoadingBlock rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">The strategy made no trades in this period.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table aria-label="Backtest trades">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Entry</TableHead>
                <TableHead>Exit</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Entry price</TableHead>
                <TableHead className="text-right">Exit price</TableHead>
                <TableHead className="text-right">Fees</TableHead>
                <TableHead className="text-right">P&L</TableHead>
                <TableHead>Exit reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.data.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="whitespace-nowrap">{formatDate(t.entryTs)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {t.exitTs ? formatDate(t.exitTs) : 'Open at end'}
                  </TableCell>
                  <TableCell className="text-right tabular">{formatQty(t.quantity)}</TableCell>
                  <TableCell className="text-right tabular">
                    {formatNumber(t.entryPrice, { dp: 4 })}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {t.exitPrice ? formatNumber(t.exitPrice, { dp: 4 }) : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular">{formatPKR(t.fees)}</TableCell>
                  <TableCell className="text-right tabular">
                    {t.pnl === null ? '—' : <PnlText value={t.pnl} showIcon={false} />}
                  </TableCell>
                  <TableCell>{t.exitReason ? humanize(t.exitReason) : t.open ? 'Still open' : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {q.data && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Trades source: <ProvenanceBadge source={q.data.source} />
        </p>
      )}
    </Section>
  );
}
