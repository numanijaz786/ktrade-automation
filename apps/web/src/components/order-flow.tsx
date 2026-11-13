'use client';

import { useState, type FormEvent } from 'react';
import { CheckCircle2, ClipboardCopy, Clock, FlaskConical, Hand, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useNow } from '@/hooks/use-now';
import { errorMessage } from '@/lib/api/errors';
import { useMarkPlaced, useRecordFill } from '@/lib/api/hooks';
import type { Order } from '@/lib/api/types';
import { Dec } from '@/lib/decimal';
import { formatDateTime, formatNumber, formatPKR, formatQty, humanize } from '@/lib/format';
import { ProvenanceBadge } from './provenance-badge';
import { OrderStatusBadge } from './status-badge';

const WHOLE = /^\d{1,12}$/;
const PRICE = /^\d{1,10}(\.\d{1,4})?$/;

/** "4:59" until the preview's approval window closes; null once expired. */
export function useCountdown(until: string | null): { label: string | null; expired: boolean } {
  const now = useNow(1000);
  if (!until || now === null) return { label: null, expired: false };
  const ms = new Date(until).getTime() - now;
  if (ms <= 0) return { label: null, expired: true };
  const s = Math.ceil(ms / 1000);
  return { label: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, expired: false };
}

export function PreviewExpiry({ until }: { until: string | null }) {
  const { label, expired } = useCountdown(until);
  if (expired)
    return (
      <span className="inline-flex items-center gap-1 text-sm font-medium text-destructive" role="status">
        <Clock className="size-4" aria-hidden="true" /> Preview expired — preview again
      </span>
    );
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1 text-sm tabular" role="timer" aria-live="off">
      <Clock className="size-4" aria-hidden="true" /> Approve within {label}
    </span>
  );
}

/** What was actually filled. Nothing is shown as executed without a recorded fill. */
export function Executions({ order }: { order: Order }) {
  if (!order.executions.length)
    return (
      <p className="text-sm text-muted-foreground" data-testid="no-fills">
        No fill recorded yet — this order has not executed.
      </p>
    );
  return (
    <table className="w-full text-sm tabular" aria-label="Fills">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="py-1">Executed</th>
          <th className="py-1 text-right">Qty</th>
          <th className="py-1 text-right">Price</th>
          <th className="py-1">Source</th>
        </tr>
      </thead>
      <tbody>
        {order.executions.map((x) => (
          <tr key={x.id} className="border-t">
            <td className="py-1 text-xs">{formatDateTime(x.executedAt)}</td>
            <td className="py-1 text-right">{formatQty(x.quantity)}</td>
            <td className="py-1 text-right">{formatNumber(x.price, { dp: 4 })}</td>
            <td className="py-1">
              <ProvenanceBadge source={x.source} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ticketText(o: Order): string {
  return [
    `${o.side} ${o.symbol}`,
    `Quantity: ${o.quantity} shares`,
    `Order type: ${o.type}`,
    o.limitPrice ? `Limit price: Rs ${o.limitPrice}` : null,
    `Validity: DAY`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** LIVE manual ticket: the exact order to place in the KTrade app, then "I placed it" and "Record fill". */
export function ManualTicket({ order }: { order: Order }) {
  const markPlaced = useMarkPlaced();
  const [ref, setRef] = useState('');
  const awaiting = order.status === 'AWAITING_MANUAL_PLACEMENT';
  const canFill = ['AWAITING_MANUAL_PLACEMENT', 'PLACED_BY_USER', 'PARTIALLY_FILLED'].includes(order.status);
  async function copy() {
    try {
      await navigator.clipboard.writeText(ticketText(order));
      toast.success('Order details copied');
    } catch {
      toast.error('Could not copy — select the details and copy them manually');
    }
  }
  return (
    <Card className="border-amber-600/40" data-testid="manual-ticket">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Hand className="size-4" aria-hidden="true" /> Place this exact order in the KTrade app
        </CardTitle>
        <CardDescription>
          This platform never sends live orders to KTrade. Enter these details yourself, then record what
          happened. Nothing counts as executed until you record a fill.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Side</dt>
            <dd className="text-base font-semibold">{order.side}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Symbol</dt>
            <dd className="text-base font-semibold">{order.symbol}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Quantity</dt>
            <dd className="text-base font-semibold tabular">{formatQty(order.quantity)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Type</dt>
            <dd className="text-base font-semibold">
              {order.type}
              {order.limitPrice && <span className="tabular"> @ Rs {formatNumber(order.limitPrice)}</span>}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
            <ClipboardCopy aria-hidden="true" /> Copy details
          </Button>
          <OrderStatusBadge status={order.status} />
          <span className="text-xs text-muted-foreground tabular">
            Filled {formatQty(order.filledQuantity)} of {formatQty(order.quantity)}
          </span>
        </div>
        {awaiting && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              markPlaced.mutate(
                { orderId: order.id, brokerOrderRef: ref.trim() || undefined },
                {
                  onSuccess: () =>
                    toast.success('Marked as placed — record the fill when you see it in KTrade'),
                  onError: (err) => toast.error(errorMessage(err)),
                },
              );
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`ref-${order.id}`}>KTrade order reference (optional)</Label>
              <Input
                id={`ref-${order.id}`}
                value={ref}
                maxLength={64}
                onChange={(e) => setRef(e.target.value)}
                className="w-56"
              />
            </div>
            <Button type="submit" disabled={markPlaced.isPending}>
              {markPlaced.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}I placed it
            </Button>
          </form>
        )}
        {canFill && <RecordFillForm order={order} />}
        <Executions order={order} />
      </CardContent>
    </Card>
  );
}

const fillSchema = z.object({
  quantity: z
    .string()
    .regex(WHOLE, 'Whole shares only')
    .refine((v) => /[1-9]/.test(v), 'Must be at least 1'),
  price: z
    .string()
    .regex(PRICE, 'Enter a price like 152.35')
    .refine((v) => /[1-9]/.test(v), 'Must be greater than zero'),
  executedAt: z.string().min(1, 'When did it execute?'),
});

/** Record a fill seen in KTrade (USER_REPORTED until a contract note confirms it). */
export function RecordFillForm({ order }: { order: Order }) {
  const record = useRecordFill();
  const remaining = Dec.of(order.quantity).sub(order.filledQuantity);
  const [quantity, setQuantity] = useState(remaining.toString());
  const [price, setPrice] = useState(order.limitPrice ?? '');
  const [executedAt, setExecutedAt] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  function submit(e: FormEvent) {
    e.preventDefault();
    const r = fillSchema.safeParse({ quantity, price, executedAt });
    const errs: Record<string, string> = {};
    if (!r.success) for (const i of r.error.issues) errs[String(i.path[0])] ??= i.message;
    if (!errs.quantity && Dec.of(quantity).gt(remaining))
      errs.quantity = `At most ${remaining.toString()} remaining`;
    const at = new Date(executedAt);
    if (!errs.executedAt && Number.isNaN(at.getTime())) errs.executedAt = 'Invalid date/time';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    record.mutate(
      { orderId: order.id, quantity, price, executedAt: at.toISOString() },
      {
        onSuccess: (o) => {
          toast.success(o.status === 'FILLED' ? 'Fill recorded — order filled' : 'Partial fill recorded');
          setExecutedAt('');
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  }
  const field = (id: string) => ({
    'aria-invalid': !!errors[id],
    'aria-describedby': errors[id] ? `fill-${id}-err-${order.id}` : undefined,
  });
  return (
    <form onSubmit={submit} noValidate className="space-y-2 rounded-lg border p-3" aria-label="Record fill">
      <p className="text-sm font-medium">Record fill</p>
      <p className="text-xs text-muted-foreground">
        Enter what KTrade shows as executed. It is stored as Manual (user-reported) with estimated fees until
        a contract note confirms it.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`fill-qty-${order.id}`}>Filled quantity</Label>
          <Input
            id={`fill-qty-${order.id}`}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.trim())}
            {...field('quantity')}
          />
          {errors.quantity && (
            <p id={`fill-quantity-err-${order.id}`} className="text-xs text-destructive">
              {errors.quantity}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor={`fill-price-${order.id}`}>Fill price (Rs)</Label>
          <Input
            id={`fill-price-${order.id}`}
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value.trim())}
            {...field('price')}
          />
          {errors.price && (
            <p id={`fill-price-err-${order.id}`} className="text-xs text-destructive">
              {errors.price}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor={`fill-at-${order.id}`}>Executed at (your local time)</Label>
          <Input
            id={`fill-at-${order.id}`}
            type="datetime-local"
            value={executedAt}
            onChange={(e) => setExecutedAt(e.target.value)}
            {...field('executedAt')}
          />
          {errors.executedAt && (
            <p id={`fill-executedAt-err-${order.id}`} className="text-xs text-destructive">
              {errors.executedAt}
            </p>
          )}
        </div>
      </div>
      <Button type="submit" variant="secondary" size="sm" disabled={record.isPending}>
        {record.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
        Record fill
      </Button>
    </form>
  );
}

/** After approval: PAPER shows its simulated result; LIVE shows the manual ticket. */
export function OrderResult({ order }: { order: Order }) {
  if (order.mode === 'LIVE') return <ManualTicket order={order} />;
  const filled = order.executions.length > 0;
  return (
    <Card data-testid="paper-result">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {filled ? (
            <CheckCircle2 className="size-4 text-gain" aria-hidden="true" />
          ) : (
            <FlaskConical className="size-4" aria-hidden="true" />
          )}
          Paper order {filled ? humanize(order.status).toLowerCase() : 'working'}
          <OrderStatusBadge status={order.status} />
        </CardTitle>
        <CardDescription>
          {filled
            ? 'Simulated fill against the latest quote with paper slippage. No real money moved.'
            : 'Not filled: the limit price is not marketable yet. It stays working until it fills or you cancel it.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {order.avgFillPrice && (
          <p className="text-sm tabular">
            Average fill {formatNumber(order.avgFillPrice, { dp: 4 })} · filled{' '}
            {formatQty(order.filledQuantity)} of {formatQty(order.quantity)}
          </p>
        )}
        <Executions order={order} />
      </CardContent>
    </Card>
  );
}

export function EstimateSummary({ order }: { order: Order }) {
  const e = order.estimate;
  if (!e) return <p className="text-sm text-muted-foreground">No estimate available.</p>;
  return (
    <dl className="grid grid-cols-3 gap-2 text-sm tabular">
      <div>
        <dt className="text-xs text-muted-foreground">Notional</dt>
        <dd>{formatPKR(e.notional)}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Fees (est.)</dt>
        <dd className="inline-flex items-center gap-1">
          {formatPKR(e.totalFees)} <ProvenanceBadge source="ESTIMATED" compact />
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">
          {order.side === 'BUY' ? 'Cash needed' : 'Net proceeds'}
        </dt>
        <dd className="inline-flex items-center gap-1 font-medium">
          {formatPKR(e.total)} <ProvenanceBadge source="ESTIMATED" compact />
        </dd>
      </div>
    </dl>
  );
}
