'use client';

import { useState, type FormEvent } from 'react';
import { AlertTriangle, Loader2, RotateCcw, ShieldCheck, ShieldX } from 'lucide-react';
import { z } from 'zod';
import type { OrderSide } from '@ktrade/shared';
import { EstimateSummary, OrderResult, PreviewExpiry, useCountdown } from '@/components/order-flow';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { OrderStatusBadge } from '@/components/status-badge';
import { StepUpDialog } from '@/components/step-up-dialog';
import { FeeBreakdown, KillSwitchNotice, RiskChecks } from '@/components/trading';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage } from '@/lib/api/errors';
import { useApproveOrder, useKillSwitch, useOrder, usePreviewOrder, useStocks } from '@/lib/api/hooks';
import type { Order, OrderType } from '@/lib/api/types';
import { formatNumber, humanize } from '@/lib/format';
import { useActivePortfolio } from '@/lib/portfolio-context';

/** Client-side validation mirroring the API's preview schema (the API re-validates everything). */
export const ticketSchema = z
  .object({
    portfolioId: z.string().min(1, 'Pick a portfolio'),
    symbol: z
      .string()
      .min(1, 'Enter a symbol')
      .max(12)
      .regex(/^[A-Z0-9.-]+$/, 'Use the PSX symbol, e.g. HUBC'),
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['MARKET', 'LIMIT']),
    quantity: z
      .string()
      .min(1, 'Enter a quantity')
      .regex(/^\d{1,12}$/, 'Whole shares only')
      .refine((v) => /[1-9]/.test(v), 'Must be at least 1 share'),
    limitPrice: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'LIMIT') {
      if (!v.limitPrice)
        ctx.addIssue({ code: 'custom', path: ['limitPrice'], message: 'A limit price is required' });
      else if (!/^\d{1,10}(\.\d{1,4})?$/.test(v.limitPrice) || !/[1-9]/.test(v.limitPrice))
        ctx.addIssue({ code: 'custom', path: ['limitPrice'], message: 'Enter a positive price like 152.35' });
    }
  });

type Errors = Partial<Record<'portfolioId' | 'symbol' | 'quantity' | 'limitPrice', string>>;

export interface TicketPrefill {
  symbol?: string;
  side?: OrderSide;
  quantity?: string;
  limitPrice?: string;
}

/** Reads `?symbol=&side=&qty=&type=&limit=` (from the advisor). Anything that fails validation is ignored. */
export function parsePrefill(params: { get(name: string): string | null }): TicketPrefill {
  const symbol = (params.get('symbol') ?? '').trim().toUpperCase();
  const side = params.get('side');
  const qty = params.get('qty') ?? '';
  const limit = params.get('limit') ?? '';
  const out: TicketPrefill = {};
  if (/^[A-Z0-9.-]{1,12}$/.test(symbol)) out.symbol = symbol;
  if (side === 'BUY' || side === 'SELL') out.side = side;
  if (/^\d{1,12}$/.test(qty) && /[1-9]/.test(qty)) out.quantity = qty;
  if (params.get('type') === 'LIMIT' && /^\d{1,10}(\.\d{1,4})?$/.test(limit) && /[1-9]/.test(limit))
    out.limitPrice = limit;
  return out;
}

export function OrderTicket({ onReset, prefill }: { onReset: () => void; prefill?: TicketPrefill }) {
  const { portfolioId: activeId, portfolios } = useActivePortfolio();
  // Follows the active portfolio (which may load after mount) until the user picks one here.
  const [picked, setPortfolioId] = useState<string | null>(null);
  const portfolioId = picked ?? activeId ?? '';
  const [symbol, setSymbol] = useState(prefill?.symbol ?? '');
  const [side, setSide] = useState<OrderSide>(prefill?.side ?? 'BUY');
  const [type, setType] = useState<Extract<OrderType, 'MARKET' | 'LIMIT'>>(
    prefill?.limitPrice ? 'LIMIT' : 'MARKET',
  );
  const [quantity, setQuantity] = useState(prefill?.quantity ?? '');
  const [limitPrice, setLimitPrice] = useState(prefill?.limitPrice ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [orderId, setOrderId] = useState<string | null>(null);
  const preview = usePreviewOrder();
  const killSwitch = useKillSwitch();
  const portfolio = portfolios.find((p) => p.id === portfolioId);
  const live = portfolio?.kind === 'LIVE';
  const liveBlocked = live && killSwitch.data?.liveTradingEnabled === false;

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = ticketSchema.safeParse({
      portfolioId,
      symbol,
      side,
      type,
      quantity,
      limitPrice: type === 'LIMIT' ? limitPrice : undefined,
    });
    if (!r.success) {
      const errs: Errors = {};
      for (const i of r.error.issues) errs[i.path[0] as keyof Errors] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    preview.mutate(
      {
        ...r.data,
        limitPrice: r.data.type === 'LIMIT' ? r.data.limitPrice : undefined,
        origin: 'MANUAL',
        // One key per ticket submission: a network retry of this request can never create a second order.
        idempotencyKey: crypto.randomUUID(),
      },
      { onSuccess: (o) => setOrderId(o.id) },
    );
  }

  if (orderId) return <PreviewAndApprove orderId={orderId} onReset={onReset} />;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,28rem)_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Order ticket</CardTitle>
          <CardDescription>Nothing is sent anywhere until you approve the preview.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} noValidate className="space-y-4" aria-label="Order ticket">
            <div className="space-y-1.5">
              <Label htmlFor="ticket-portfolio">Portfolio</Label>
              <Select value={portfolioId} onValueChange={setPortfolioId}>
                <SelectTrigger id="ticket-portfolio" className="w-full" aria-invalid={!!errors.portfolioId}>
                  <SelectValue placeholder="Pick a portfolio" />
                </SelectTrigger>
                <SelectContent>
                  {portfolios.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {p.kind === 'PAPER' ? 'Paper' : 'Live'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.portfolioId && <FieldError>{errors.portfolioId}</FieldError>}
            </div>
            <SymbolField value={symbol} onChange={setSymbol} error={errors.symbol} />
            <Segmented label="Side" value={side} options={['BUY', 'SELL'] as const} onChange={setSide} />
            <Segmented
              label="Order type"
              value={type}
              options={['MARKET', 'LIMIT'] as const}
              onChange={setType}
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ticket-qty">Quantity (shares)</Label>
                <Input
                  id="ticket-qty"
                  inputMode="numeric"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value.trim())}
                  aria-invalid={!!errors.quantity}
                  aria-describedby={errors.quantity ? 'ticket-qty-err' : undefined}
                />
                {errors.quantity && <FieldError id="ticket-qty-err">{errors.quantity}</FieldError>}
              </div>
              {type === 'LIMIT' && (
                <div className="space-y-1.5">
                  <Label htmlFor="ticket-limit">Limit price (Rs)</Label>
                  <Input
                    id="ticket-limit"
                    inputMode="decimal"
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value.trim())}
                    aria-invalid={!!errors.limitPrice}
                    aria-describedby={errors.limitPrice ? 'ticket-limit-err' : undefined}
                  />
                  {errors.limitPrice && <FieldError id="ticket-limit-err">{errors.limitPrice}</FieldError>}
                </div>
              )}
            </div>
            {preview.isError && (
              <Alert variant="destructive">
                <AlertTriangle aria-hidden="true" />
                <AlertTitle>Preview failed</AlertTitle>
                <AlertDescription>{errorMessage(preview.error)}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="w-full" disabled={preview.isPending}>
              {preview.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              Preview order
            </Button>
          </form>
        </CardContent>
      </Card>
      <div className="space-y-4">
        <ExecutionInfo live={live} />
        {liveBlocked && <KillSwitchNotice />}
      </div>
    </div>
  );
}

function ExecutionInfo({ live }: { live: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{live ? 'Live portfolio' : 'Paper portfolio'}</CardTitle>
        <CardDescription>
          {live
            ? 'After approval you get a manual ticket: place the exact order in the KTrade app, mark it placed, then record the fill. The platform never places live orders itself.'
            : 'Paper orders fill immediately against the latest quote with simulated slippage. Everything is labelled Simulated.'}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function FieldError({ id, children }: { id?: string; children: string }) {
  return (
    <p id={id} className="text-xs text-destructive" role="alert">
      {children}
    </p>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label={label}>
        {options.map((o) => (
          <Button
            key={o}
            type="button"
            size="sm"
            variant={value === o ? 'default' : 'ghost'}
            aria-pressed={value === o}
            onClick={() => onChange(o)}
          >
            {humanize(o)}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

function SymbolField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const [focused, setFocused] = useState(false);
  const search = useStocks({ search: value || undefined, limit: 6 });
  const matches = (search.data?.data ?? []).filter((s) => s.symbol !== value);
  return (
    <div className="relative space-y-1.5">
      <Label htmlFor="ticket-symbol">Symbol</Label>
      <Input
        id="ticket-symbol"
        value={value}
        autoComplete="off"
        placeholder="e.g. HUBC"
        maxLength={12}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onChange={(e) => onChange(e.target.value.toUpperCase().trim())}
        aria-invalid={!!error}
        aria-describedby={error ? 'ticket-symbol-err' : undefined}
      />
      {error && <FieldError id="ticket-symbol-err">{error}</FieldError>}
      {focused && value && matches.length > 0 && (
        <ul
          className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border bg-popover shadow-md"
          aria-label="Matching stocks"
        >
          {matches.map((s) => (
            <li key={s.symbol}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(s.symbol);
                  setFocused(false);
                }}
              >
                <span>
                  <span className="font-medium">{s.symbol}</span>{' '}
                  <span className="text-xs text-muted-foreground">{s.name}</span>
                </span>
                {s.quote && (
                  <span className="inline-flex items-center gap-1 text-xs tabular">
                    {formatNumber(s.quote.last)}
                    <ProvenanceBadge source={s.quote.source} compact />
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PreviewAndApprove({ orderId, onReset }: { orderId: string; onReset: () => void }) {
  const order = useOrder(orderId);
  if (!order.data) return null;
  return <PreviewCard order={order.data} onReset={onReset} />;
}

function PreviewCard({ order, onReset }: { order: Order; onReset: () => void }) {
  const approve = useApproveOrder();
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const { expired } = useCountdown(order.previewExpiresAt);
  const previewed = order.status === 'PREVIEWED';
  const rejected = order.status === 'REJECTED_BY_RISK';
  const killSwitchFailed = order.riskChecks.some((c) => c.rule === 'KILL_SWITCH' && !c.passed);
  const approvedOrLater = !previewed && !rejected && order.status !== 'EXPIRED';
  return (
    <div className="space-y-6">
      <Card data-testid="order-preview">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {order.side} {order.symbol} · {formatNumber(order.quantity, { dp: 0 })} shares · {order.type}
              {order.limitPrice && ` @ ${formatNumber(order.limitPrice)}`}
              <OrderStatusBadge status={order.status} />
            </CardTitle>
            <CardDescription>
              {order.mode === 'PAPER' ? 'Paper (simulated)' : 'Live'} · execution path{' '}
              <span className="font-medium" data-testid="execution-path">
                {order.executionPath === 'MANUAL_TICKET'
                  ? 'Manual ticket (you place it in KTrade)'
                  : order.executionPath === 'PAPER_AUTO'
                    ? 'Paper auto-fill'
                    : humanize(order.executionPath)}
              </span>
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onReset}>
            <RotateCcw aria-hidden="true" /> New ticket
          </Button>
        </CardHeader>
        <CardContent className="space-y-5">
          {order.referencePrice && (
            <p className="flex flex-wrap items-center gap-1.5 text-sm">
              Reference price{' '}
              <span className="font-medium tabular">{formatNumber(order.referencePrice.value)}</span>
              <ProvenanceBadge source={order.referencePrice.source} asOf={order.referencePrice.asOf} />
              <span className="text-xs text-muted-foreground">
                (the price the estimate and risk checks used)
              </span>
            </p>
          )}
          <EstimateSummary order={order} />
          {order.estimate && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Fee breakdown (estimated)</h3>
              <FeeBreakdown lines={order.estimate.fees} total={order.estimate.totalFees} />
            </div>
          )}
          <div>
            <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
              {rejected ? (
                <ShieldX className="size-4 text-destructive" aria-hidden="true" />
              ) : (
                <ShieldCheck className="size-4 text-gain" aria-hidden="true" />
              )}
              Risk checks ({order.riskChecks.filter((c) => c.passed).length}/{order.riskChecks.length} passed)
            </h3>
            <RiskChecks checks={order.riskChecks} />
          </div>
          {order.warnings.map((w) => (
            <p key={w} className="text-xs text-muted-foreground">
              {w}
            </p>
          ))}
          {rejected && (
            <Alert variant="destructive" data-testid="risk-rejected">
              <ShieldX aria-hidden="true" />
              <AlertTitle>Rejected by risk checks — this order cannot be approved</AlertTitle>
              <AlertDescription>
                {order.rejectionReason ? `Failed: ${order.rejectionReason}. ` : ''}Adjust the ticket and
                preview again.
              </AlertDescription>
            </Alert>
          )}
          {killSwitchFailed && <KillSwitchNotice />}
          {previewed && (
            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <Button
                onClick={() => setStepUpOpen(true)}
                disabled={expired || approve.isPending || !order.previewHash}
              >
                Approve order…
              </Button>
              <PreviewExpiry until={order.previewExpiresAt} />
            </div>
          )}
          {approve.isError && (
            <Alert variant="destructive">
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>Approval failed</AlertTitle>
              <AlertDescription>{errorMessage(approve.error)}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        title="Approve order"
        confirmLabel="Approve"
        description={
          <>
            {order.side} {formatNumber(order.quantity, { dp: 0 })} {order.symbol} ({order.type}
            {order.limitPrice ? ` @ ${order.limitPrice}` : ''}) in a{' '}
            {order.mode === 'PAPER' ? 'paper' : 'LIVE'} portfolio. Approval is bound to this exact preview;
            risk checks run again.
          </>
        }
        onVerified={(token) =>
          approve.mutateAsync({ orderId: order.id, previewHash: order.previewHash!, stepUpToken: token })
        }
      />
      {approvedOrLater && <OrderResult order={order} />}
    </div>
  );
}
