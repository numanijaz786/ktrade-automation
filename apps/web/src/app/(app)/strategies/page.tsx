'use client';

import { useState } from 'react';
import { Pencil, Play, Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Section } from '@/components/page-header';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { GenericStatus } from '@/components/status-badge';
import { StepUpDialog } from '@/components/step-up-dialog';
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
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api/errors';
import { useSignals, useStrategies, useStrategyMutations, useStrategyTemplates } from '@/lib/api/hooks';
import type { Strategy, StrategyTemplate } from '@/lib/api/types';
import { formatDateTime, formatNumber, humanize } from '@/lib/format';
import { useActivePortfolio } from '@/lib/portfolio-context';
import { StrategyForm } from './strategy-form';

const fail = (e: unknown) => toast.error(errorMessage(e));

export default function StrategiesPage() {
  const templates = useStrategyTemplates();
  const strategies = useStrategies();
  const { portfolios, portfolioId } = useActivePortfolio();
  const [editing, setEditing] = useState<Strategy | 'new' | null>(null);
  return (
    <div className="space-y-8">
      <PageHeader
        title="Strategies"
        description="Rule-based strategies on daily bars. Paper strategies may auto-execute simulated orders; live strategies only record signals for you to act on."
        actions={
          <Button size="sm" onClick={() => setEditing('new')} disabled={!templates.data}>
            <Plus aria-hidden="true" /> New strategy
          </Button>
        }
      />
      <Section title="Your strategies">
        <QueryState query={strategies} rows={4}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState
                title="No strategies yet"
                description="Start from a template below. New strategies are inactive until you activate them."
              />
            ) : (
              <StrategyTable list={list} onEdit={setEditing} />
            )
          }
        </QueryState>
      </Section>
      <Section title="Templates" description="Built-in strategies; their parameters generate the form.">
        <QueryState query={templates} rows={3}>
          {(ts) => <Templates templates={ts} />}
        </QueryState>
      </Section>
      <Signals />
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? 'New strategy' : 'Edit strategy'}</DialogTitle>
            <DialogDescription>
              {editing === 'new'
                ? 'Mode follows the portfolio: paper or live. Changing the definition later bumps its version.'
                : 'Changing the definition bumps the version; signals keep the version they came from.'}
            </DialogDescription>
          </DialogHeader>
          {editing !== null && templates.data && (
            <StrategyForm
              templates={templates.data}
              portfolios={portfolios}
              defaultPortfolioId={portfolioId}
              strategy={editing === 'new' ? undefined : editing}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Templates({ templates }: { templates: StrategyTemplate[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {templates.map((t) => (
        <Card key={t.type} className="gap-2 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">{t.label}</CardTitle>
            <CardDescription className="text-xs">{t.description}</CardDescription>
          </CardHeader>
          <p className="px-4 text-xs text-muted-foreground">
            {t.type === 'CUSTOM_RULES'
              ? 'Needs the rule DSL — not editable in this form yet.'
              : `${t.params.length} parameter${t.params.length === 1 ? '' : 's'}: ${t.params.map((p) => p.name).join(', ') || '—'}`}
          </p>
        </Card>
      ))}
    </div>
  );
}

function StrategyTable({ list, onEdit }: { list: Strategy[]; onEdit: (s: Strategy) => void }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table aria-label="Strategies">
        <TableHeader className="bg-muted/40">
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Symbol</TableHead>
            <TableHead>Template</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last evaluated</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((s) => (
            <StrategyRow key={s.id} s={s} onEdit={() => onEdit(s)} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StrategyRow({ s, onEdit }: { s: Strategy; onEdit: () => void }) {
  const m = useStrategyMutations();
  const [stepUp, setStepUp] = useState(false);
  const activate = () => {
    if (s.mode === 'LIVE') setStepUp(true);
    else m.setActive.mutate({ id: s.id, active: true }, { onError: fail });
  };
  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{s.name}</span>
        <span className="block text-xs text-muted-foreground">v{s.version}</span>
      </TableCell>
      <TableCell>{s.symbol}</TableCell>
      <TableCell>{humanize(s.type)}</TableCell>
      <TableCell>
        {s.mode === 'PAPER' ? 'Paper' : 'Live'}
        {s.autoExecute && <span className="block text-xs text-muted-foreground">auto-execute (paper)</span>}
      </TableCell>
      <TableCell>
        <GenericStatus value={s.active ? 'ACTIVE' : 'INACTIVE'} tone={s.active ? 'good' : 'neutral'} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{formatDateTime(s.lastEvaluatedAt)}</TableCell>
      <TableCell>
        <div className="flex flex-wrap justify-end gap-1">
          {s.active ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={m.evaluate.isPending}
                onClick={() =>
                  m.evaluate.mutate(s.id, {
                    onSuccess: (r) =>
                      toast.success(
                        r.signal
                          ? `${r.duplicate ? 'Already recorded' : 'New signal'}: ${r.signal.type} ${r.signal.symbol}`
                          : 'No signal at the latest bar',
                        { description: r.note ?? undefined },
                      ),
                    onError: fail,
                  })
                }
              >
                <Play aria-hidden="true" /> Evaluate now
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => m.setActive.mutate({ id: s.id, active: false }, { onError: fail })}
              >
                <PowerOff aria-hidden="true" /> Deactivate
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={activate}>
              <Power aria-hidden="true" /> Activate{s.mode === 'LIVE' && '…'}
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" aria-label={`Edit ${s.name}`} onClick={onEdit}>
            <Pencil aria-hidden="true" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Delete ${s.name}`}
                disabled={s.active}
                title={s.active ? 'Deactivate before deleting' : undefined}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete “{s.name}”?</AlertDialogTitle>
                <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => m.remove.mutate(s.id, { onError: fail })}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <StepUpDialog
          open={stepUp}
          onOpenChange={setStepUp}
          title="Activate live strategy"
          confirmLabel="Activate"
          description="Live strategies only record signals; they never place or approve orders. Activation needs a fresh confirmation."
          onVerified={(token) => m.setActive.mutateAsync({ id: s.id, active: true, stepUpToken: token })}
        />
      </TableCell>
    </TableRow>
  );
}

function Signals() {
  const q = useSignals();
  return (
    <Section title="Signals" description="Recorded at bar close by evaluations. A signal is not an order.">
      <QueryState query={q} rows={3}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState title="No signals yet" description="Activate a strategy and evaluate it." />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table aria-label="Signals">
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead>Bar</TableHead>
                    <TableHead>Strategy</TableHead>
                    <TableHead>Signal</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(g.barTs)}
                      </TableCell>
                      <TableCell>
                        {g.strategyName}
                        <span className="block text-xs text-muted-foreground">
                          {g.mode === 'PAPER' ? 'Paper' : 'Live'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">
                          {g.type} · {g.side} {g.symbol}
                        </span>
                        <span className="block text-xs text-muted-foreground">{humanize(g.reason)}</span>
                      </TableCell>
                      <TableCell className="text-right tabular">
                        <span className="inline-flex items-center gap-1">
                          {formatNumber(g.price.value)}
                          <ProvenanceBadge source={g.price.source} asOf={g.price.asOf} compact />
                        </span>
                      </TableCell>
                      <TableCell>
                        <GenericStatus value={g.status} tone={g.status === 'NEW' ? 'info' : 'neutral'} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        }
      </QueryState>
    </Section>
  );
}
