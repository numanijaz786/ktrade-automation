'use client';

import { useState } from 'react';
import { BadgeCheck, Banknote } from 'lucide-react';
import { Money } from '@/components/money';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { StatusPill } from '@/components/status-badge';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { DividendEntitlement } from '@/lib/api/types';
import { formatDate, formatQty } from '@/lib/format';
import { EntitlementStatus, TaxNotConfigured, TaxStatusPill } from './shared';

const PAYABLE = new Set(['ANNOUNCED', 'ENTITLED']);

/** WHT / net: a figure only when a verified rate applied or it was recorded as paid; otherwise "not configured". */
function TaxFigure({ e, value }: { e: DividendEntitlement; value: string | null }) {
  if (value === null) return <TaxNotConfigured note={e.taxNote} status={e.taxStatus} />;
  return <Money value={value} />;
}

export function EntitlementsTable({
  rows,
  isOwner,
  onMarkPaid,
  onReconcile,
  reconciling,
}: {
  rows: DividendEntitlement[];
  isOwner: boolean;
  onMarkPaid: (e: DividendEntitlement) => void;
  onReconcile: (e: DividendEntitlement, statementRef: string) => void;
  reconciling?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table aria-label="Dividend entitlements">
        <TableHeader>
          <TableRow>
            <TableHead>Stock</TableHead>
            <TableHead>Book closure</TableHead>
            <TableHead className="text-right">Eligible shares</TableHead>
            <TableHead className="text-right">Gross</TableHead>
            <TableHead className="text-right">WHT</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Tax</TableHead>
            <TableHead className="sr-only">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((e) => (
            <TableRow key={e.id} data-testid={`entitlement-${e.symbol}`}>
              <TableCell className="font-medium">{e.symbol}</TableCell>
              <TableCell className="text-xs whitespace-nowrap">
                {formatDate(e.bookClosureFrom)}
                {e.bookClosureTo &&
                  e.bookClosureTo !== e.bookClosureFrom &&
                  ` – ${formatDate(e.bookClosureTo)}`}
                {e.provisional && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="ml-1.5 cursor-help align-middle">
                        <StatusPill tone="warn">Provisional</StatusPill>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">
                      Book closure has not started: holdings may still change. Compute again after it starts.
                    </TooltipContent>
                  </Tooltip>
                )}
              </TableCell>
              <TableCell className="text-right tabular">{formatQty(e.sharesEligible)}</TableCell>
              <TableCell className="text-right">
                <Money value={e.grossAmount} />
              </TableCell>
              <TableCell className="text-right">
                <TaxFigure e={e} value={e.whtAmount} />
              </TableCell>
              <TableCell className="text-right">
                <TaxFigure e={e} value={e.netAmount} />
              </TableCell>
              <TableCell>
                <EntitlementStatus status={e.status} />
                {e.paidAt && (
                  <div className="mt-0.5 text-xs text-muted-foreground">{formatDate(e.paidAt)}</div>
                )}
              </TableCell>
              <TableCell>
                <ProvenanceBadge source={e.source} />
              </TableCell>
              <TableCell>
                <TaxStatusPill status={e.taxStatus} />
              </TableCell>
              <TableCell>
                {isOwner && (
                  <div className="flex justify-end gap-1">
                    {PAYABLE.has(e.status) && (
                      <Button size="sm" variant="outline" onClick={() => onMarkPaid(e)}>
                        <Banknote aria-hidden="true" /> Mark paid
                      </Button>
                    )}
                    {e.status === 'PAID' && (
                      <ReconcileButton
                        e={e}
                        disabled={reconciling}
                        onConfirm={(ref) => onReconcile(e, ref)}
                      />
                    )}
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ReconcileButton({
  e,
  disabled,
  onConfirm,
}: {
  e: DividendEntitlement;
  disabled?: boolean;
  onConfirm: (statementRef: string) => void;
}) {
  const [ref, setRef] = useState('');
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <BadgeCheck aria-hidden="true" /> Reconcile
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reconcile the {e.symbol} dividend?</AlertDialogTitle>
          <AlertDialogDescription>
            Confirm that the payment (net Rs {e.netAmount ?? '—'} on {formatDate(e.paidAt)}) matches your
            broker or CDC statement. The entitlement and its cash movement become Confirmed. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <Label htmlFor={`rc-${e.id}`}>Statement reference (optional)</Label>
          <Input id={`rc-${e.id}`} value={ref} maxLength={120} onChange={(ev) => setRef(ev.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm(ref)}>Reconcile</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
