'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable, decimalSort } from '@/components/data-table';
import { PnlText } from '@/components/money';
import { PageHeader } from '@/components/page-header';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { StaleBadge } from '@/components/quote';
import { EmptyState } from '@/components/states';
import { useHoldings } from '@/lib/api/hooks';
import type { Holding } from '@/lib/api/types';
import { formatNumber, formatPercent, formatPKR, formatQty } from '@/lib/format';
import { useActivePortfolio } from '@/lib/portfolio-context';

/** A quote older than this is flagged stale on holdings (the API does not return a stale flag here). */
const STALE_MS = 15 * 60 * 1000;

function isStale(asOf: string | undefined, now: number): boolean {
  return !!asOf && now - new Date(asOf).getTime() > STALE_MS;
}

function holdingColumns(now: number): ColumnDef<Holding, unknown>[] {
  return [
    {
      id: 'symbol',
      // Symbol and company name together, so the search box matches either.
      accessorFn: (h) => `${h.symbol} ${h.name}`,
      header: 'Symbol / company',
      cell: ({ row }) => (
        <div>
          <Link
            href={`/market/${encodeURIComponent(row.original.symbol)}`}
            className="font-medium hover:underline"
          >
            {row.original.symbol}
          </Link>
          <div className="max-w-[14rem] truncate text-xs text-muted-foreground">{row.original.name}</div>
        </div>
      ),
    },
    {
      accessorKey: 'quantity',
      header: 'Qty',
      meta: { align: 'right' },
      sortingFn: decimalSort,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1">
          {formatQty(row.original.quantity)}
          <ProvenanceBadge source={row.original.source} compact />
        </span>
      ),
    },
    {
      accessorKey: 'avgCost',
      header: 'Avg cost',
      meta: { align: 'right' },
      sortingFn: decimalSort,
      cell: ({ row }) => formatNumber(row.original.avgCost, { dp: 4 }),
    },
    {
      id: 'lastPrice',
      accessorFn: (h) => h.lastPrice?.value ?? null,
      header: 'Last price',
      meta: { align: 'right' },
      sortingFn: decimalSort,
      cell: ({ row }) => {
        const p = row.original.lastPrice;
        if (!p) return <span className="text-muted-foreground">No quote</span>;
        return (
          <span className="inline-flex items-center gap-1">
            {formatNumber(p.value)}
            <ProvenanceBadge source={p.source} asOf={p.asOf} compact />
            {isStale(p.asOf, now) && <StaleBadge asOf={p.asOf} />}
          </span>
        );
      },
    },
    {
      accessorKey: 'totalCost',
      header: 'Total cost',
      meta: { align: 'right' },
      sortingFn: decimalSort,
      cell: ({ row }) => formatPKR(row.original.totalCost),
    },
    {
      accessorKey: 'marketValue',
      header: 'Market value',
      meta: { align: 'right' },
      sortingFn: decimalSort,
      cell: ({ row }) => formatPKR(row.original.marketValue),
    },
    {
      accessorKey: 'unrealizedPnl',
      header: 'Unrealised',
      meta: { align: 'right' },
      sortingFn: decimalSort,
      cell: ({ row }) =>
        row.original.unrealizedPnl === null ? (
          '—'
        ) : (
          <span className="inline-flex flex-col items-end">
            <PnlText value={row.original.unrealizedPnl} showIcon={false} source="ESTIMATED" />
            <PnlText value={row.original.unrealizedPnlPct} percent showIcon={false} className="text-xs" />
          </span>
        ),
    },
    {
      accessorKey: 'realizedPnl',
      header: 'Realised',
      meta: { align: 'right' },
      sortingFn: decimalSort,
      cell: ({ row }) => <PnlText value={row.original.realizedPnl} showIcon={false} />,
    },
    {
      accessorKey: 'weight',
      header: 'Weight',
      meta: { align: 'right' },
      sortingFn: decimalSort,
      cell: ({ row }) => formatPercent(row.original.weight, { fraction: true, dp: 1 }),
    },
  ];
}

export default function HoldingsPage() {
  const { portfolioId, portfolio } = useActivePortfolio();
  const query = useHoldings(portfolioId);
  // Staleness is judged at fetch time (no clock read during render).
  const now = query.dataUpdatedAt;
  const columns = useMemo(() => holdingColumns(now), [now]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Holdings"
        description={
          portfolio
            ? `${portfolio.name} · positions from the ledger, valued at the latest quotes. Unrealised P&L is an estimate.`
            : undefined
        }
      />
      {!portfolioId ? (
        <EmptyState title="No portfolio selected" description="Create or pick a portfolio first." />
      ) : (
        <DataTable
          caption="Holdings"
          data={query.data}
          columns={columns}
          isLoading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          searchPlaceholder="Search symbol or company…"
          initialSorting={[{ id: 'marketValue', desc: true }]}
          getRowId={(h) => h.symbol}
          pageSize={25}
          emptyTitle="No holdings"
          emptyDescription="Positions appear here after a fill is recorded or a statement is imported."
        />
      )}
    </div>
  );
}
