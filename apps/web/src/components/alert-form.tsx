'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import type { NotificationChannel } from '@ktrade/shared';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ALERT_KINDS,
  ALERT_META,
  ALL_CHANNELS,
  ENABLED_CHANNELS,
  MAX_COOLDOWN_MINUTES,
  needsPortfolio,
  needsSymbol,
  validateAlertForm,
  type AlertFormValues,
} from '@/lib/alerts';
import { errorMessage } from '@/lib/api/errors';
import { useAlertMutations } from '@/lib/api/hooks';
import type { Alert, AlertKind, Portfolio } from '@/lib/api/types';

const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  IN_APP: 'In-app',
  EMAIL: 'Email',
  TELEGRAM: 'Telegram',
};

/** Create (no `alert`) or edit an alert. Type, symbol and portfolio are immutable once created. */
export function AlertForm({
  alert,
  portfolios,
  defaultType = 'PRICE_ABOVE',
  defaultSymbol = '',
  defaultPortfolioId,
  onDone,
  onCancel,
}: {
  alert?: Alert;
  portfolios: Portfolio[];
  defaultType?: AlertKind;
  defaultSymbol?: string;
  defaultPortfolioId?: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const m = useAlertMutations();
  const [v, setV] = useState<AlertFormValues>(() => ({
    type: alert?.type ?? defaultType,
    symbol: alert?.symbol ?? defaultSymbol,
    portfolioId: alert?.portfolio?.id ?? defaultPortfolioId ?? portfolios[0]?.id ?? '',
    value: alert ? (alert.params[ALERT_META[alert.type].paramKey] ?? '') : '',
    cooldownMinutes: String(alert?.cooldownMinutes ?? 60),
    triggerOnce: alert?.triggerOnce ?? false,
    active: alert?.active ?? true,
    channels: alert ? [...alert.channels] : ['IN_APP'],
  }));
  const [errors, setErrors] = useState<Partial<Record<keyof AlertFormValues, string>>>({});
  const meta = ALERT_META[v.type];
  const set = <K extends keyof AlertFormValues>(k: K, val: AlertFormValues[K]) =>
    setV((prev) => ({ ...prev, [k]: val }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = validateAlertForm(v);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    const done = {
      onSuccess: () => {
        toast.success(alert ? 'Alert updated' : 'Alert created');
        onDone();
      },
      onError: (err: unknown) => toast.error(errorMessage(err)),
    };
    if (alert) {
      const { params, channels, cooldownMinutes, triggerOnce, active } = r.input;
      m.update.mutate(
        { id: alert.id, patch: { params, channels, cooldownMinutes, triggerOnce, active } },
        done,
      );
    } else m.create.mutate(r.input, done);
  }

  const busy = m.create.isPending || m.update.isPending;
  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label={alert ? 'Edit alert' : 'New alert'}>
      <Field id="al-type" label="Alert type">
        <Select
          value={v.type}
          disabled={!!alert}
          onValueChange={(t) => {
            set('type', t as AlertKind);
            set('value', '');
            setErrors({});
          }}
        >
          <SelectTrigger id="al-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ALERT_KINDS.map((t) => (
              <SelectItem key={t} value={t}>
                {ALERT_META[t].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{meta.description}</p>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        {needsSymbol(v.type) && (
          <Field id="al-symbol" label="Symbol" error={errors.symbol}>
            <Input
              id="al-symbol"
              value={v.symbol}
              disabled={!!alert}
              autoCapitalize="characters"
              placeholder="OGDC"
              aria-invalid={!!errors.symbol}
              onChange={(e) => set('symbol', e.target.value.toUpperCase())}
            />
          </Field>
        )}
        {needsPortfolio(v.type) && (
          <Field id="al-portfolio" label="Portfolio" error={errors.portfolioId}>
            <Select value={v.portfolioId} disabled={!!alert} onValueChange={(id) => set('portfolioId', id)}>
              <SelectTrigger id="al-portfolio" className="w-full" aria-invalid={!!errors.portfolioId}>
                <SelectValue placeholder="Pick a portfolio" />
              </SelectTrigger>
              <SelectContent>
                {(alert?.portfolio && !portfolios.some((p) => p.id === alert.portfolio!.id)
                  ? [{ id: alert.portfolio.id, name: alert.portfolio.name, kind: undefined }]
                  : portfolios
                ).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.kind ? ` · ${p.kind === 'PAPER' ? 'Paper' : 'Live'}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field id="al-value" label={meta.paramLabel} error={errors.value}>
          <Input
            id="al-value"
            inputMode="decimal"
            value={v.value}
            aria-invalid={!!errors.value}
            onChange={(e) => set('value', e.target.value)}
          />
        </Field>
        <Field id="al-cooldown" label="Cooldown (minutes)" error={errors.cooldownMinutes}>
          <Input
            id="al-cooldown"
            inputMode="numeric"
            value={v.cooldownMinutes}
            aria-invalid={!!errors.cooldownMinutes}
            onChange={(e) => set('cooldownMinutes', e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Re-fires at most once per cooldown while the condition holds (max {MAX_COOLDOWN_MINUTES} = 7
            days).
          </p>
        </Field>
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={v.triggerOnce} onCheckedChange={(c) => set('triggerOnce', c === true)} />
          Trigger once (deactivate after it fires)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={v.active} onCheckedChange={(c) => set('active', c === true)} />
          Active
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Channels</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {ALL_CHANNELS.map((ch) => {
            const enabled = ENABLED_CHANNELS.includes(ch);
            return (
              <label
                key={ch}
                className={`flex items-center gap-2 text-sm ${enabled ? '' : 'text-muted-foreground'}`}
              >
                <Checkbox
                  checked={v.channels.includes(ch)}
                  disabled={!enabled}
                  aria-label={enabled ? CHANNEL_LABEL[ch] : `${CHANNEL_LABEL[ch]} (not configured)`}
                  onCheckedChange={(c) =>
                    set('channels', c === true ? [...v.channels, ch] : v.channels.filter((x) => x !== ch))
                  }
                />
                {CHANNEL_LABEL[ch]}
                {!enabled && <span className="text-xs">(not configured)</span>}
              </label>
            );
          })}
        </div>
        {errors.channels && (
          <p className="text-xs text-destructive" role="alert">
            {errors.channels}
          </p>
        )}
      </fieldset>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          {alert ? 'Save alert' : 'Create alert'}
        </Button>
      </div>
    </form>
  );
}

/** The form in a dialog (alerts page "New / Edit alert", stock page "Create price alert"). */
export function AlertFormDialog({
  open,
  onOpenChange,
  ...form
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Omit<Parameters<typeof AlertForm>[0], 'onDone' | 'onCancel'>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{form.alert ? 'Edit alert' : 'New alert'}</DialogTitle>
          <DialogDescription>
            Evaluated every minute while the market is open, or on demand with “Evaluate now”. Delivered
            in-app.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <AlertForm {...form} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
