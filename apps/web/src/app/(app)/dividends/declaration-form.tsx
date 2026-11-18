'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  declarationFormValues,
  declarationPatch,
  validateDeclarationForm,
  type DeclarationFormValues,
  type FormErrors,
} from '@/lib/api/dividends-rules';
import { errorMessage } from '@/lib/api/errors';
import { useDividendMutations } from '@/lib/api/hooks';
import type { DividendDeclaration } from '@/lib/api/types';
import { Field } from './shared';

const DATE_FIELDS: { key: keyof DeclarationFormValues; label: string; hint?: string }[] = [
  { key: 'announcementDate', label: 'Announcement date', hint: 'Optional' },
  { key: 'bookClosureFrom', label: 'Book closure from' },
  { key: 'bookClosureTo', label: 'Book closure to', hint: 'Optional' },
  { key: 'paymentDate', label: 'Payment date', hint: 'Optional' },
];

/** Create (no `declaration`) or edit a cash-dividend declaration. The symbol is immutable once created. */
export function DeclarationForm({
  declaration,
  onDone,
  onCancel,
}: {
  declaration?: DividendDeclaration;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const m = useDividendMutations();
  const [v, setV] = useState<DeclarationFormValues>(() => declarationFormValues(declaration));
  const [errors, setErrors] = useState<FormErrors<DeclarationFormValues>>({});
  const set = (k: keyof DeclarationFormValues, val: string) => setV((prev) => ({ ...prev, [k]: val }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = validateDeclarationForm(v);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    const onError = (err: unknown) => toast.error(errorMessage(err));
    if (!declaration) {
      m.create.mutate(r.input, {
        onSuccess: () => {
          toast.success('Dividend recorded. Compute entitlements to see what you are owed.');
          onDone();
        },
        onError,
      });
      return;
    }
    const patch = declarationPatch(declaration, r.input);
    if (Object.keys(patch).length === 0) {
      toast.info('Nothing changed');
      onDone();
      return;
    }
    m.update.mutate(
      { id: declaration.id, patch },
      {
        onSuccess: (u) => {
          toast.success(
            u.estimatedEntitlementsCleared > 0
              ? `Dividend updated. ${u.estimatedEntitlementsCleared} estimated entitlement(s) cleared — compute again.`
              : 'Dividend updated',
          );
          onDone();
        },
        onError,
      },
    );
  }

  const busy = m.create.isPending || m.update.isPending;
  return (
    <form
      onSubmit={submit}
      noValidate
      className="space-y-4"
      aria-label={declaration ? 'Edit dividend' : 'New dividend'}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="dv-symbol" label="Symbol" error={errors.symbol}>
          <Input
            id="dv-symbol"
            value={v.symbol}
            disabled={!!declaration}
            autoCapitalize="characters"
            placeholder="OGDC"
            aria-invalid={!!errors.symbol}
            onChange={(e) => set('symbol', e.target.value.toUpperCase())}
          />
        </Field>
        <Field
          id="dv-dps"
          label="Dividend per share (Rs)"
          error={errors.dividendPerShare}
          hint="Up to 6 decimals"
        >
          <Input
            id="dv-dps"
            inputMode="decimal"
            value={v.dividendPerShare}
            aria-invalid={!!errors.dividendPerShare}
            onChange={(e) => set('dividendPerShare', e.target.value)}
          />
        </Field>
        {DATE_FIELDS.map((f) => (
          <Field key={f.key} id={`dv-${f.key}`} label={f.label} error={errors[f.key]} hint={f.hint}>
            <Input
              id={`dv-${f.key}`}
              type="date"
              value={v[f.key]}
              aria-invalid={!!errors[f.key]}
              onChange={(e) => set(f.key, e.target.value)}
            />
          </Field>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Dates must be in order: announcement ≤ book-closure start ≤ end ≤ payment. Recorded as entered by you
        (Manual).
        {declaration && ' Saving clears this dividend’s estimated entitlements; compute again afterwards.'}
      </p>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          {declaration ? 'Save dividend' : 'Record dividend'}
        </Button>
      </div>
    </form>
  );
}

export function DeclarationFormDialog({
  open,
  onOpenChange,
  declaration,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  declaration?: DividendDeclaration;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {declaration ? `Edit ${declaration.symbol} dividend` : 'Record a cash dividend'}
          </DialogTitle>
          <DialogDescription>
            From the company’s PSX announcement. Eligibility counts shares settled before the book-closure
            start.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <DeclarationForm
            declaration={declaration}
            onDone={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
