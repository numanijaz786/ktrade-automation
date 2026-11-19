'use client';

import Link from 'next/link';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { QueryState } from '@/components/states';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useRecommendation } from '@/lib/api/hooks';
import type { RecommendationDetail } from '@/lib/api/types';
import { formatDate, formatDateTime, formatNumber, formatPercent, humanize } from '@/lib/format';
import { OutcomeBadge, SimulatedTag } from './recommendation-list';

function Level({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value === null ? 'Not set' : formatNumber(value)}</dd>
    </div>
  );
}

function TextList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function RecommendationDetailView({ rec }: { rec: RecommendationDetail }) {
  const dq = rec.dataQuality;
  return (
    <div className="space-y-4 overflow-y-auto px-4 pb-6" data-testid="rec-detail">
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeBadge rec={rec} />
        <ProvenanceBadge source={rec.priceSource} />
        {rec.simulated && <SimulatedTag />}
      </div>
      {rec.status === 'NOT_ACTIONABLE' && (
        <p className="rounded-lg border border-amber-600/40 bg-amber-500/10 p-2 text-sm">
          Not actionable. No entry, stop or target is given, and this is not advice to trade.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Level label="Price at the time" value={rec.price} />
        <Level label="Entry from" value={rec.entryLow} />
        <Level label="Entry to" value={rec.entryHigh} />
        <Level label="Stop-loss" value={rec.stop} />
        <Level label="Target 1" value={rec.target1} />
        <Level label="Target 2" value={rec.target2} />
        <Level label="Target 3" value={rec.target3} />
        <Level label="Reward to risk" value={rec.riskReward} />
        <div>
          <dt className="text-xs text-muted-foreground">Holding period</dt>
          <dd>{rec.holdingPeriod ?? 'Not set'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Confidence</dt>
          <dd>
            {humanize(rec.confidenceLevel)}
            {rec.confidence ? ` (${formatNumber(rec.confidence, { dp: 0 })}/100)` : ''}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Made on</dt>
          <dd>{formatDateTime(rec.generatedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Price bar date</dt>
          <dd>{formatDate(rec.asOfBar)}</dd>
        </div>
      </dl>
      <TextList title="Reasons" items={rec.reasons} empty="No reasons were recorded." />
      <TextList
        title="What would make this wrong"
        items={rec.invalidations}
        empty="No invalidation conditions were recorded."
      />
      <section className="space-y-1">
        <h3 className="text-sm font-semibold">Data quality</h3>
        <p className="text-sm">
          Latest price source: {dq.latestBarSource ? humanize(dq.latestBarSource) : 'Not recorded'}
          {dq.barsUsed !== null && <>; {dq.barsUsed} daily bars used</>}. Engine: {rec.engineVersion}.
        </p>
        {dq.missingInputs.length > 0 && (
          <p className="text-sm">Missing inputs: {dq.missingInputs.join(', ')}.</p>
        )}
        {dq.warnings.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-amber-900 dark:text-amber-300">
            {dq.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-1">
        <h3 className="text-sm font-semibold">Outcomes over time</h3>
        {rec.outcomes.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-outcomes">
            Not evaluated yet. An owner can run “Evaluate outcomes” once newer daily prices are stored.
          </p>
        ) : (
          <ol className="space-y-2 border-l pl-4" aria-label="Outcome timeline">
            {rec.outcomes.map((o) => (
              <li key={o.id} className="text-sm" data-testid="outcome-step">
                <p className="font-medium">
                  {humanize(o.status)} · checked to {formatDate(o.lastBarDate)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Return {o.returnPct ? formatPercent(o.returnPct, { signed: true }) : 'not final'}; held{' '}
                  {o.holdingDays} days
                  {o.stopHitAt && `; stop hit ${formatDate(o.stopHitAt)}`}
                  {o.target1HitAt && `; target 1 hit ${formatDate(o.target1HitAt)}`}
                  {o.closedAt && `; closed ${formatDate(o.closedAt)}`}
                  {o.exitPrice && ` at ${formatNumber(o.exitPrice)}`}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export function RecommendationDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useRecommendation(id ?? undefined);
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>
            {q.data ? `${q.data.symbol} · ${humanize(q.data.action)}` : 'Recommendation'}
          </SheetTitle>
          <SheetDescription>
            {q.data
              ? `${humanize(q.data.horizon)} · saved as made, never edited.`
              : 'Loading the saved record.'}
          </SheetDescription>
        </SheetHeader>
        {q.data && (
          <p className="px-4 text-sm">
            <Link
              href={`/research/${encodeURIComponent(q.data.symbol)}`}
              className="underline underline-offset-2"
            >
              Open full research for {q.data.symbol}
            </Link>
          </p>
        )}
        {id && <QueryState query={q}>{(rec) => <RecommendationDetailView rec={rec} />}</QueryState>}
      </SheetContent>
    </Sheet>
  );
}
