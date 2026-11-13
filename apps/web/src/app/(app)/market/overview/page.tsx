'use client';

import Link from 'next/link';
import { AlertTriangle, CircleDot, CircleOff } from 'lucide-react';
import { PageHeader, Section } from '@/components/page-header';
import { PnlText } from '@/components/money';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { DataStamp, QuoteChange, QuotePrice, QuoteVolume } from '@/components/quote';
import { StatTile } from '@/components/stat-tile';
import { EmptyState, QueryState } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMarketOverview } from '@/lib/api/hooks';
import type { MarketOverview, Quote } from '@/lib/api/types';
import { formatDate, formatNumber } from '@/lib/format';

export default function MarketOverviewPage() {
  const query = useMarketOverview();
  return (
    <div className="space-y-8">
      <PageHeader
        title="Market overview"
        description="PSX session, breadth, top movers and sectors from the active market-data provider."
      />
      <QueryState query={query} rows={8}>
        {(o) => <Overview o={o} />}
      </QueryState>
    </div>
  );
}

function Overview({ o }: { o: MarketOverview }) {
  if (o.breadth.total === 0)
    return (
      <EmptyState
        title="No quotes yet"
        description="The stock universe has no prices. Seed reference data or import end-of-day prices first."
      />
    );
  const source = o.dataSource ?? undefined;
  return (
    <>
      <DataStamp source={o.dataSource} asOf={o.asOf} className="-mt-5" />
      {o.staleQuotes > 0 && (
        <Alert>
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>
            {o.staleQuotes} of {o.breadth.total} quotes are stale
          </AlertTitle>
          <AlertDescription>
            They are older than the current session allows and are marked “Stale” below. Do not trade on them.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Session"
          icon={o.session.open ? <CircleDot className="size-3.5" /> : <CircleOff className="size-3.5" />}
          value={o.session.open ? 'Open' : 'Closed'}
          hint={
            <>
              {o.session.hours}
              {o.session.lastCompletedSession &&
                ` · last session ${formatDate(o.session.lastCompletedSession)}`}
              {!o.session.tradingDay && ' · not a trading day'}
            </>
          }
        />
        <StatTile
          label="Breadth"
          source={source}
          asOf={o.asOf ?? undefined}
          value={
            <span>
              <span className="text-gain">▲ {o.breadth.advancers}</span>{' '}
              <span className="text-loss">▼ {o.breadth.decliners}</span>
            </span>
          }
          hint={`${o.breadth.unchanged} unchanged · ${o.breadth.total} stocks`}
        />
        <StatTile
          label="Total volume"
          source={source}
          asOf={o.asOf ?? undefined}
          value={formatNumber(o.totalVolume, { dp: 0 })}
          hint="shares, all quoted stocks"
        />
        <StatTile
          label="Data provider"
          source={source}
          value={<span className="text-base">{o.providerKey}</span>}
          hint={o.staleQuotes ? `${o.staleQuotes} stale quotes` : 'all quotes current'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <MoversTable title="Top gainers" quotes={o.gainers} empty="No advancing stocks" />
        <MoversTable title="Top losers" quotes={o.losers} empty="No declining stocks" />
        <MoversTable title="Most active" quotes={o.mostActive} empty="No volume yet" />
      </div>

      <Section
        title="Sectors"
        description="Average change is the simple mean of each sector's stock changes."
      >
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sector</TableHead>
                <TableHead className="text-right">Stocks</TableHead>
                <TableHead className="text-right">Adv / Dec</TableHead>
                <TableHead className="text-right">Avg change</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {o.sectors.map((s) => (
                <TableRow key={s.sector}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/market?sector=${encodeURIComponent(s.sector)}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {s.sector}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular">{s.stocks}</TableCell>
                  <TableCell className="text-right tabular">
                    {s.advancers} / {s.decliners}
                  </TableCell>
                  <TableCell className="text-right">
                    {s.avgChangePct === null ? '—' : <PnlText value={s.avgChangePct} percent />}
                  </TableCell>
                  <TableCell className="text-right tabular">{formatNumber(s.volume, { dp: 0 })}</TableCell>
                  <TableCell>
                    <ProvenanceBadge source={s.source} compact />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>
    </>
  );
}

function MoversTable({ title, quotes, empty }: { title: string; quotes: Quote[]; empty: string }) {
  return (
    <Section title={title}>
      {quotes.length === 0 ? (
        <EmptyState title={empty} className="p-6" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead className="text-right">Last</TableHead>
                <TableHead className="text-right">Change</TableHead>
                <TableHead className="text-right">Volume</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quotes.map((q) => (
                <TableRow key={q.symbol}>
                  <TableCell>
                    <Link
                      href={`/market/${encodeURIComponent(q.symbol)}`}
                      className="font-medium hover:underline"
                    >
                      {q.symbol}
                    </Link>
                    {q.name && (
                      <div className="max-w-[10rem] truncate text-xs text-muted-foreground">{q.name}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <QuotePrice quote={q} />
                  </TableCell>
                  <TableCell className="text-right">
                    <QuoteChange quote={q} />
                  </TableCell>
                  <TableCell className="text-right">
                    <QuoteVolume quote={q} />
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
