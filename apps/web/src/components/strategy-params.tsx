'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { StrategyParams, TemplateParam } from '@/lib/api/types';
import { Dec } from '@/lib/decimal';

/** Form state: every value is the raw input (strings), booleans for BOOL params. */
export type ParamDraft = Record<string, string | boolean>;

const INT_RE = /^-?\d{1,9}$/;
const DEC_RE = /^\d{1,12}(\.\d{1,6})?$/;

export function draftFromParams(params: TemplateParam[], values: StrategyParams = {}): ParamDraft {
  const out: ParamDraft = {};
  for (const p of params) {
    const v = values[p.name] ?? p.default;
    out[p.name] =
      p.type === 'BOOL' ? v === true || v === 'true' : v === null || v === undefined ? '' : String(v);
  }
  return out;
}

/** Validate a draft against the template's parameter schema (bounds checked exactly, no floats). */
export function validateParams(
  params: TemplateParam[],
  draft: ParamDraft,
): { ok: true; values: StrategyParams } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const values: StrategyParams = {};
  for (const p of params) {
    const raw = draft[p.name];
    if (p.type === 'BOOL') {
      values[p.name] = raw === true;
      continue;
    }
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (v === '') {
      if (p.required) errors[p.name] = 'Required';
      continue;
    }
    if (p.type === 'ENUM') {
      if (p.options && !p.options.includes(v)) errors[p.name] = `Pick one of ${p.options.join(', ')}`;
      else values[p.name] = v;
      continue;
    }
    const re = p.type === 'INT' ? INT_RE : DEC_RE;
    if (!re.test(v)) {
      errors[p.name] = p.type === 'INT' ? 'Whole number' : 'Decimal number, e.g. 7.5';
      continue;
    }
    if (p.min !== null && Dec.of(v).lt(p.min)) errors[p.name] = `At least ${p.min}`;
    else if (p.max !== null && Dec.of(v).gt(p.max)) errors[p.name] = `At most ${p.max}`;
    // INT parameters are small counts (periods, levels), safe as JS integers; decimals stay strings.
    else values[p.name] = p.type === 'INT' ? Number.parseInt(v, 10) : v;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

const pretty = (name: string) =>
  name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/ Pct$/, ' %');

/** Fields generated from a template's parameter schema. */
export function ParamFields({
  params,
  draft,
  errors = {},
  onChange,
  idPrefix = 'param',
}: {
  params: TemplateParam[];
  draft: ParamDraft;
  errors?: Record<string, string>;
  onChange: (next: ParamDraft) => void;
  idPrefix?: string;
}) {
  if (!params.length)
    return <p className="text-sm text-muted-foreground">This template has no parameters.</p>;
  const set = (k: string, v: string | boolean) => onChange({ ...draft, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {params.map((p) => {
        const id = `${idPrefix}-${p.name}`;
        const err = errors[p.name];
        const range = p.min !== null || p.max !== null ? ` (${p.min ?? '…'}–${p.max ?? '…'})` : '';
        if (p.type === 'BOOL')
          return (
            <div key={p.name} className="flex items-start gap-2 sm:col-span-2">
              <Checkbox
                id={id}
                checked={draft[p.name] === true}
                onCheckedChange={(c) => set(p.name, c === true)}
              />
              <div>
                <Label htmlFor={id}>{pretty(p.name)}</Label>
                <p className="text-xs text-muted-foreground">{p.description}</p>
              </div>
            </div>
          );
        return (
          <div key={p.name} className="space-y-1">
            <Label htmlFor={id}>
              {pretty(p.name)}
              {p.required && <span aria-hidden="true"> *</span>}
            </Label>
            {p.type === 'ENUM' ? (
              <Select value={String(draft[p.name] ?? '')} onValueChange={(v) => set(p.name, v)}>
                <SelectTrigger id={id} className="w-full" aria-invalid={!!err}>
                  <SelectValue placeholder="Pick one" />
                </SelectTrigger>
                <SelectContent>
                  {(p.options ?? []).map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={id}
                inputMode={p.type === 'INT' ? 'numeric' : 'decimal'}
                value={String(draft[p.name] ?? '')}
                onChange={(e) => set(p.name, e.target.value)}
                aria-invalid={!!err}
                aria-describedby={`${id}-help`}
                required={p.required}
              />
            )}
            <p id={`${id}-help`} className="text-xs text-muted-foreground">
              {p.description}
              {range}
            </p>
            {err && (
              <p className="text-xs text-destructive" role="alert">
                {pretty(p.name)}: {err}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
