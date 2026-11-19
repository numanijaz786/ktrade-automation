'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/field';
import { NativeSelect } from '@/components/native-select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api/errors';
import { useResearchMutations } from '@/lib/api/hooks';
import {
  EMPTY_FINANCIAL,
  FINANCIAL_ITEM_LABELS,
  financialFormValues,
  validateFinancialForm,
  type FinancialFormErrors,
  type FinancialFormValues,
} from '@/lib/api/research-rules';
import { FINANCIAL_ITEM_KEYS, type FinancialPeriod } from '@/lib/api/types';

/** Create or correct one period. Saving the same symbol, type and period end corrects it in place. */
export function FinancialForm({
  period,
  defaultSymbol,
  onDone,
  onCancel,
}: {
  period?: FinancialPeriod;
  defaultSymbol?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { saveFinancial } = useResearchMutations();
  const [v, setV] = useState<FinancialFormValues>(() =>
    period ? financialFormValues(period) : { ...EMPTY_FINANCIAL, symbol: defaultSymbol ?? '' },
  );
  const [errors, setErrors] = useState<FinancialFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const set = (k: Exclude<keyof FinancialFormValues, 'items'>, val: string) =>
    setV((p) => ({ ...p, [k]: val }));

  function submit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);
    const r = validateFinancialForm(v, Date.now());
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    saveFinancial.mutate(r.input, {
      onSuccess: (s) => {
        toast.success(s.created ? 'Period added' : 'Period corrected');
        onDone();
      },
      onError: (err) => setServerError(errorMessage(err)),
    });
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="space-y-4"
      aria-label={period ? 'Edit period' : 'New period'}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField id="fi-symbol" label="Symbol" error={errors.symbol}>
          <Input
            id="fi-symbol"
            value={v.symbol}
            disabled={!!period}
            aria-invalid={!!errors.symbol}
            onChange={(e) => set('symbol', e.target.value.toUpperCase())}
          />
        </FormField>
        <FormField id="fi-type" label="Period type" error={errors.periodType}>
          <NativeSelect
            id="fi-type"
            value={v.periodType}
            disabled={!!period}
            onChange={(e) => set('periodType', e.target.value)}
          >
            <option value="ANNUAL">Annual</option>
            <option value="QUARTERLY">Quarterly</option>
          </NativeSelect>
        </FormField>
        <FormField id="fi-currency" label="Currency" error={errors.currency}>
          <Input
            id="fi-currency"
            value={v.currency}
            aria-invalid={!!errors.currency}
            onChange={(e) => set('currency', e.target.value.toUpperCase())}
          />
        </FormField>
        <FormField id="fi-end" label="Period end" error={errors.periodEnd}>
          <Input
            id="fi-end"
            type="date"
            value={v.periodEnd}
            disabled={!!period}
            aria-invalid={!!errors.periodEnd}
            onChange={(e) => set('periodEnd', e.target.value)}
          />
        </FormField>
        <FormField id="fi-pub" label="Published on" error={errors.publishedAt}>
          <Input
            id="fi-pub"
            type="date"
            value={v.publishedAt}
            aria-invalid={!!errors.publishedAt}
            onChange={(e) => set('publishedAt', e.target.value)}
          />
        </FormField>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          id="fi-ref"
          label="Document and page"
          error={errors.sourceRef}
          hint="For example: Annual report 2025, p. 41"
        >
          <Input
            id="fi-ref"
            value={v.sourceRef}
            aria-invalid={!!errors.sourceRef}
            onChange={(e) => set('sourceRef', e.target.value)}
          />
        </FormField>
        <FormField id="fi-url" label="Link to the document" error={errors.sourceUrl} hint="Optional">
          <Input
            id="fi-url"
            value={v.sourceUrl}
            aria-invalid={!!errors.sourceUrl}
            onChange={(e) => set('sourceUrl', e.target.value)}
          />
        </FormField>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          Figures (full rupees, no commas). Leave blank if not reported.
        </legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {FINANCIAL_ITEM_KEYS.map((k) => (
            <FormField key={k} id={`fi-${k}`} label={FINANCIAL_ITEM_LABELS[k]} error={errors.items?.[k]}>
              <Input
                id={`fi-${k}`}
                inputMode="decimal"
                value={v.items[k]}
                aria-invalid={!!errors.items?.[k]}
                onChange={(e) => setV((p) => ({ ...p, items: { ...p.items, [k]: e.target.value } }))}
              />
            </FormField>
          ))}
        </div>
        {errors.form && (
          <p className="text-xs text-destructive" role="alert">
            {errors.form}
          </p>
        )}
      </fieldset>
      {serverError && (
        <Alert variant="destructive">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saveFinancial.isPending}>
          {period ? 'Save changes' : 'Add period'}
        </Button>
      </div>
    </form>
  );
}

export function FinancialFormDialog({
  open,
  onOpenChange,
  period,
  defaultSymbol,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  period?: FinancialPeriod;
  defaultSymbol?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {period ? `Edit ${period.symbol} ${period.periodEnd}` : 'Add a financial period'}
          </DialogTitle>
          <DialogDescription>
            Copy the figures from the company report. They are saved as entered by you (not verified).
          </DialogDescription>
        </DialogHeader>
        {open && (
          <FinancialForm
            period={period}
            defaultSymbol={defaultSymbol}
            onDone={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
