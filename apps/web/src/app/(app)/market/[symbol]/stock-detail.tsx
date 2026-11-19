'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, BellPlus, Star } from 'lucide-react';
import { toast } from 'sonner';
import { AlertFormDialog } from '@/components/alert-form';
import { CandleChart } from '@/components/candle-chart';
import { PageHeader, Section } from '@/components/page-header';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { DataStamp, QuoteChange, QuotePrice } from '@/components/quote';
import { StatTile } from '@/components/stat-tile';
import { QueryState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage } from '@/lib/api/errors';
import { useCandles, useMe, useStock, useWatchlistMutations, useWatchlists } from '@/lib/api/hooks';
import type { StockDetail } from '@/lib/api/types';
import { formatNumber } from '@/lib/format';
import { useActivePortfolio } from '@/lib/portfolio-context';

const RANGES = [
  { key: '3M', days: 92 },
  { key: '6M', days: 183 },
  { key: '1Y', days: 365 },
  { key: '2Y', days: 730 },
] as const;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function StockDetailView() {
  const { symbol: raw } = useParams<{ symbol: string }>();
  const symbol = decodeURIComponent(raw ?? '').toUpperCase();
  const stock = useStock(symbol);
  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/market">
          <ArrowLeft aria-hidden="true" /> Stock explorer
        </Link>
      </Button>
      <QueryState query={stock} rows={8}>
        {(s) => <Detail s={s} />}
      </QueryState>
    </div>
  );
}

function Detail({ s }: { s: StockDetail }) {
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('6M');
  const [from] = useState(() => Object.fromEntries(RANGES.map((r) => [r.key, daysAgoIso(r.days)])));
  const candles = useCandles(s.symbol, from[range]);
  const q = s.quote;
  return (
    <>
      <PageHeader
        title={`${s.symbol} · ${s.name}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {s.sector ?? 'Unclassified'}
            {s.isShariah && <Badge variant="secondary">Shariah-compliant</Badge>}
            {s.faceValue && <span>Face value Rs {formatNumber(s.faceValue)}</span>}
          </span>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/research/${encodeURIComponent(s.symbol)}`}>Advisor research</Link>
            </Button>
            <CreatePriceAlert symbol={s.symbol} />
            <AddToWatchlist symbol={s.symbol} />
          </>
        }
      />
      <DataStamp source={q?.source} asOf={q?.asOf} stale={q?.stale} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Last price"
          value={<QuotePrice quote={q} compact={false} />}
          delta={<QuoteChange quote={q} />}
          hint={q?.delayMinutes ? `${q.delayMinutes} min delay` : undefined}
        />
        <StatTile
          label="Day range"
          source={q?.source}
          asOf={q?.asOf}
          value={q?.low && q?.high ? `${formatNumber(q.low)} – ${formatNumber(q.high)}` : '—'}
          hint={
            q?.open ? `Open ${formatNumber(q.open)} · prev close ${formatNumber(q.prevClose)}` : undefined
          }
        />
        <StatTile
          label="52-week range"
          source={s.stats.historySource ?? undefined}
          value={
            s.stats.week52Low && s.stats.week52High
              ? `${formatNumber(s.stats.week52Low)} – ${formatNumber(s.stats.week52High)}`
              : '—'
          }
          hint={`${s.stats.sessions} stored sessions`}
        />
        <StatTile
          label="Volume"
          source={q?.source}
          asOf={q?.asOf}
          value={q?.volume ? formatNumber(q.volume, { dp: 0 }) : '—'}
          hint={
            s.stats.avgVolume20d ? `20-day avg ${formatNumber(s.stats.avgVolume20d, { dp: 0 })}` : undefined
          }
        />
      </div>
      {s.stats.historySources.length > 1 && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          History mixes sources:
          {s.stats.historySources.map((src) => (
            <ProvenanceBadge key={src} source={src} />
          ))}
          — 52-week figures carry the weakest one.
        </p>
      )}
      <Section
        title="Daily price"
        actions={
          <div role="group" aria-label="Chart range" className="flex gap-1">
            {RANGES.map((r) => (
              <Button
                key={r.key}
                size="sm"
                variant={range === r.key ? 'secondary' : 'ghost'}
                aria-pressed={range === r.key}
                onClick={() => setRange(r.key)}
              >
                {r.key}
              </Button>
            ))}
          </div>
        }
      >
        <QueryState query={candles} rows={6}>
          {(c) => <CandleChart symbol={s.symbol} candles={c.candles} />}
        </QueryState>
      </Section>
    </>
  );
}

/** Shortcut: a PRICE_ABOVE alert pre-filled with this symbol (type can be changed in the form). OWNER only. */
function CreatePriceAlert({ symbol }: { symbol: string }) {
  const me = useMe();
  const { portfolios, portfolioId } = useActivePortfolio();
  const [open, setOpen] = useState(false);
  if (me.data?.role !== 'OWNER') return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <BellPlus aria-hidden="true" /> Create price alert
      </Button>
      <AlertFormDialog
        open={open}
        onOpenChange={setOpen}
        portfolios={portfolios}
        defaultPortfolioId={portfolioId}
        defaultType="PRICE_ABOVE"
        defaultSymbol={symbol}
      />
    </>
  );
}

function AddToWatchlist({ symbol }: { symbol: string }) {
  const lists = useWatchlists();
  const m = useWatchlistMutations();
  const [target, setTarget] = useState<string>('');
  const options = lists.data ?? [];
  const chosen = target || options[0]?.id || '';
  if (lists.isError) return null;
  if (!options.length)
    return (
      <Button variant="outline" size="sm" asChild>
        <Link href="/watchlists">
          <Star aria-hidden="true" /> Create a watchlist
        </Link>
      </Button>
    );
  const already = options.find((w) => w.id === chosen)?.items.some((i) => i.symbol === symbol);
  return (
    <div className="flex items-center gap-2">
      <Select value={chosen} onValueChange={setTarget}>
        <SelectTrigger size="sm" aria-label="Watchlist" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        disabled={already || m.addSymbol.isPending}
        onClick={() =>
          m.addSymbol.mutate(
            { id: chosen, symbol },
            {
              onSuccess: (w) => toast.success(`${symbol} added to ${w.name}`),
              onError: (e) => toast.error(errorMessage(e)),
            },
          )
        }
      >
        <Star aria-hidden="true" /> {already ? 'On watchlist' : 'Add to watchlist'}
      </Button>
    </div>
  );
}
