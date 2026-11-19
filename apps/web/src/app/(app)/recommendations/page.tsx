'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { FormField } from '@/components/field';
import { NativeSelect } from '@/components/native-select';
import { PageHeader, Section } from '@/components/page-header';
import { EmptyState, QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api/errors';
import {
  useEvaluateOutcomes,
  useMe,
  useRecommendationPerformance,
  useRecommendations,
} from '@/lib/api/hooks';
import type { RecommendationQuery } from '@/lib/api/types';
import { humanize } from '@/lib/format';
import { PerformancePanel } from './performance-panel';
import { RecommendationDrawer } from './recommendation-drawer';
import { RecommendationsTable } from './recommendation-list';

const PAGE = 25;
const ACTIONS = ['BUY', 'SELL', 'HOLD', 'WATCHLIST', 'AVOID'] as const;
const HORIZONS = ['SHORT_TERM', 'MEDIUM_TERM', 'LONG_TERM'] as const;
const STATUSES = ['ACTIONABLE', 'NOT_ACTIONABLE'] as const;

interface Filters {
  action: string;
  horizon: string;
  status: string;
  symbol: string;
  from: string;
  to: string;
}
const NO_FILTERS: Filters = { action: '', horizon: '', status: '', symbol: '', from: '', to: '' };

function Select({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <FormField id={id} label={label}>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {humanize(o)}
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
}

export default function RecommendationsPage() {
  const me = useMe();
  const isOwner = me.data?.role === 'OWNER';
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [offset, setOffset] = useState(0);
  const [includeSimulated, setIncludeSimulated] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const evaluate = useEvaluateOutcomes();

  const filter = {
    action: (f.action || undefined) as RecommendationQuery['action'],
    horizon: (f.horizon || undefined) as RecommendationQuery['horizon'],
    status: (f.status || undefined) as RecommendationQuery['status'],
    symbol: f.symbol.trim() || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
  };
  const list = useRecommendations({ ...filter, limit: PAGE, offset });
  const perf = useRecommendationPerformance({ ...filter, includeSimulated });
  const set = (k: keyof Filters, v: string) => {
    setF((p) => ({ ...p, [k]: v }));
    setOffset(0);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recommendation history"
        description="Every recommendation is saved as it was made and never edited or hidden. Outcomes are added later from stored daily prices."
        actions={
          isOwner && (
            <Button
              variant="outline"
              size="sm"
              disabled={evaluate.isPending}
              onClick={() =>
                evaluate.mutate(undefined, {
                  onSuccess: (r) =>
                    toast.success(
                      `Checked ${r.considered}: ${r.appended} updated, ${r.closed} closed, ${r.noNewData} waiting for newer prices`,
                    ),
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              <RefreshCw aria-hidden="true" /> Evaluate outcomes
            </Button>
          )
        }
      />

      <Section
        title="Performance"
        description="How past recommendations turned out. Not a prediction."
        actions={
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeSimulated}
              onChange={(e) => setIncludeSimulated(e.target.checked)}
            />
            Include simulated-price recommendations
          </label>
        }
      >
        <QueryState query={perf} rows={4}>
          {(p) => <PerformancePanel perf={p} includeSimulated={includeSimulated} />}
        </QueryState>
      </Section>

      <Section title="History">
        <form
          className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6"
          aria-label="Filters"
          onSubmit={(e) => e.preventDefault()}
        >
          <Select
            id="rf-action"
            label="Action"
            value={f.action}
            options={ACTIONS}
            onChange={(v) => set('action', v)}
          />
          <Select
            id="rf-horizon"
            label="Horizon"
            value={f.horizon}
            options={HORIZONS}
            onChange={(v) => set('horizon', v)}
          />
          <Select
            id="rf-status"
            label="Status"
            value={f.status}
            options={STATUSES}
            onChange={(v) => set('status', v)}
          />
          <FormField id="rf-symbol" label="Symbol">
            <Input
              id="rf-symbol"
              value={f.symbol}
              onChange={(e) => set('symbol', e.target.value.toUpperCase())}
            />
          </FormField>
          <FormField id="rf-from" label="From">
            <Input id="rf-from" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} />
          </FormField>
          <FormField id="rf-to" label="To">
            <Input id="rf-to" type="date" value={f.to} onChange={(e) => set('to', e.target.value)} />
          </FormField>
        </form>
        <QueryState query={list} rows={5}>
          {(page) =>
            page.data.length === 0 ? (
              <EmptyState
                title={page.total === 0 && offset === 0 ? 'No recommendations match' : 'No more results'}
                description="Recommendations appear here when they are generated and saved. Clear the filters to see everything."
              />
            ) : (
              <div className="space-y-3">
                <RecommendationsTable rows={page.data} onOpen={(r) => setOpenId(r.id)} />
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">
                    Showing {offset + 1} to {offset + page.data.length} of {page.total}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - PAGE))}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={offset + PAGE >= page.total}
                      onClick={() => setOffset(offset + PAGE)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </div>
            )
          }
        </QueryState>
      </Section>

      <RecommendationDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
