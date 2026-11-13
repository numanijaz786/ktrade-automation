'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, FlaskConical, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Section } from '@/components/page-header';
import { LineChart } from '@/components/line-chart';
import { PnlText } from '@/components/money';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { StatTile } from '@/components/stat-tile';
import { OrderStatusBadge } from '@/components/status-badge';
import { EmptyState, ErrorState, LoadingBlock, QueryState } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api/errors';
import {
  useCreatePaperPortfolio,
  useDashboardCharts,
  useDashboardSummary,
  useHoldings,
  useOrders,
} from '@/lib/api/hooks';
import type { DashboardSummary, Holding, SourcedValue } from '@/lib/api/types';
import { Dec } from '@/lib/decimal';
import { formatDateTime, formatPercent, formatPKR, formatQty } from '@/lib/format';
import { useActivePortfolio } from '@/lib/portfolio-context';

export default function DashboardPage() {
  const { portfolioId, portfolio, portfolios, setPortfolioId } = useActivePortfolio();
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-8">
      <PageHeader
        title="Dashboard"
        description={
          portfolio
            ? `${portfolio.name} · ${portfolio.kind === 'PAPER' ? 'Paper (simulated money)' : 'Live (KTrade account)'}`
            : 'Your portfolios at a glance.'
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" /> New paper portfolio
          </Button>
        }
      />
      <CreatePaperDialog open={creating} onOpenChange={setCreating} onCreated={setPortfolioId} />
      {!portfolioId ? (
        <EmptyState
          title={portfolios.length ? 'Pick a portfolio' : 'No portfolios yet'}
          description="Create a paper portfolio to practise with simulated money, or register your KTrade account on the KTrade integration page."
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" /> New paper portfolio
            </Button>
          }
        />
      ) : (
        <Dashboard portfolioId={portfolioId} />
      )}
    </div>
  );
}

function Dashboard({ portfolioId }: { portfolioId: string }) {
  const summary = useDashboardSummary(portfolioId);
  const holdings = useHoldings(portfolioId);
  return (
    <>
      <QueryState query={summary} rows={4}>
        {(s) => <Kpis s={s} />}
      </QueryState>
      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="Allocation" description="Weight of each holding in priced market value.">
          <Card>
            <CardContent className="pt-4">
              {holdings.isPending ? (
                <LoadingBlock rows={4} />
              ) : holdings.isError ? (
                <ErrorState error={holdings.error} onRetry={() => void holdings.refetch()} />
              ) : (
                <Allocation holdings={holdings.data} />
              )}
            </CardContent>
          </Card>
        </Section>
        <Performance portfolioId={portfolioId} />
      </div>
      <RecentOrders portfolioId={portfolioId} />
    </>
  );
}

/** A figure the API cannot compute yet is null and is shown as such — never zero-filled. */
function NotYet({ note }: { note?: string }) {
  return (
    <span className="text-base font-normal text-muted-foreground" title={note}>
      Not available yet
    </span>
  );
}

function sourced(v: SourcedValue | null, signed = false) {
  if (!v) return <NotYet />;
  return signed ? <PnlText value={v.value} showIcon={false} /> : formatPKR(v.value);
}

function Kpis({ s }: { s: DashboardSummary }) {
  const feesTaxes = Dec.of(s.feesPaid.value).add(s.taxesPaid.value).toString();
  return (
    <div className="space-y-3">
      {s.unpricedHoldings ? (
        <Alert>
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>{s.unpricedHoldings} holding(s) have no market price</AlertTitle>
          <AlertDescription>They are excluded from market value and unrealised P&L.</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="kpis">
        <StatTile
          label="Account value"
          value={formatPKR(s.accountValue.value)}
          source={s.accountValue.source}
          breakdown={s.accountValue.sourceBreakdown}
          hint="Cash + priced holdings"
        />
        <StatTile
          label="Invested (cost basis)"
          value={formatPKR(s.investedAmount.value)}
          source={s.investedAmount.source}
          hint={<>Market value {formatPKR(s.marketValue.value)}</>}
        />
        <StatTile
          label="Cash (ledger)"
          value={formatPKR(s.cash.ledger.value)}
          source={s.cash.ledger.source}
          hint={
            s.cash.broker ? (
              <span className="inline-flex items-center gap-1">
                Broker cash {formatPKR(s.cash.broker.value)}
                <ProvenanceBadge source={s.cash.broker.source} asOf={s.cash.broker.asOf} compact />
              </span>
            ) : (
              'No broker cash statement yet'
            )
          }
        />
        <StatTile
          label="Total return"
          value={
            s.totalReturnPct ? (
              <PnlText value={s.totalReturnPct.value} percent showIcon={false} />
            ) : (
              <NotYet />
            )
          }
          source={s.totalReturnPct?.source}
          hint="Simple return on net deposits"
        />
        <StatTile
          label="Realised P&L"
          value={<PnlText value={s.realizedPnl.value} showIcon={false} />}
          source={s.realizedPnl.source}
        />
        <StatTile
          label="Unrealised P&L"
          value={<PnlText value={s.unrealizedPnl.value} showIcon={false} />}
          source={s.unrealizedPnl.source}
          hint="At the latest quotes"
        />
        <StatTile
          label="Today’s P&L"
          value={sourced(s.todayPnl, true)}
          source={s.todayPnl?.source}
          hint={s.todayPnl ? undefined : 'Needs daily snapshots'}
        />
        <StatTile
          label="This month’s P&L"
          value={sourced(s.monthPnl, true)}
          source={s.monthPnl?.source}
          hint={s.monthPnl ? undefined : 'Needs daily snapshots'}
        />
        <StatTile
          label="Dividends received"
          value={formatPKR(s.dividendsReceived.value)}
          source={s.dividendsReceived.source}
        />
        <StatTile
          label="Fees & taxes paid"
          value={formatPKR(feesTaxes)}
          source={s.feesPaid.source}
          hint={
            <>
              Fees {formatPKR(s.feesPaid.value)} · taxes {formatPKR(s.taxesPaid.value)}
            </>
          }
        />
        <StatTile
          label="Active holdings"
          value={String(s.activeHoldings)}
          hint={
            <Link href="/holdings" className="underline-offset-2 hover:underline">
              View holdings
            </Link>
          }
        />
        <StatTile
          label="Pending orders"
          value={String(s.pendingOrders)}
          hint={
            <Link href="/orders" className="underline-offset-2 hover:underline">
              View orders
            </Link>
          }
        />
      </div>
    </div>
  );
}

const MAX_BARS = 8;

/** Weight bars: magnitude by length, value labelled directly (no colour encoding needed for one series). */
function Allocation({ holdings }: { holdings: Holding[] }) {
  const priced = holdings.filter((h) => h.weight !== null).sort((a, b) => Dec.of(b.weight!).cmp(a.weight!));
  if (!priced.length)
    return <EmptyState title="No priced holdings" description="Buy a stock to see your allocation." />;
  const top = priced.slice(0, MAX_BARS);
  const rest = priced.slice(MAX_BARS);
  const rows = [
    ...top.map((h) => ({ key: h.symbol, label: h.symbol, weight: h.weight!, value: h.marketValue })),
    ...(rest.length
      ? [
          {
            key: '__other',
            label: `Other (${rest.length})`,
            weight: Dec.sum(rest.map((h) => h.weight!)).toString(),
            value: Dec.sum(rest.map((h) => h.marketValue ?? '0')).toString(),
          },
        ]
      : []),
  ];
  const max = Dec.of(rows[0].weight);
  const sources = [...new Set(priced.flatMap((h) => (h.lastPrice ? [h.lastPrice.source] : [])))];
  return (
    <figure className="space-y-3">
      <ul className="space-y-2" aria-label="Allocation by holding">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate font-medium">{r.label}</span>
            <span className="h-2.5 rounded-full bg-muted" aria-hidden="true">
              <span
                className="block h-full rounded-full bg-chart-1"
                style={{ width: `${Dec.of(r.weight).div(max).mul(100).toFixed(2)}%` }}
              />
            </span>
            <span className="text-right text-xs tabular">
              {formatPercent(r.weight, { fraction: true, dp: 1 })}
              <span className="block text-muted-foreground">{formatPKR(r.value, { compact: true })}</span>
            </span>
          </li>
        ))}
      </ul>
      <figcaption className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        Valued at last prices:
        {sources.map((s) => (
          <ProvenanceBadge key={s} source={s} />
        ))}
        {priced.length < holdings.length &&
          ` · ${holdings.length - priced.length} unpriced holding(s) excluded`}
      </figcaption>
    </figure>
  );
}

function Performance({ portfolioId }: { portfolioId: string }) {
  const charts = useDashboardCharts(portfolioId, '3M');
  return (
    <Section title="Performance" description="Portfolio value over the last 3 months.">
      <Card>
        <CardContent className="pt-4">
          {charts.isPending ? (
            <LoadingBlock rows={5} />
          ) : charts.isError ? (
            <ErrorState error={charts.error} onRetry={() => void charts.refetch()} />
          ) : (
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Source: <ProvenanceBadge source={charts.data.source} />
              </p>
              <LineChart
                label="Portfolio value"
                seriesName="Value"
                series={charts.data.performance.map((p) => ({ t: p.date, value: p.value }))}
                formatValue={(v) => formatPKR(v)}
                height={240}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </Section>
  );
}

function RecentOrders({ portfolioId }: { portfolioId: string }) {
  const orders = useOrders({ portfolioId, limit: 5 });
  const rows = orders.data?.pages[0]?.data ?? [];
  return (
    <Section
      title="Recent orders"
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link href="/orders">All orders</Link>
        </Button>
      }
    >
      {orders.isPending ? (
        <LoadingBlock rows={3} />
      ) : orders.isError ? (
        <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No orders yet"
          action={
            <Button size="sm" asChild>
              <Link href="/trade">Buy / Sell</Link>
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table aria-label="Recent orders">
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Order</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Filled</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(o.createdAt)}
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">
                      {o.side} {o.symbol}
                    </span>{' '}
                    <span className="text-xs text-muted-foreground">
                      {o.type}
                      {o.mode === 'PAPER' && ' · paper'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular">{formatQty(o.quantity)}</TableCell>
                  <TableCell className="text-right tabular">{formatQty(o.filledQuantity)}</TableCell>
                  <TableCell>
                    <OrderStatusBadge status={o.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}

function CreatePaperDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreatePaperPortfolio();
  const [name, setName] = useState('Paper portfolio');
  const [cash, setCash] = useState('1000000');
  const cashOk = /^\d{1,13}(\.\d{1,2})?$/.test(cash) && /[1-9]/.test(cash);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !cashOk) return;
    create.mutate(
      { name: name.trim(), initialCash: cash },
      {
        onSuccess: (p) => {
          toast.success(`Created “${p.name}”`);
          onCreated(p.id);
          onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="size-4" aria-hidden="true" /> New paper portfolio
            </DialogTitle>
            <DialogDescription>
              Simulated money only: every figure in it is labelled Simulated. Default risk limits apply.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="paper-name">Name</Label>
            <Input id="paper-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="paper-cash">Starting cash (Rs)</Label>
            <Input
              id="paper-cash"
              inputMode="decimal"
              value={cash}
              aria-invalid={!cashOk}
              onChange={(e) => setCash(e.target.value.trim())}
            />
            {!cashOk && <p className="text-xs text-destructive">Enter a positive amount (max 2 decimals).</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || !cashOk || create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
