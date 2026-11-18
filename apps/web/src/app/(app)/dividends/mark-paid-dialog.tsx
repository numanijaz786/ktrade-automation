'use client';

import { useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Money, PnlText } from '@/components/money';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { validateMarkPaidForm, type FormErrors, type MarkPaidFormValues } from '@/lib/api/dividends-rules';
import { errorMessage } from '@/lib/api/errors';
import { useDividendMutations } from '@/lib/api/hooks';
import type { DividendEntitlement, DividendMarkPaidResult } from '@/lib/api/types';
import { Dec } from '@/lib/decimal';
import { formatDate, formatQty } from '@/lib/format';
import { useNow } from '@/hooks/use-now';
import { Field, TaxNotConfigured, formatDps, pktDate } from './shared';

/**
 * Record a dividend payment. The withholding deducted is REQUIRED and taken from the payment advice —
 * never inferred from the cash received (ADR-031). After saving, the API's reconciliation of the
 * figures (differences, unexplained difference, warnings) stays on screen.
 */
export function MarkPaidDialog({
  entitlement,
  onOpenChange,
  today,
}: {
  entitlement: DividendEntitlement | null;
  onOpenChange: (open: boolean) => void;
  /** Override for tests; defaults to today in PKT (read from the clock outside render). */
  today?: string;
}) {
  const now = useNow(60_000);
  const day = today ?? (now === null ? null : pktDate(now));
  return (
    <Dialog open={!!entitlement} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Mark {entitlement?.symbol} dividend paid</DialogTitle>
          <DialogDescription>
            Enter the figures from the payment advice. One cash movement is recorded for the net received.
          </DialogDescription>
        </DialogHeader>
        {entitlement && day && (
          <MarkPaidForm
            key={entitlement.id}
            entitlement={entitlement}
            today={day}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function MarkPaidForm({
  entitlement: e,
  today,
  onClose,
}: {
  entitlement: DividendEntitlement;
  today: string;
  onClose: () => void;
}) {
  const m = useDividendMutations();
  const [v, setV] = useState<MarkPaidFormValues>({
    paidAt: e.paymentDate && e.paymentDate <= today ? e.paymentDate : today,
    netAmount: '',
    whtAmount: '',
    zakatAmount: '',
  });
  const [errors, setErrors] = useState<FormErrors<MarkPaidFormValues>>({});
  const [result, setResult] = useState<DividendMarkPaidResult | null>(null);
  const set = (k: keyof MarkPaidFormValues, val: string) => setV((p) => ({ ...p, [k]: val }));

  if (result) return <MarkPaidResultView r={result} onClose={onClose} />;

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const r = validateMarkPaidForm(v, { today, grossAmount: e.grossAmount });
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    m.markPaid.mutate(
      { id: e.id, input: r.input },
      {
        onSuccess: (res) => {
          setResult(res);
          if (Dec.of(res.unexplainedDifference).isZero()) toast.success(`${e.symbol} dividend marked paid`);
          else toast.warning(`${e.symbol} marked paid — the figures do not add up; review the difference`);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Mark dividend paid">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
        <dt className="text-muted-foreground">Eligible shares</dt>
        <dd className="text-right tabular">{formatQty(e.sharesEligible)}</dd>
        <dt className="text-muted-foreground">Dividend per share</dt>
        <dd className="text-right tabular">{formatDps(e.dividendPerShare)}</dd>
        <dt className="text-muted-foreground">Gross (estimate)</dt>
        <dd className="text-right">
          <Money value={e.grossAmount} source={e.source} />
        </dd>
        <dt className="text-muted-foreground">WHT (estimate)</dt>
        <dd className="text-right">
          {e.whtAmount === null ? (
            <TaxNotConfigured note={e.taxNote} status={e.taxStatus} />
          ) : (
            <Money value={e.whtAmount} source={e.source} />
          )}
        </dd>
        <dt className="text-muted-foreground">Book closure</dt>
        <dd className="text-right">{formatDate(e.bookClosureFrom)}</dd>
      </dl>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="mp-paidAt" label="Paid on" error={errors.paidAt}>
          <Input
            id="mp-paidAt"
            type="date"
            max={today}
            value={v.paidAt}
            aria-invalid={!!errors.paidAt}
            onChange={(ev) => set('paidAt', ev.target.value)}
          />
        </Field>
        <Field id="mp-net" label="Net received (Rs)" error={errors.netAmount} hint="Cash credited to you">
          <Input
            id="mp-net"
            inputMode="decimal"
            value={v.netAmount}
            aria-invalid={!!errors.netAmount}
            onChange={(ev) => set('netAmount', ev.target.value)}
          />
        </Field>
        <Field
          id="mp-wht"
          label="WHT deducted (Rs) — required"
          error={errors.whtAmount}
          hint="From the payment advice; 0 if none was deducted"
        >
          <Input
            id="mp-wht"
            inputMode="decimal"
            required
            aria-required="true"
            value={v.whtAmount}
            aria-invalid={!!errors.whtAmount}
            onChange={(ev) => set('whtAmount', ev.target.value)}
          />
        </Field>
        <Field id="mp-zakat" label="Zakat deducted (Rs)" error={errors.zakatAmount} hint="Optional">
          <Input
            id="mp-zakat"
            inputMode="decimal"
            value={v.zakatAmount}
            aria-invalid={!!errors.zakatAmount}
            onChange={(ev) => set('zakatAmount', ev.target.value)}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        Withholding is never worked out from the cash received: a shortfall could be a wrong share count or a
        missing payment. Anything that does not add up is shown after saving.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={m.markPaid.isPending}>
          Mark paid
        </Button>
      </div>
    </form>
  );
}

function DiffRow({
  label,
  value,
  unavailable,
}: {
  label: string;
  value: string | null;
  unavailable: string;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">
        {value === null ? (
          <span className="text-xs text-muted-foreground">{unavailable}</span>
        ) : (
          <PnlText value={value} showIcon={false} dp={4} />
        )}
      </dd>
    </>
  );
}

export function MarkPaidResultView({ r, onClose }: { r: DividendMarkPaidResult; onClose: () => void }) {
  const balanced = Dec.of(r.unexplainedDifference).isZero();
  const noEstimate = 'n/a — no verified WHT estimate';
  return (
    <div className="space-y-4" data-testid="mark-paid-result">
      {balanced ? (
        <Alert>
          <CheckCircle2 aria-hidden="true" />
          <AlertTitle>Recorded — the figures add up</AlertTitle>
          <AlertDescription>
            Gross − zakat − withholding − received = Rs 0. Status is now Paid (Manual); reconcile it once the
            broker / CDC statement confirms it.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive" data-testid="unexplained-difference">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Unexplained difference: Rs {r.unexplainedDifference}</AlertTitle>
          <AlertDescription>
            Gross − zakat − withholding − received does not equal zero. It was recorded as entered and NOT
            booked as tax. Check the share count, the dividend per share and the payment advice.
          </AlertDescription>
        </Alert>
      )}
      {r.warnings.length > 0 && (
        <ul
          className="list-inside list-disc text-sm text-amber-900 dark:text-amber-300"
          aria-label="Warnings"
        >
          {r.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div>
        <p className="mb-1 text-sm font-medium">Compared with the estimate</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
          <DiffRow
            label="Net received − estimated net"
            value={r.differences.netAmount}
            unavailable={noEstimate}
          />
          <DiffRow
            label="WHT recorded − estimated WHT"
            value={r.differences.whtAmount}
            unavailable={noEstimate}
          />
          <DiffRow
            label="(Net + WHT + zakat) − estimated gross"
            value={r.differences.grossAmount}
            unavailable="—"
          />
          <dt className="text-muted-foreground">Recorded</dt>
          <dd className="text-right">
            <Money value={r.entitlement.netAmount} source={r.entitlement.source} dp={4} />
          </dd>
        </dl>
      </div>
      <div className="flex justify-end">
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
