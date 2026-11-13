'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { DataStamp, QuoteChange, QuotePrice, QuoteVolume } from '@/components/quote';
import { EmptyState, QueryState } from '@/components/states';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api/errors';
import { useWatchlistMutations, useWatchlists } from '@/lib/api/hooks';
import type { Watchlist } from '@/lib/api/types';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const SYMBOL_RE = /^[A-Z0-9.-]{1,12}$/;
const fail = (e: unknown) => toast.error(errorMessage(e));

export default function WatchlistsPage() {
  const query = useWatchlists();
  const m = useWatchlistMutations();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  function create(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    m.create.mutate(
      { name: n },
      {
        onSuccess: (w) => {
          setName('');
          setSelected(w.id);
          toast.success(`Created “${w.name}”`);
        },
        onError: fail,
      },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Watchlists" description="Up to 20 lists of up to 100 stocks, with live quotes." />
      <form onSubmit={create} className="flex max-w-md items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="new-watchlist">New watchlist</Label>
          <Input
            id="new-watchlist"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="e.g. Banks"
          />
        </div>
        <Button type="submit" disabled={!name.trim() || m.create.isPending}>
          <Plus aria-hidden="true" /> Create
        </Button>
      </form>
      <QueryState query={query} rows={6}>
        {(lists) =>
          lists.length === 0 ? (
            <EmptyState title="No watchlists yet" description="Create one above, then add symbols to it." />
          ) : (
            <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
              <nav aria-label="Your watchlists">
                <ul className="flex flex-wrap gap-1 lg:flex-col">
                  {lists.map((w) => {
                    const active = (selected ?? lists[0].id) === w.id;
                    return (
                      <li key={w.id}>
                        <Button
                          variant={active ? 'secondary' : 'ghost'}
                          className="w-full justify-between"
                          aria-current={active ? 'true' : undefined}
                          onClick={() => setSelected(w.id)}
                        >
                          <span className="truncate">{w.name}</span>
                          <span className="text-xs text-muted-foreground tabular">{w.items.length}</span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </nav>
              <WatchlistPanel
                key={(lists.find((w) => w.id === selected) ?? lists[0]).id}
                list={lists.find((w) => w.id === selected) ?? lists[0]}
                onDeleted={() => setSelected(null)}
              />
            </div>
          )
        }
      </QueryState>
    </div>
  );
}

function WatchlistPanel({ list, onDeleted }: { list: Watchlist; onDeleted: () => void }) {
  const m = useWatchlistMutations();
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState(list.name);
  const [symbol, setSymbol] = useState('');
  const symbolValid = SYMBOL_RE.test(symbol);
  const latest = list.items.reduce<string | null>(
    (acc, i) => (i.quote && (acc === null || i.quote.asOf > acc) ? i.quote.asOf : acc),
    null,
  );
  const sources = [...new Set(list.items.flatMap((i) => (i.quote ? [i.quote.source] : [])))];

  function rename(e: FormEvent) {
    e.preventDefault();
    m.rename.mutate(
      { id: list.id, name: newName.trim() },
      { onSuccess: () => setEditing(false), onError: fail },
    );
  }

  function add(e: FormEvent) {
    e.preventDefault();
    if (!symbolValid) return;
    m.addSymbol.mutate({ id: list.id, symbol }, { onSuccess: () => setSymbol(''), onError: fail });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        {editing ? (
          <form onSubmit={rename} className="flex items-center gap-2">
            <Label htmlFor="rename-watchlist" className="sr-only">
              Watchlist name
            </Label>
            <Input
              id="rename-watchlist"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={60}
              autoFocus
            />
            <Button type="submit" size="icon" aria-label="Save name" disabled={!newName.trim()}>
              <Check aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Cancel"
              onClick={() => setEditing(false)}
            >
              <X aria-hidden="true" />
            </Button>
          </form>
        ) : (
          <CardTitle className="flex items-center gap-2">
            {list.name}
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Rename ${list.name}`}
              onClick={() => setEditing(true)}
            >
              <Pencil aria-hidden="true" />
            </Button>
          </CardTitle>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm">
              <Trash2 aria-hidden="true" /> Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{list.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                The list and its {list.items.length} symbols are removed. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => m.remove.mutate(list.id, { onSuccess: onDeleted, onError: fail })}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={add} className="flex max-w-sm items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="add-symbol">Add symbol</Label>
            <Input
              id="add-symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase().trim())}
              placeholder="e.g. HUBC"
              maxLength={12}
              aria-invalid={symbol !== '' && !symbolValid}
            />
          </div>
          <Button type="submit" variant="secondary" disabled={!symbolValid || m.addSymbol.isPending}>
            <Plus aria-hidden="true" /> Add
          </Button>
        </form>
        {list.items.length === 0 ? (
          <EmptyState title="This watchlist is empty" description="Add a PSX symbol above." className="p-6" />
        ) : (
          <>
            <DataStamp
              source={sources.length === 1 ? sources[0] : null}
              asOf={latest}
              stale={list.items.some((i) => i.quote?.stale)}
            />
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead className="text-right">Last</TableHead>
                    <TableHead className="text-right">Change</TableHead>
                    <TableHead className="text-right">Volume</TableHead>
                    <TableHead className="text-right">As of</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.items.map((i) => (
                    <TableRow key={i.symbol} className={cn(i.quote?.stale && 'bg-amber-500/5')}>
                      <TableCell>
                        <Link
                          href={`/market/${encodeURIComponent(i.symbol)}`}
                          className="font-medium hover:underline"
                        >
                          {i.symbol}
                        </Link>
                        {i.quote?.name && (
                          <div className="max-w-[14rem] truncate text-xs text-muted-foreground">
                            {i.quote.name}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <QuotePrice quote={i.quote} />
                      </TableCell>
                      <TableCell className="text-right">
                        <QuoteChange quote={i.quote} />
                      </TableCell>
                      <TableCell className="text-right">
                        <QuoteVolume quote={i.quote} />
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {i.quote ? formatTime(i.quote.asOf) : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove ${i.symbol}`}
                          disabled={m.removeSymbol.isPending}
                          onClick={() =>
                            m.removeSymbol.mutate({ id: list.id, symbol: i.symbol }, { onError: fail })
                          }
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
