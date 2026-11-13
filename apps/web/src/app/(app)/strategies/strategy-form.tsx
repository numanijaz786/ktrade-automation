'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { ParamFields, draftFromParams, validateParams, type ParamDraft } from '@/components/strategy-params';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage } from '@/lib/api/errors';
import { useStrategyMutations } from '@/lib/api/hooks';
import type {
  Portfolio,
  Strategy,
  StrategyDefinition,
  StrategyDryRun,
  StrategyTemplate,
} from '@/lib/api/types';
import { formatDate, formatNumber, humanize } from '@/lib/format';

const PCT_RE = /^\d{1,4}(\.\d{1,4})?$/;
const MONEY_RE = /^\d{1,16}(\.\d{1,4})?$/;
const OVERLAYS = [
  ['stopLossPct', 'Stop-loss %'],
  ['takeProfitPct', 'Take-profit %'],
  ['trailingStopPct', 'Trailing stop %'],
] as const;
type OverlayKey = (typeof OVERLAYS)[number][0];

/** Create (no `strategy`) or edit a strategy; dry-run the current definition without saving. */
export function StrategyForm({
  templates,
  portfolios,
  strategy,
  defaultPortfolioId,
  onDone,
}: {
  templates: StrategyTemplate[];
  portfolios: Portfolio[];
  strategy?: Strategy;
  defaultPortfolioId?: string;
  onDone: () => void;
}) {
  const usable = templates.filter((t) => t.type !== 'CUSTOM_RULES');
  const m = useStrategyMutations();
  const [name, setName] = useState(strategy?.name ?? '');
  const [portfolioId, setPortfolioId] = useState(strategy?.portfolioId ?? defaultPortfolioId ?? '');
  const [symbol, setSymbol] = useState(strategy?.symbol ?? '');
  const [type, setType] = useState(strategy?.type ?? usable[0]?.type ?? 'MA_CROSSOVER');
  const template = usable.find((t) => t.type === type);
  const [draft, setDraft] = useState<ParamDraft>(() =>
    draftFromParams(template?.params ?? [], strategy?.parameters),
  );
  const [overlays, setOverlays] = useState<Record<OverlayKey, string>>({
    stopLossPct: strategy?.stopLossPct ?? '',
    takeProfitPct: strategy?.takeProfitPct ?? '',
    trailingStopPct: strategy?.trailingStopPct ?? '',
  });
  const [maxInvestment, setMaxInvestment] = useState(strategy?.maxInvestment ?? '100000');
  const [autoExecute, setAutoExecute] = useState(strategy?.autoExecute ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dryRun, setDryRun] = useState<StrategyDryRun | null>(null);
  const portfolio = portfolios.find((p) => p.id === portfolioId);
  const live = (strategy?.mode ?? (portfolio?.kind === 'LIVE' ? 'LIVE' : 'PAPER')) === 'LIVE';

  function changeType(t: string) {
    const next = usable.find((x) => x.type === t);
    setType(next?.type ?? type);
    setDraft(draftFromParams(next?.params ?? []));
    setDryRun(null);
  }

  /** Validate everything client-side; the API validates again (422 with JSON paths). */
  function build(): { def: StrategyDefinition; errs: Record<string, string> } {
    const errs: Record<string, string> = {};
    const r = validateParams(template?.params ?? [], draft);
    if (!r.ok) Object.assign(errs, r.errors);
    for (const [k, label] of OVERLAYS) {
      const v = overlays[k].trim();
      if (v && (!PCT_RE.test(v) || !/[1-9]/.test(v))) errs[k] = `${label} must be a positive percentage`;
    }
    const def: StrategyDefinition = {
      type,
      parameters: r.ok ? r.values : {},
      stopLossPct: overlays.stopLossPct.trim() || null,
      takeProfitPct: overlays.takeProfitPct.trim() || null,
      trailingStopPct: overlays.trailingStopPct.trim() || null,
    };
    return { def, errs };
  }

  function runDryRun() {
    const { def, errs } = build();
    if (!/^[A-Z0-9]{1,12}$/.test(symbol)) errs.symbol = 'Enter a PSX symbol to dry-run against';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    m.validate.mutate(
      { ...def, symbol, bars: 250 },
      { onSuccess: (v) => setDryRun(v.dryRun), onError: (e) => toast.error(errorMessage(e)) },
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const { def, errs } = build();
    if (!name.trim()) errs.name = 'Name is required';
    if (!strategy) {
      if (!portfolioId) errs.portfolioId = 'Pick a portfolio';
      if (!/^[A-Z0-9]{1,12}$/.test(symbol)) errs.symbol = 'Enter a PSX symbol, e.g. OGDC';
    }
    if (!MONEY_RE.test(maxInvestment) || !/[1-9]/.test(maxInvestment))
      errs.maxInvestment = 'Enter a positive amount';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const common = { ...def, name: name.trim(), maxInvestment, autoExecute: live ? false : autoExecute };
    const done = {
      onSuccess: () => {
        toast.success(strategy ? 'Strategy updated' : 'Strategy created (inactive until you activate it)');
        onDone();
      },
      onError: (err: unknown) => toast.error(errorMessage(err)),
    };
    if (strategy) m.update.mutate({ id: strategy.id, patch: common }, done);
    else m.create.mutate({ ...common, portfolioId, symbol }, done);
  }

  const busy = m.create.isPending || m.update.isPending;
  return (
    <form
      onSubmit={submit}
      noValidate
      className="space-y-5"
      aria-label={strategy ? 'Edit strategy' : 'New strategy'}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="st-name" label="Name" error={errors.name}>
          <Input id="st-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="st-template" label="Template">
          <Select value={type} onValueChange={changeType}>
            <SelectTrigger id="st-template" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {usable.map((t) => (
                <SelectItem key={t.type} value={t.type}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {!strategy && (
          <>
            <Field id="st-portfolio" label="Portfolio" error={errors.portfolioId}>
              <Select value={portfolioId} onValueChange={setPortfolioId}>
                <SelectTrigger id="st-portfolio" className="w-full">
                  <SelectValue placeholder="Pick a portfolio" />
                </SelectTrigger>
                <SelectContent>
                  {portfolios.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {p.kind === 'PAPER' ? 'Paper' : 'Live'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="st-symbol" label="Symbol" error={errors.symbol}>
              <Input
                id="st-symbol"
                value={symbol}
                maxLength={12}
                placeholder="e.g. OGDC"
                onChange={(e) => setSymbol(e.target.value.toUpperCase().trim())}
              />
            </Field>
          </>
        )}
      </div>
      {template && <p className="text-sm text-muted-foreground">{template.description}</p>}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Parameters</legend>
        <ParamFields params={template?.params ?? []} draft={draft} errors={errors} onChange={setDraft} />
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Exit overlays (optional)</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {OVERLAYS.map(([k, label]) => (
            <Field key={k} id={`st-${k}`} label={label} error={errors[k]}>
              <Input
                id={`st-${k}`}
                inputMode="decimal"
                value={overlays[k]}
                onChange={(e) => setOverlays((o) => ({ ...o, [k]: e.target.value.trim() }))}
              />
            </Field>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="st-max" label="Max investment (Rs)" error={errors.maxInvestment}>
          <Input
            id="st-max"
            inputMode="decimal"
            value={maxInvestment}
            onChange={(e) => setMaxInvestment(e.target.value.trim())}
          />
        </Field>
        <div className="space-y-1">
          {live ? (
            <p
              className="rounded-lg border bg-muted/30 p-2 text-xs text-muted-foreground"
              data-testid="live-no-auto"
            >
              Live strategy: auto-execution is not offered. Signals are recorded only; every live order needs
              your preview, step-up approval and manual placement in KTrade.
            </p>
          ) : (
            <div className="flex items-start gap-2 pt-5">
              <Checkbox
                id="st-auto"
                checked={autoExecute}
                onCheckedChange={(c) => setAutoExecute(c === true)}
              />
              <div>
                <Label htmlFor="st-auto">Auto-execute paper orders</Label>
                <p className="text-xs text-muted-foreground">
                  Signals become simulated paper orders after all risk checks pass.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          {strategy ? 'Save changes' : 'Create strategy'}
        </Button>
        <Button type="button" variant="outline" onClick={runDryRun} disabled={m.validate.isPending}>
          {m.validate.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
          Dry run (last 250 bars)
        </Button>
      </div>
      {dryRun && <DryRunResult run={dryRun} />}
    </form>
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

/** Hypothetical signals with their explanation traces. Nothing here was traded. */
export function DryRunResult({ run }: { run: StrategyDryRun }) {
  return (
    <section aria-label="Dry run" className="space-y-3 rounded-lg border p-3" data-testid="dry-run">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          Dry run · {run.symbol} · {run.bars} bars
          {run.from && run.to && ` (${formatDate(run.from)} – ${formatDate(run.to)})`}
        </span>
        {run.dataSource && <ProvenanceBadge source={run.dataSource} />}
      </div>
      {run.dataSource === 'SIMULATED' && (
        <Alert>
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Simulated price history</AlertTitle>
          <AlertDescription>These bars are not real market data.</AlertDescription>
        </Alert>
      )}
      {run.warmupComplete === false && (
        <p className="text-xs text-amber-900 dark:text-amber-300">
          Not enough bars to warm up every indicator.
        </p>
      )}
      {run.note && <p className="text-xs text-muted-foreground">{run.note}</p>}
      {run.signals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No signals in this window.</p>
      ) : (
        <ol className="space-y-2">
          {run.signals.map((s, i) => (
            <li key={`${s.ts}-${i}`} className="rounded-md border p-2 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {s.type} · {s.side}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(s.ts)} · {humanize(s.reason)} · close {formatNumber(s.price)} · score{' '}
                  {s.score.total}
                </span>
                {!s.wouldFill && (
                  <span className="text-xs text-muted-foreground">(would fill next open)</span>
                )}
              </p>
              <p className="text-xs">{s.summary || s.trace.summary}</p>
              {s.trace.rule && s.trace.rule.trace.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs" aria-label="Trace">
                  {s.trace.rule.trace.map((c, k) => (
                    <li key={`${c.path}-${k}`} className="flex items-start gap-1">
                      {c.result ? (
                        <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-gain" aria-hidden="true" />
                      ) : (
                        <XCircle
                          className="mt-0.5 size-3 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                      <span className="font-mono">{c.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              {s.trace.overlays
                .filter((o) => o.triggered)
                .map((o) => (
                  <p key={o.kind} className="text-xs">
                    {o.text}
                  </p>
                ))}
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-muted-foreground" data-testid="disclaimer">
        {run.disclaimer}
      </p>
    </section>
  );
}
