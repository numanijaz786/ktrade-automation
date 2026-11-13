'use client';

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Undo2 } from 'lucide-react';
import { PnlText } from '@/components/money';
import { PageHeader } from '@/components/page-header';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/states';
import { FeeBreakdown } from '@/components/trading';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTransactions } from '@/lib/api/hooks';
import type { Transaction } from '@/lib/api/types';
import { Dec } from '@/lib/decimal';
import { formatDate, formatNumber, formatPKR, formatQty, humanize } from '@/lib/format';
import { useActivePortfolio } from '@/lib/portfolio-context';
import { cn } from '@/lib/utils';

export default function TransactionsPage() {
  const { portfolioId, portfolio } = useActivePortfolio();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        description={
          portfolio
            ? `${portfolio.name} · the ledger, newest first. Expand a row for its fee and tax breakdown.`
            : undefined
        }
      />
      {portfolioId ? (
        <TransactionList key={portfolioId} portfolioId={portfolioId} />
      ) : (
        <EmptyState title="No portfolio selected" description="Create or pick a portfolio first." />
      )}
    </div>
  );
}

function TransactionList({ portfolioId }: { portfolioId: string }) {
  const q = useTransactions(portfolioId, 50);
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (q.isPending) return <LoadingBlock rows={6} label="Loading transactions" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const rows = q.data.pages.flatMap((p) => p.data);
  if (!rows.length)
    return (
      <EmptyState
        title="No transactions yet"
        description="Fills recorded on orders and committed statement imports appear here."
      />
    );
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border">
        <Table aria-label="Transactions">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead className="w-8">
                <span className="sr-only">Details</span>
              </TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Symbol</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">Fees</TableHead>
              <TableHead className="text-right">Taxes</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead className="text-right">Realised</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t) => (
              <Row key={t.id} t={t} open={open.has(t.id)} onToggle={() => toggle(t.id)} />
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span aria-live="polite">
          {rows.length} {rows.length === 1 ? 'transaction' : 'transactions'} loaded
          {!q.hasNextPage && ' · that is all of them'}
        </span>
        {q.hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            disabled={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {q.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden="true" />}
            Load more
          </Button>
        )}
      </div>
    </div>
  );
}

function Row({ t, open, onToggle }: { t: Transaction; open: boolean; onToggle: () => void }) {
  const taxes = t.taxes ?? null;
  const lines = t.feeLines ?? [];
  const lineSources = [...new Set(lines.map((l) => l.source))];
  return (
    <Fragment>
      <TableRow
        data-reversed={t.reversed ? 'true' : undefined}
        className={cn(t.reversed && 'text-muted-foreground line-through decoration-muted-foreground/60')}
      >
        <TableCell>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} fee breakdown for ${t.type} ${t.symbol} on ${formatDate(t.tradeDate)}`}
            onClick={onToggle}
          >
            {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </Button>
        </TableCell>
        <TableCell className="whitespace-nowrap">{formatDate(t.tradeDate)}</TableCell>
        <TableCell>
          {humanize(t.type)}
          {t.reversed && (
            <span
              className="ml-1.5 inline-flex items-center gap-1 rounded border px-1 text-[0.6875rem] no-underline"
              data-testid="reversed-badge"
            >
              <Undo2 className="size-3" aria-hidden="true" /> Reversed
            </span>
          )}
        </TableCell>
        <TableCell className="font-medium">{t.symbol}</TableCell>
        <TableCell className="text-right tabular">{formatQty(t.quantity)}</TableCell>
        <TableCell className="text-right tabular">{formatNumber(t.price, { dp: 4 })}</TableCell>
        <TableCell className="text-right tabular">{formatPKR(t.grossAmount)}</TableCell>
        <TableCell className="text-right tabular">
          <span className="inline-flex items-center gap-1">
            {formatPKR(t.fees)}
            {lineSources.map((s) => (
              <ProvenanceBadge key={s} source={s} compact />
            ))}
          </span>
        </TableCell>
        <TableCell className="text-right tabular">{taxes === null ? '—' : formatPKR(taxes)}</TableCell>
        <TableCell className="text-right tabular">{formatPKR(t.netAmount)}</TableCell>
        <TableCell className="text-right tabular">
          {t.realizedPnl ? <PnlText value={t.realizedPnl} showIcon={false} /> : '—'}
        </TableCell>
        <TableCell>
          <ProvenanceBadge source={t.source} />
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell />
          <TableCell colSpan={11} className="py-3">
            <div className="max-w-lg">
              <p className="mb-1 text-xs font-medium">
                Fees and taxes{t.reversed ? ' (reversed — no longer counted)' : ''}
              </p>
              <FeeBreakdown
                lines={lines}
                total={Dec.of(t.fees)
                  .add(taxes ?? '0')
                  .toString()}
                caption={`Fee breakdown for ${t.type} ${t.symbol}`}
              />
            </div>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
