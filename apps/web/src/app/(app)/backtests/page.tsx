'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { PnlText } from '@/components/money';
import { PageHeader, Section } from '@/components/page-header';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { GenericStatus } from '@/components/status-badge';
import { ErrorState, LoadingBlock, QueryState } from '@/components/states';
import { ParamFields, draftFromParams, validateParams, type ParamDraft } from '@/components/strategy-params';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorMessage } from '@/lib/api/errors';
import { Dec } from '@/lib/decimal';
import {
  useBacktest,
  useBacktests,
  useCompareBacktests,
  useRunBacktest,
  useStrategies,
  useStrategyTemplates,
} from '@/lib/api/hooks';
import type { BacktestComparison, Strategy, StrategyTemplate } from '@/lib/api/types';
import { formatDate, formatDateTime, formatNumber, formatPercent, humanize } from '@/lib/format';
import { BacktestResults, DataSourceBanner, Disclaimer } from './backtest-results';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_RE = /^\d{1,16}(\.\d{1,4})?$/;
const BPS_RE = /^\d{1,4}(\.\d{1,4})?$/;

interface RangeDraft {
  symbol: string;
  from: string;
  to: string;
  capital: string;
  slippage: string;
}

function validateRange(r: RangeDraft, needSymbol: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (needSymbol && !/^[A-Z0-9]{1,12}$/.test(r.symbol)) e.symbol = 'Enter a PSX symbol, e.g. OGDC';
  if (!DATE_RE.test(r.from)) e.from = 'Pick a start date';
  if (!DATE_RE.test(r.to)) e.to = 'Pick an end date';
  if (!e.from && !e.to && !(r.from < r.to)) e.to = 'Must be after the start date';
  if (!MONEY_RE.test(r.capital) || !/[1-9]/.test(r.capital)) e.capital = 'Enter a positive amount';
  if (!BPS_RE.test(r.slippage) || Dec.of(r.slippage).gt(1000)) e.slippage = '0–1000 basis points';
  return e;
}

export default function BacktestsPage() {
  const templates = useStrategyTemplates();
  const strategies = useStrategies();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="space-y-8">
      <PageHeader
        title="Backtesting"
        description="Replay a strategy over daily bars with the real KTrade fee schedule: signal at close, fill at the next open ± slippage."
      />
      <Tabs defaultValue="run">
        <TabsList>
          <TabsTrigger value="run">Run</TabsTrigger>
          <TabsTrigger value="compare">Compare</TabsTrigger>
        </TabsList>
        <TabsContent value="run" className="space-y-8 pt-4">
          <QueryState query={templates} rows={4}>
            {(ts) => (
              <RunForm templates={ts} strategies={strategies.data ?? []} onRan={(id) => setSelected(id)} />
            )}
          </QueryState>
          {selected && <SelectedResult id={selected} />}
          <History selected={selected} onSelect={setSelected} />
        </TabsContent>
        <TabsContent value="compare" className="space-y-6 pt-4">
          <QueryState query={templates} rows={4}>
            {(ts) => <CompareForm templates={ts} strategies={strategies.data ?? []} />}
          </QueryState>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SelectedResult({ id }: { id: string }) {
  const q = useBacktest(id);
  return (
    <Section title="Results">
      {q.isPending ? (
        <LoadingBlock rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <BacktestResults bt={q.data} />
      )}
    </Section>
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

function RangeFields({
  prefix,
  r,
  set,
  errors,
  symbolLabel = 'Symbol',
}: {
  prefix: string;
  r: RangeDraft;
  set: (r: RangeDraft) => void;
  errors: Record<string, string>;
  symbolLabel?: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Field id={`${prefix}-symbol`} label={symbolLabel} error={errors.symbol}>
        <Input
          id={`${prefix}-symbol`}
          value={r.symbol}
          maxLength={12}
          placeholder="e.g. OGDC"
          onChange={(e) => set({ ...r, symbol: e.target.value.toUpperCase().trim() })}
        />
      </Field>
      <Field id={`${prefix}-from`} label="From" error={errors.from}>
        <Input
          id={`${prefix}-from`}
          type="date"
          value={r.from}
          onChange={(e) => set({ ...r, from: e.target.value })}
        />
      </Field>
      <Field id={`${prefix}-to`} label="To" error={errors.to}>
        <Input
          id={`${prefix}-to`}
          type="date"
          value={r.to}
          onChange={(e) => set({ ...r, to: e.target.value })}
        />
      </Field>
      <Field id={`${prefix}-capital`} label="Capital (Rs)" error={errors.capital}>
        <Input
          id={`${prefix}-capital`}
          inputMode="decimal"
          value={r.capital}
          onChange={(e) => set({ ...r, capital: e.target.value.trim() })}
        />
      </Field>
      <Field id={`${prefix}-slippage`} label="Slippage (bps)" error={errors.slippage}>
        <Input
          id={`${prefix}-slippage`}
          inputMode="decimal"
          value={r.slippage}
          onChange={(e) => set({ ...r, slippage: e.target.value.trim() })}
        />
      </Field>
    </div>
  );
}

const DEFAULT_RANGE: RangeDraft = {
  symbol: '',
  from: '2025-01-01',
  to: '2026-11-13',
  capital: '1000000',
  slippage: '10',
};

function TemplatePicker({
  templates,
  type,
  onType,
  draft,
  onDraft,
  errors,
  prefix,
}: {
  templates: StrategyTemplate[];
  type: string;
  onType: (t: string) => void;
  draft: ParamDraft;
  onDraft: (d: ParamDraft) => void;
  errors: Record<string, string>;
  prefix: string;
}) {
  const t = templates.find((x) => x.type === type);
  return (
    <div className="space-y-3">
      <Field id={`${prefix}-template`} label="Template">
        <Select value={type} onValueChange={onType}>
          <SelectTrigger id={`${prefix}-template`} className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {templates.map((x) => (
              <SelectItem key={x.type} value={x.type}>
                {x.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <ParamFields
        params={t?.params ?? []}
        draft={draft}
        errors={errors}
        onChange={onDraft}
        idPrefix={`${prefix}-p`}
      />
    </div>
  );
}

function RunForm({
  templates: all,
  strategies,
  onRan,
}: {
  templates: StrategyTemplate[];
  strategies: Strategy[];
  onRan: (id: string) => void;
}) {
  const templates = all.filter((t) => t.type !== 'CUSTOM_RULES');
  const run = useRunBacktest();
  const [source, setSource] = useState<'template' | string>('template');
  const [type, setType] = useState(templates[0]?.type ?? 'MA_CROSSOVER');
  const [draft, setDraft] = useState<ParamDraft>(() => draftFromParams(templates[0]?.params ?? []));
  const [range, setRange] = useState<RangeDraft>(DEFAULT_RANGE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const strategy = strategies.find((s) => s.id === source);

  function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validateRange(range, !strategy);
    let parameters = {};
    if (!strategy) {
      const p = validateParams(templates.find((t) => t.type === type)?.params ?? [], draft);
      if (!p.ok) Object.assign(errs, p.errors);
      else parameters = p.values;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    run.mutate(
      {
        ...(strategy ? { strategyId: strategy.id } : { definition: { type, parameters } }),
        ...(range.symbol ? { symbol: range.symbol } : {}),
        from: range.from,
        to: range.to,
        initialCapital: range.capital,
        slippageBps: range.slippage,
      },
      { onSuccess: (bt) => onRan(bt.id) },
    );
  }

  return (
    <Card>
      <CardContent className="pt-4">
        <form onSubmit={submit} noValidate className="space-y-4" aria-label="Run backtest">
          <Field id="bt-source" label="Strategy">
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger id="bt-source" className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="template">A template with parameters…</SelectItem>
                {strategies.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} ({s.symbol})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {!strategy && (
            <TemplatePicker
              templates={templates}
              type={type}
              onType={(t) => {
                setType(t as typeof type);
                setDraft(draftFromParams(templates.find((x) => x.type === t)?.params ?? []));
              }}
              draft={draft}
              onDraft={setDraft}
              errors={errors}
              prefix="bt"
            />
          )}
          <RangeFields
            prefix="bt"
            r={range}
            set={setRange}
            errors={errors}
            symbolLabel={strategy ? `Symbol (default ${strategy.symbol})` : 'Symbol'}
          />
          {run.isError && (
            <Alert variant="destructive">
              <AlertTitle>Backtest failed</AlertTitle>
              <AlertDescription>{errorMessage(run.error)}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={run.isPending}>
            {run.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Run backtest
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function History({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const q = useBacktests();
  return (
    <Section title="Previous runs">
      <QueryState query={q} rows={3}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-sm text-muted-foreground">No backtests yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table aria-label="Previous backtests">
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Strategy</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Return</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>
                      <span className="sr-only">Open</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((b) => (
                    <TableRow key={b.id} aria-selected={selected === b.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(b.createdAt)}
                      </TableCell>
                      <TableCell>
                        {humanize(b.strategyType)} · {b.symbol}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDate(b.from)} – {formatDate(b.to)}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {b.metrics?.totalReturnPct ? (
                          <PnlText value={b.metrics.totalReturnPct} percent showIcon={false} />
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        <ProvenanceBadge source={b.dataSource} />
                      </TableCell>
                      <TableCell>
                        <GenericStatus
                          value={b.status}
                          tone={b.status === 'SUCCEEDED' ? 'good' : b.status === 'FAILED' ? 'bad' : 'neutral'}
                        />
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="ghost" onClick={() => onSelect(b.id)}>
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        }
      </QueryState>
    </Section>
  );
}

function CompareForm({
  templates: all,
  strategies,
}: {
  templates: StrategyTemplate[];
  strategies: Strategy[];
}) {
  const templates = all.filter((t) => t.type !== 'CUSTOM_RULES');
  const compare = useCompareBacktests();
  const [ids, setIds] = useState<string[]>([]);
  const [withTemplate, setWithTemplate] = useState(true);
  const [type, setType] = useState(templates[0]?.type ?? 'MA_CROSSOVER');
  const [draft, setDraft] = useState<ParamDraft>(() => draftFromParams(templates[0]?.params ?? []));
  const [range, setRange] = useState<RangeDraft>(DEFAULT_RANGE);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validateRange(range, ids.length === 0);
    const n = ids.length + (withTemplate ? 1 : 0);
    if (n < 1 || n > 5) errs.selection = 'Compare 1 to 5 strategies';
    let parameters = {};
    if (withTemplate) {
      const p = validateParams(templates.find((t) => t.type === type)?.params ?? [], draft);
      if (!p.ok) Object.assign(errs, p.errors);
      else parameters = p.values;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    compare.mutate({
      strategyIds: ids,
      definitions: withTemplate
        ? [{ type, parameters, label: templates.find((t) => t.type === type)?.label }]
        : [],
      ...(range.symbol ? { symbol: range.symbol } : {}),
      from: range.from,
      to: range.to,
      initialCapital: range.capital,
      slippageBps: range.slippage,
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-4">
          <form onSubmit={submit} noValidate className="space-y-4" aria-label="Compare backtests">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Saved strategies</legend>
              {strategies.length === 0 && (
                <p className="text-xs text-muted-foreground">No saved strategies.</p>
              )}
              {strategies.map((s) => (
                <div key={s.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`cmp-${s.id}`}
                    checked={ids.includes(s.id)}
                    onCheckedChange={(c) =>
                      setIds((x) => (c === true ? [...x, s.id] : x.filter((i) => i !== s.id)))
                    }
                  />
                  <Label htmlFor={`cmp-${s.id}`}>
                    {s.name} ({s.symbol})
                  </Label>
                </div>
              ))}
            </fieldset>
            <div className="flex items-center gap-2">
              <Checkbox
                id="cmp-template"
                checked={withTemplate}
                onCheckedChange={(c) => setWithTemplate(c === true)}
              />
              <Label htmlFor="cmp-template">Also compare a template</Label>
            </div>
            {withTemplate && (
              <TemplatePicker
                templates={templates}
                type={type}
                onType={(t) => {
                  setType(t as typeof type);
                  setDraft(draftFromParams(templates.find((x) => x.type === t)?.params ?? []));
                }}
                draft={draft}
                onDraft={setDraft}
                errors={errors}
                prefix="cmp"
              />
            )}
            <RangeFields
              prefix="cmp"
              r={range}
              set={setRange}
              errors={errors}
              symbolLabel={ids.length ? 'Symbol (default: first strategy’s)' : 'Symbol'}
            />
            {errors.selection && (
              <p className="text-xs text-destructive" role="alert">
                {errors.selection}
              </p>
            )}
            {compare.isError && (
              <Alert variant="destructive">
                <AlertTitle>Comparison failed</AlertTitle>
                <AlertDescription>{errorMessage(compare.error)}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={compare.isPending}>
              {compare.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              Compare
            </Button>
          </form>
        </CardContent>
      </Card>
      {compare.data && <ComparisonTable c={compare.data} />}
    </div>
  );
}

function ComparisonTable({ c }: { c: BacktestComparison }) {
  const cell = (v: string | null, kind: 'pct' | 'num' | 'plainPct' = 'num') =>
    v === null ? (
      '—'
    ) : kind === 'pct' ? (
      <PnlText value={v} percent showIcon={false} />
    ) : kind === 'plainPct' ? (
      formatPercent(v)
    ) : (
      formatNumber(v)
    );
  return (
    <section aria-label="Comparison" className="space-y-4" data-testid="comparison">
      <Disclaimer text={c.disclaimer} />
      <DataSourceBanner source={c.dataSource} />
      <p className="text-sm text-muted-foreground">
        {c.symbol} · {formatDate(c.from)} – {formatDate(c.to)} · {c.bars} bars · slippage {c.slippageBps} bps
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table aria-label="Strategy comparison">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>Strategy</TableHead>
              <TableHead className="text-right">Return</TableHead>
              <TableHead className="text-right">CAGR</TableHead>
              <TableHead className="text-right">Max DD</TableHead>
              <TableHead className="text-right">Sharpe</TableHead>
              <TableHead className="text-right">Sortino</TableHead>
              <TableHead className="text-right">Win rate</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right">Fees</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {c.rows.map((r, i) => (
              <TableRow key={`${r.label}-${i}`}>
                <TableCell>
                  <span className="font-medium">{r.label}</span>
                  <span className="block text-xs text-muted-foreground">{humanize(r.strategyType)}</span>
                </TableCell>
                <TableCell className="text-right tabular">{cell(r.metrics.totalReturnPct, 'pct')}</TableCell>
                <TableCell className="text-right tabular">{cell(r.metrics.cagrPct, 'pct')}</TableCell>
                <TableCell className="text-right tabular">
                  {cell(r.metrics.maxDrawdownPct, 'plainPct')}
                </TableCell>
                <TableCell className="text-right tabular">{cell(r.metrics.sharpe)}</TableCell>
                <TableCell className="text-right tabular">{cell(r.metrics.sortino)}</TableCell>
                <TableCell className="text-right tabular">{cell(r.metrics.winRatePct, 'plainPct')}</TableCell>
                <TableCell className="text-right tabular">{r.metrics.tradeCount}</TableCell>
                <TableCell className="text-right tabular">{cell(r.metrics.feesTotal)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/20">
              <TableCell className="font-medium">{c.benchmark.label}</TableCell>
              <TableCell className="text-right tabular">{cell(c.benchmark.totalReturnPct, 'pct')}</TableCell>
              <TableCell colSpan={7} className="text-xs text-muted-foreground">
                Benchmark: buy on the first bar, hold to the end
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
