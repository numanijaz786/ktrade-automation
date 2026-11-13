'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { AlertFormDialog } from '@/components/alert-form';
import { InAppOnlyNote } from '@/components/notifications-bell';
import { PageHeader } from '@/components/page-header';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ALERT_META, describeAlert } from '@/lib/alerts';
import { errorMessage } from '@/lib/api/errors';
import { useAlertMutations, useAlerts, useMe } from '@/lib/api/hooks';
import type { Alert, AlertEvaluation } from '@/lib/api/types';
import { formatDateTime, humanize } from '@/lib/format';
import { useActivePortfolio } from '@/lib/portfolio-context';

const fail = (e: unknown) => toast.error(errorMessage(e));

export default function AlertsPage() {
  const alerts = useAlerts();
  const me = useMe();
  const isOwner = me.data?.role === 'OWNER';
  const m = useAlertMutations();
  const { portfolios, portfolioId } = useActivePortfolio();
  const [editing, setEditing] = useState<Alert | null>(null);
  const [creating, setCreating] = useState(false);
  const [lastRun, setLastRun] = useState<AlertEvaluation | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alerts"
        description="Price, change, volume, daily-loss and stop-loss alerts. Checked every minute while the market is open."
        actions={
          isOwner && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={m.evaluate.isPending}
                onClick={() =>
                  m.evaluate.mutate(undefined, {
                    onSuccess: (r) => {
                      setLastRun(r);
                      toast.success(`Evaluated ${r.evaluated} alert(s); ${r.fired.length} fired`);
                    },
                    onError: fail,
                  })
                }
              >
                <Play aria-hidden="true" /> Evaluate now
              </Button>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus aria-hidden="true" /> New alert
              </Button>
            </>
          )
        }
      />
      <InAppOnlyNote />
      {lastRun && <EvaluationResult r={lastRun} />}
      <QueryState query={alerts} rows={5}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState
              title="No alerts yet"
              description="Create one here, or use “Create price alert” on any stock page."
              action={
                isOwner && (
                  <Button size="sm" onClick={() => setCreating(true)}>
                    <Plus aria-hidden="true" /> New alert
                  </Button>
                )
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table aria-label="Alerts">
                <TableHeader>
                  <TableRow>
                    <TableHead>Alert</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Condition</TableHead>
                    <TableHead>Delivery</TableHead>
                    <TableHead>Last triggered</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead className="sr-only">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">{ALERT_META[a.type].label}</TableCell>
                      <TableCell>
                        {a.symbol && (
                          <Link href={`/market/${encodeURIComponent(a.symbol)}`} className="hover:underline">
                            {a.symbol}
                          </Link>
                        )}
                        {a.symbol && a.portfolio && ' · '}
                        {a.portfolio && <span className="text-muted-foreground">{a.portfolio.name}</span>}
                      </TableCell>
                      <TableCell className="tabular">{describeAlert(a)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {a.channels
                          .map((c) => (c === 'IN_APP' ? 'In-app' : `${humanize(c)} (not configured)`))
                          .join(', ')}
                        <br />
                        {a.triggerOnce ? 'Once' : `Every ${a.cooldownMinutes} min while true`}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {a.lastTriggeredAt ? formatDateTime(a.lastTriggeredAt) : 'Never'}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={a.active}
                          disabled={!isOwner || m.update.isPending}
                          aria-label={`${a.active ? 'Deactivate' : 'Activate'} ${ALERT_META[a.type].label}${a.symbol ? ` ${a.symbol}` : ''}`}
                          onCheckedChange={(active) =>
                            m.update.mutate({ id: a.id, patch: { active } }, { onError: fail })
                          }
                        />
                        {!a.active && a.triggerOnce && a.lastTriggeredAt && (
                          <Badge variant="secondary" className="ml-2">
                            Fired
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {isOwner && (
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Edit ${ALERT_META[a.type].label}`}
                              onClick={() => setEditing(a)}
                            >
                              <Pencil aria-hidden="true" />
                            </Button>
                            <DeleteAlert a={a} onDelete={() => m.remove.mutate(a.id, { onError: fail })} />
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        }
      </QueryState>
      <AlertFormDialog
        open={creating}
        onOpenChange={setCreating}
        portfolios={portfolios}
        defaultPortfolioId={portfolioId}
      />
      <AlertFormDialog
        key={editing?.id ?? 'none'}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        alert={editing ?? undefined}
        portfolios={portfolios}
      />
    </div>
  );
}

function DeleteAlert({ a, onDelete }: { a: Alert; onDelete: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Delete ${ALERT_META[a.type].label}`}>
          <Trash2 aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this alert?</AlertDialogTitle>
          <AlertDialogDescription>
            {ALERT_META[a.type].label}
            {a.symbol ? ` · ${a.symbol}` : ''} — {describeAlert(a)}. Past notifications are kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onDelete}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EvaluationResult({ r }: { r: AlertEvaluation }) {
  const skipped = Object.entries(r.skipped);
  return (
    <Card>
      <CardContent className="space-y-1 py-3 text-sm" role="status">
        <p>
          <span className="font-medium">Evaluated {r.evaluated} active alert(s)</span> at{' '}
          {formatDateTime(r.evaluatedAt)} · {r.fired.length} fired
        </p>
        {r.fired.length > 0 && (
          <ul className="list-inside list-disc text-muted-foreground">
            {r.fired.map((f) => (
              <li key={f.alertId}>
                {humanize(f.type)}: {f.observed}
              </li>
            ))}
          </ul>
        )}
        {skipped.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Not fired: {skipped.map(([reason, n]) => `${humanize(reason)} ${n}`).join(' · ')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
