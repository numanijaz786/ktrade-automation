'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Ban, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ORDER_STATUSES, type OrderStatus } from '@ktrade/shared';
import { EstimateSummary, Executions, ManualTicket } from '@/components/order-flow';
import { PageHeader } from '@/components/page-header';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { OrderStatusBadge } from '@/components/status-badge';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/states';
import { FeeBreakdown, RiskChecks } from '@/components/trading';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api/errors';
import { useCancelOrder, useOrder, useOrders } from '@/lib/api/hooks';
import type { Order } from '@/lib/api/types';
import { formatDateTime, formatNumber, formatQty, humanize } from '@/lib/format';
import { useActivePortfolio } from '@/lib/portfolio-context';

/** Mirrors the API: these can no longer be cancelled. */
const FINAL: OrderStatus[] = ['FILLED', 'CANCELLED', 'REJECTED_BY_RISK', 'REJECTED_BY_BROKER', 'EXPIRED'];
const AT_BROKER: OrderStatus[] = ['PLACED_BY_USER', 'PARTIALLY_FILLED', 'SUBMITTED', 'ACCEPTED'];

export default function OrdersPage() {
  const { portfolioId, portfolio } = useActivePortfolio();
  const [status, setStatus] = useState<OrderStatus | 'ALL'>('ALL');
  const [selected, setSelected] = useState<string | null>(null);
  const q = useOrders({ portfolioId, status: status === 'ALL' ? undefined : status });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Orders"
        description={
          portfolio ? `${portfolio.name} · newest first. Select an order for its full history.` : undefined
        }
        actions={
          <Button size="sm" asChild>
            <Link href="/trade">New order</Link>
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(v) => setStatus(v as OrderStatus | 'ALL')}>
          <SelectTrigger aria-label="Filter by status" className="w-full sm:w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All statuses</SelectItem>
            {ORDER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {humanize(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {q.isPending ? (
        <LoadingBlock rows={6} label="Loading orders" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={status === 'ALL' ? 'No orders yet' : `No ${humanize(status).toLowerCase()} orders`}
          action={
            <Button size="sm" asChild>
              <Link href="/trade">Buy / Sell</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-lg border">
            <Table aria-label="Orders">
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Filled</TableHead>
                  <TableHead className="text-right">Avg fill</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow
                    key={o.id}
                    tabIndex={0}
                    className="cursor-pointer"
                    onClick={() => setSelected(o.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(o.id);
                      }
                    }}
                    aria-label={`${o.side} ${o.quantity} ${o.symbol}, ${humanize(o.status)}`}
                  >
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      {formatDateTime(o.createdAt)}
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">
                        {o.side} {o.symbol}
                      </span>{' '}
                      <span className="text-xs text-muted-foreground">
                        {o.type}
                        {o.limitPrice && ` @ ${formatNumber(o.limitPrice)}`}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular">{formatQty(o.quantity)}</TableCell>
                    <TableCell className="text-right tabular">{formatQty(o.filledQuantity)}</TableCell>
                    <TableCell className="text-right tabular">
                      {o.avgFillPrice ? formatNumber(o.avgFillPrice, { dp: 4 }) : '—'}
                    </TableCell>
                    <TableCell>{o.mode === 'PAPER' ? 'Paper' : 'Live'}</TableCell>
                    <TableCell>
                      <OrderStatusBadge status={o.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{rows.length} loaded</span>
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
      )}
      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && <OrderDetail id={selected} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function OrderDetail({ id }: { id: string }) {
  const q = useOrder(id);
  if (q.isPending)
    return (
      <>
        <SheetHeader>
          <SheetTitle>Order</SheetTitle>
          <SheetDescription>Loading…</SheetDescription>
        </SheetHeader>
        <LoadingBlock rows={6} className="px-4" />
      </>
    );
  if (q.isError)
    return (
      <>
        <SheetHeader>
          <SheetTitle>Order</SheetTitle>
          <SheetDescription>Could not load this order.</SheetDescription>
        </SheetHeader>
        <ErrorState error={q.error} onRetry={() => void q.refetch()} className="mx-4" />
      </>
    );
  const o = q.data;
  const manual =
    o.mode === 'LIVE' &&
    ['AWAITING_MANUAL_PLACEMENT', 'PLACED_BY_USER', 'PARTIALLY_FILLED'].includes(o.status);
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex flex-wrap items-center gap-2">
          {o.side} {o.symbol} · {formatQty(o.quantity)} sh <OrderStatusBadge status={o.status} />
        </SheetTitle>
        <SheetDescription>
          {o.type}
          {o.limitPrice && ` @ ${formatNumber(o.limitPrice)}`} · {o.mode === 'PAPER' ? 'Paper' : 'Live'} ·
          origin {humanize(o.origin)} · created {formatDateTime(o.createdAt)}
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-6 px-4 pb-6">
        {o.referencePrice && (
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            Reference price <span className="tabular">{formatNumber(o.referencePrice.value)}</span>
            <ProvenanceBadge source={o.referencePrice.source} asOf={o.referencePrice.asOf} />
          </p>
        )}
        <EstimateSummary order={o} />
        {o.estimate && o.estimate.fees.length > 0 && (
          <FeeBreakdown lines={o.estimate.fees} total={o.estimate.totalFees} />
        )}
        {o.rejectionReason && <p className="text-sm text-destructive">Rejected: {o.rejectionReason}</p>}
        {o.brokerOrderRef && <p className="text-sm">KTrade reference: {o.brokerOrderRef}</p>}
        {manual ? (
          <ManualTicket order={o} />
        ) : (
          <section aria-label="Fills" className="space-y-2">
            <h3 className="text-sm font-medium">Fills</h3>
            <Executions order={o} />
          </section>
        )}
        <section aria-label="Risk checks" className="space-y-2">
          <h3 className="text-sm font-medium">Risk checks</h3>
          <RiskChecks checks={o.riskChecks} />
        </section>
        <section aria-label="Timeline" className="space-y-2">
          <h3 className="text-sm font-medium">Timeline</h3>
          {o.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded.</p>
          ) : (
            <ol className="relative space-y-3 border-l pl-4">
              {o.events.map((e) => (
                <li key={e.id} className="text-sm">
                  <span
                    className="absolute -left-1.5 mt-1.5 size-3 rounded-full border bg-background"
                    aria-hidden="true"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <OrderStatusBadge status={e.status} />
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(e.at)} · {humanize(e.actor)}
                    </span>
                  </div>
                  {e.note && <p className="text-xs text-muted-foreground">{e.note}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>
        {!FINAL.includes(o.status) && o.status !== 'CANCEL_REQUESTED' && <CancelOrder order={o} />}
      </div>
    </>
  );
}

function CancelOrder({ order }: { order: Order }) {
  const cancel = useCancelOrder();
  const atBroker = order.mode === 'LIVE' && AT_BROKER.includes(order.status);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <Ban aria-hidden="true" /> Cancel order
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
          <AlertDialogDescription>
            {atBroker
              ? 'You already placed this order in KTrade. Cancelling here only records your request: you must also cancel it in the KTrade app yourself. It shows “Cancel requested” until you record the outcome; any fills KTrade made still count.'
              : order.mode === 'LIVE'
                ? 'This order has not been placed in KTrade, so cancelling here is enough. Do not place it in KTrade afterwards.'
                : 'The paper order is cancelled. No real money is involved.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep order</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              cancel.mutate(order.id, {
                onSuccess: (o) =>
                  toast.success(
                    o.status === 'CANCEL_REQUESTED'
                      ? 'Cancel requested — now cancel it in the KTrade app'
                      : 'Order cancelled',
                  ),
                onError: (e) => toast.error(errorMessage(e)),
              })
            }
          >
            Cancel order
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
