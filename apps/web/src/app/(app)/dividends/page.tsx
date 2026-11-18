'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Calculator, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Section } from '@/components/page-header';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { EmptyState, QueryState } from '@/components/states';
import { StatusPill } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api/errors';
import {
  useDividendDeclarations,
  useDividendEntitlements,
  useDividendMutations,
  useMe,
} from '@/lib/api/hooks';
import type { DividendComputeResult, DividendDeclaration, DividendEntitlement } from '@/lib/api/types';
import { formatDate, humanize } from '@/lib/format';
import { useActivePortfolio } from '@/lib/portfolio-context';
import { DeclarationFormDialog } from './declaration-form';
import { EntitlementsTable } from './entitlements-table';
import { IncomeSummary } from './income-summary';
import { MarkPaidDialog } from './mark-paid-dialog';
import { TAX_SETUP_HELP, formatDps } from './shared';

const fail = (e: unknown) => toast.error(errorMessage(e));
const LOCKED_HELP =
  'An entitlement of this dividend has been paid, so its terms are a settled fact and can no longer be edited or deleted.';

export default function DividendsPage() {
  const me = useMe();
  const isOwner = me.data?.role === 'OWNER';
  const { portfolio, portfolioId } = useActivePortfolio();
  const declarations = useDividendDeclarations();
  const entitlements = useDividendEntitlements(portfolioId);
  const m = useDividendMutations();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DividendDeclaration | null>(null);
  const [paying, setPaying] = useState<DividendEntitlement | null>(null);
  const [lastCompute, setLastCompute] = useState<DividendComputeResult | null>(null);
  const computeShown = lastCompute && lastCompute.portfolioId === portfolioId ? lastCompute : null;

  const rows = entitlements.data?.data ?? [];
  const needsTaxSetup = rows.some(
    (e) => e.taxStatus === 'NOT_CONFIGURED' || e.taxStatus === 'RECOMPUTE_REQUIRED',
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dividends"
        description="Cash dividends you are entitled to, what was paid, and the withholding deducted."
        actions={
          isOwner && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={!portfolioId || m.compute.isPending}
                onClick={() =>
                  portfolioId &&
                  m.compute.mutate(portfolioId, {
                    onSuccess: (r) => {
                      setLastCompute(r);
                      toast.success(
                        `Entitlements computed: ${r.counts.created} new, ${r.counts.updated} updated, ${r.counts.unchanged} unchanged`,
                      );
                    },
                    onError: fail,
                  })
                }
              >
                <Calculator aria-hidden="true" /> Compute entitlements
              </Button>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus aria-hidden="true" /> Record dividend
              </Button>
            </>
          )
        }
      />

      <IncomeSummary rows={rows} loading={entitlements.isPending} />

      {computeShown && <ComputeNote r={computeShown} />}

      {needsTaxSetup && (
        <Alert data-testid="tax-setup-note">
          <AlertTitle>Withholding tax not estimated</AlertTitle>
          <AlertDescription>
            <p>
              {TAX_SETUP_HELP}{' '}
              <Link href="/settings" className="underline">
                Go to Settings
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      )}

      <Section
        title={`Entitlements${portfolio ? ` · ${portfolio.name}` : ''}`}
        description="Shares settled strictly before each book-closure start. Estimates until you mark them paid."
      >
        <QueryState query={entitlements} rows={4}>
          {(list) =>
            list.data.length === 0 ? (
              <EmptyState
                title="No entitlements yet"
                description={
                  isOwner
                    ? 'Record the dividend declarations for stocks you hold, then compute entitlements.'
                    : 'Nothing has been computed for this portfolio yet.'
                }
              />
            ) : (
              <EntitlementsTable
                rows={list.data}
                isOwner={isOwner}
                onMarkPaid={setPaying}
                reconciling={m.reconcile.isPending}
                onReconcile={(e, statementRef) =>
                  m.reconcile.mutate(
                    { id: e.id, input: statementRef.trim() ? { statementRef: statementRef.trim() } : {} },
                    {
                      onSuccess: () => toast.success(`${e.symbol} dividend reconciled`),
                      onError: fail,
                    },
                  )
                }
              />
            )
          }
        </QueryState>
      </Section>

      <Section title="Declarations" description="Cash-dividend announcements, shared by all portfolios.">
        <QueryState query={declarations} rows={4}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState
                title="No dividends recorded"
                description="Record a declaration from the company’s PSX announcement."
                action={
                  isOwner && (
                    <Button size="sm" onClick={() => setCreating(true)}>
                      <Plus aria-hidden="true" /> Record dividend
                    </Button>
                  )
                }
              />
            ) : (
              <DeclarationsTable
                rows={list}
                isOwner={isOwner}
                onEdit={setEditing}
                onDelete={(d) =>
                  m.remove.mutate(d.id, {
                    onSuccess: () => toast.success(`${d.symbol} dividend deleted`),
                    onError: fail,
                  })
                }
              />
            )
          }
        </QueryState>
      </Section>

      <DeclarationFormDialog open={creating} onOpenChange={setCreating} />
      <DeclarationFormDialog
        key={editing?.id ?? 'none'}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        declaration={editing ?? undefined}
      />
      <MarkPaidDialog entitlement={paying} onOpenChange={(o) => !o && setPaying(null)} />
    </div>
  );
}

function ComputeNote({ r }: { r: DividendComputeResult }) {
  const c = r.counts;
  return (
    <Alert data-testid="settlement-note">
      <AlertTitle>
        Settlement assumption: T+{r.settlement.days}{' '}
        {r.settlement.basis === 'DEFAULT' ? '(default — confirm it)' : '(from system settings)'}
      </AlertTitle>
      <AlertDescription>
        <p>{r.settlement.note}</p>
        <p className="text-xs">
          {c.created} created · {c.updated} updated · {c.unchanged} unchanged · {c.removed} removed ·{' '}
          {c.skippedSettled} already paid · {c.notEligible} not eligible · filer status{' '}
          {humanize(r.filerStatus)}
        </p>
      </AlertDescription>
    </Alert>
  );
}

function DeclarationsTable({
  rows,
  isOwner,
  onEdit,
  onDelete,
}: {
  rows: DividendDeclaration[];
  isOwner: boolean;
  onEdit: (d: DividendDeclaration) => void;
  onDelete: (d: DividendDeclaration) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table aria-label="Dividend declarations">
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead>Announcement</TableHead>
            <TableHead>Book closure</TableHead>
            <TableHead>Payment date</TableHead>
            <TableHead className="text-right">DPS</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="sr-only">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => (
            <TableRow key={d.id}>
              <TableCell className="font-medium">
                <Link href={`/market/${encodeURIComponent(d.symbol)}`} className="hover:underline">
                  {d.symbol}
                </Link>
                {d.companyName && <div className="text-xs text-muted-foreground">{d.companyName}</div>}
              </TableCell>
              <TableCell className="text-xs">{formatDate(d.announcementDate)}</TableCell>
              <TableCell className="text-xs whitespace-nowrap">
                {formatDate(d.bookClosureFrom)}
                {d.bookClosureTo &&
                  d.bookClosureTo !== d.bookClosureFrom &&
                  ` – ${formatDate(d.bookClosureTo)}`}
              </TableCell>
              <TableCell className="text-xs">{formatDate(d.paymentDate)}</TableCell>
              <TableCell className="text-right tabular">{formatDps(d.dividendPerShare)}</TableCell>
              <TableCell>
                <ProvenanceBadge source={d.source} />
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  {d.locked && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" className="cursor-help" aria-label={`Locked. ${LOCKED_HELP}`}>
                          <StatusPill tone="neutral" icon={Lock}>
                            Locked
                          </StatusPill>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-64">{LOCKED_HELP}</TooltipContent>
                    </Tooltip>
                  )}
                  {isOwner && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={d.locked}
                        title={d.locked ? LOCKED_HELP : undefined}
                        aria-label={`Edit ${d.symbol} dividend${d.locked ? ' (locked)' : ''}`}
                        onClick={() => onEdit(d)}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                      <DeleteDeclaration d={d} onDelete={() => onDelete(d)} />
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function DeleteDeclaration({ d, onDelete }: { d: DividendDeclaration; onDelete: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={d.locked}
          title={d.locked ? LOCKED_HELP : undefined}
          aria-label={`Delete ${d.symbol} dividend${d.locked ? ' (locked)' : ''}`}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the {d.symbol} dividend?</AlertDialogTitle>
          <AlertDialogDescription>
            Book closure {formatDate(d.bookClosureFrom)}, {formatDps(d.dividendPerShare)} per share. Its
            estimated entitlements in every portfolio are removed too.
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
