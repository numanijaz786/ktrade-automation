'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { DataStamp, QuoteChange, QuotePrice, QuoteVolume } from '@/components/quote';
import { EmptyState, QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useSectors, useStocks } from '@/lib/api/hooks';
import type { StockPage } from '@/lib/api/types';
import { formatTime } from '@/lib/format';

export const PAGE_SIZE = 25;
const ALL = '__all__';

export function StockExplorer() {
  const params = useSearchParams();
  const [draft, setDraft] = useState(params.get('q') ?? '');
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [sector, setSector] = useState(params.get('sector') ?? '');
  const [page, setPage] = useState(0);
  const sectors = useSectors();
  const query = useStocks({ search, sector, limit: PAGE_SIZE, offset: page * PAGE_SIZE });

  function submit(e: FormEvent) {
    e.preventDefault();
    setSearch(draft.trim());
    setPage(0);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock explorer"
        description="Every listed stock in the universe with its latest quote."
      />
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3" role="search">
        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-sm">
          <Label htmlFor="stock-search">Symbol or company</Label>
          <div className="flex gap-2">
            <Input
              id="stock-search"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. OGDC or Lucky"
              maxLength={60}
            />
            <Button type="submit" variant="outline" aria-label="Search">
              <Search aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sector-filter">Sector</Label>
          <Select
            value={sector || ALL}
            onValueChange={(v) => {
              setSector(v === ALL ? '' : v);
              setPage(0);
            }}
          >
            <SelectTrigger id="sector-filter" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sectors</SelectItem>
              {(sectors.data ?? []).map((s) => (
                <SelectItem key={s.sector} value={s.sector}>
                  {s.sector}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </form>
      <QueryState query={query} rows={10}>
        {(data) => <Results data={data} page={page} setPage={setPage} />}
      </QueryState>
    </div>
  );
}

function Results({ data, page, setPage }: { data: StockPage; page: number; setPage: (p: number) => void }) {
  if (data.total === 0)
    return <EmptyState title="No stocks match" description="Try a different symbol, name or sector." />;
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const stale = data.data.some((s) => s.quote?.stale);
  const latest = data.data.reduce<string | null>(
    (m, s) => (s.quote && (m === null || s.quote.asOf > m) ? s.quote.asOf : m),
    null,
  );
  const sources = [...new Set(data.data.flatMap((s) => (s.quote ? [s.quote.source] : [])))];
  return (
    <div className="space-y-3">
      <DataStamp source={sources.length === 1 ? sources[0] : null} asOf={latest} stale={stale} />
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Sector</TableHead>
              <TableHead className="text-right">Last</TableHead>
              <TableHead className="text-right">Change</TableHead>
              <TableHead className="text-right">Volume</TableHead>
              <TableHead className="text-right">As of</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.data.map((s) => (
              <TableRow key={s.symbol}>
                <TableCell>
                  <Link
                    href={`/market/${encodeURIComponent(s.symbol)}`}
                    className="font-medium hover:underline"
                  >
                    {s.symbol}
                  </Link>
                </TableCell>
                <TableCell className="max-w-[16rem] truncate">{s.name}</TableCell>
                <TableCell className="text-muted-foreground">{s.sector ?? '—'}</TableCell>
                <TableCell className="text-right">
                  <QuotePrice quote={s.quote} />
                </TableCell>
                <TableCell className="text-right">
                  <QuoteChange quote={s.quote} />
                </TableCell>
                <TableCell className="text-right">
                  <QuoteVolume quote={s.quote} />
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">
                  {s.quote ? formatTime(s.quote.asOf) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <nav aria-label="Pagination" className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">
          {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data.total)} of {data.total}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeft aria-hidden="true" /> Previous
          </Button>
          <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
            Next <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </nav>
    </div>
  );
}
