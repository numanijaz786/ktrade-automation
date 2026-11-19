'use client';

import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { FormField } from '@/components/field';
import { NativeSelect } from '@/components/native-select';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { EmptyState, QueryState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api/errors';
import { useMacro, useResearchMutations } from '@/lib/api/hooks';
import {
  EMPTY_MACRO,
  MACRO_LABELS,
  validateMacroForm,
  type FormErrors,
  type MacroFormValues,
} from '@/lib/api/research-rules';
import type { MacroObservation } from '@/lib/api/types';
import { formatDate, formatNumber } from '@/lib/format';
import { pktDate } from '../dividends/shared';

export function MacroTable({ rows }: { rows: MacroObservation[] }) {
  return (
    <Table aria-label="Macro observations">
      <TableHeader>
        <TableRow>
          <TableHead>Series</TableHead>
          <TableHead>Date</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Where it came from</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((m) => (
          <TableRow key={m.id}>
            <TableCell>{MACRO_LABELS[m.series] ?? m.series}</TableCell>
            <TableCell>{formatDate(m.date)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatNumber(m.value, { dp: 4 })}</TableCell>
            <TableCell>
              <ProvenanceBadge source={m.source} />
            </TableCell>
            <TableCell className="whitespace-normal">{m.sourceRef}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function MacroForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { addMacro } = useResearchMutations();
  const [v, setV] = useState<MacroFormValues>(EMPTY_MACRO);
  const [errors, setErrors] = useState<FormErrors<MacroFormValues>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const set = (k: keyof MacroFormValues, val: string) => setV((p) => ({ ...p, [k]: val }));

  function submit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);
    const r = validateMacroForm(v, pktDate(Date.now()));
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    addMacro.mutate(r.input, {
      onSuccess: () => {
        toast.success('Observation saved');
        onDone();
      },
      onError: (err) => setServerError(errorMessage(err)),
    });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="New macro observation">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="mc-series" label="Series" error={errors.series}>
          <NativeSelect id="mc-series" value={v.series} onChange={(e) => set('series', e.target.value)}>
            {Object.entries(MACRO_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id="mc-date" label="Date" error={errors.date}>
          <Input
            id="mc-date"
            type="date"
            value={v.date}
            aria-invalid={!!errors.date}
            onChange={(e) => set('date', e.target.value)}
          />
        </FormField>
        <FormField id="mc-value" label="Value" error={errors.value} hint="A plain number, like 11 or 278.5">
          <Input
            id="mc-value"
            inputMode="decimal"
            value={v.value}
            aria-invalid={!!errors.value}
            onChange={(e) => set('value', e.target.value)}
          />
        </FormField>
        <FormField
          id="mc-source"
          label="Where it comes from"
          error={errors.sourceRef}
          hint="For example: SBP press release, 4 Nov"
        >
          <Input
            id="mc-source"
            value={v.sourceRef}
            aria-invalid={!!errors.sourceRef}
            onChange={(e) => set('sourceRef', e.target.value)}
          />
        </FormField>
      </div>
      <p className="text-xs text-muted-foreground">
        There is one value per series and date. Saving the same date again corrects the earlier value.
      </p>
      {serverError && (
        <Alert variant="destructive">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={addMacro.isPending}>
          Save observation
        </Button>
      </div>
    </form>
  );
}

export function MacroPanel({ isOwner }: { isOwner: boolean }) {
  const macro = useMacro();
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Every value here was entered by hand (Manual). The source column says where each one came from.
      </p>
      {isOwner && (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" /> Add observation
        </Button>
      )}
      <QueryState query={macro} rows={3}>
        {(list) =>
          list.data.length === 0 ? (
            <EmptyState
              title="No macro observations yet"
              description="Nothing is estimated. Add the policy rate, inflation, exchange rate, KIBOR or the KSE-100 level from an official source."
            />
          ) : (
            <div className="overflow-x-auto">
              <MacroTable rows={list.data} />
            </div>
          )
        }
      </QueryState>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a macro observation</DialogTitle>
            <DialogDescription>Saved as entered by you, with the source you give.</DialogDescription>
          </DialogHeader>
          {adding && <MacroForm onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
