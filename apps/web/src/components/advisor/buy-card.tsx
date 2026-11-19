'use client';

import Link from 'next/link';
import { ArrowRight, FileSearch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useKillSwitch } from '@/lib/api/hooks';
import {
  HORIZON_LABEL,
  reasonGroup,
  tradePrefillHref,
  whenToBuy,
  type ReasonGroup,
} from '@/lib/api/advisor-rules';
import type { AdvisorEvaluation } from '@/lib/api/types-advisor';
import { formatNumber, formatPercent, formatPKR, formatQty, humanize } from '@/lib/format';
import { ActionBadge, KeyValue, PriceLine, Unavailable, WarningList } from './advisor-bits';

const GROUP_ORDER: ReasonGroup[] = ['Technical', 'Fundamental', 'Valuation', 'Other'];

function LiveTradingNote() {
  const ks = useKillSwitch();
  if (ks.data?.liveTradingEnabled !== false) return null;
  return (
    <p className="text-xs text-amber-900 dark:text-amber-300" data-testid="live-disabled">
      Live trading is switched off, so a live order cannot be approved right now. You can still prepare a
      preview, for example on a paper portfolio.
    </p>
  );
}

function WhyBuy({ ev }: { ev: AdvisorEvaluation }) {
  if (ev.reasons.length === 0) return <Unavailable what="Reasons" />;
  const groups = GROUP_ORDER.map((g) => ({
    g,
    items: ev.reasons.filter((r) => reasonGroup(r.ruleId) === g),
  }));
  return (
    <div className="space-y-2">
      {groups
        .filter((x) => x.items.length > 0)
        .map(({ g, items }) => (
          <div key={g}>
            <p className="text-xs font-medium text-muted-foreground">{g} reasons</p>
            <ul className="list-disc space-y-0.5 pl-5 text-sm">
              {items.map((r) => (
                <li key={`${r.ruleId}-${r.text}`}>
                  <span className="font-medium">{r.supports === 'BULLISH' ? 'For: ' : 'Against: '}</span>
                  {r.text}
                </li>
              ))}
            </ul>
          </div>
        ))}
      <p className="text-xs text-muted-foreground">
        News is not part of these rules. See “News affecting you” on the advisor page.
      </p>
    </div>
  );
}

/**
 * One buy idea, straight from the API. Every number shown here (entry range, stop, targets, size, confidence)
 * was returned by the API; if a field is missing it says “unavailable”. Advisory only: nothing is submitted.
 */
export function BuyCard({ ev }: { ev: AdvisorEvaluation }) {
  const plan = ev.plan;
  const timing = whenToBuy(ev);
  const href = tradePrefillHref(ev);
  const c = ev.confidence;
  return (
    <Card data-testid="buy-card" data-symbol={ev.symbol} className="gap-3">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold">
              <Link href={`/research/${encodeURIComponent(ev.symbol)}`} className="hover:underline">
                {ev.symbol}
              </Link>
              {ev.name && <span className="ml-2 text-sm font-normal text-muted-foreground">{ev.name}</span>}
            </h3>
            <p className="text-xs text-muted-foreground">
              {ev.sector ?? 'Sector unavailable'} · {HORIZON_LABEL[ev.horizon]} view
              {ev.rank ? ` · rank ${ev.rank}` : ''}
            </p>
          </div>
          <ActionBadge action={ev.action} />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Latest price</p>
          <PriceLine price={ev.price} />
        </div>
        <p className="text-sm">{ev.headline}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {plan ? (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KeyValue label="Buy between">
                {formatNumber(plan.entry.low)} – {formatNumber(plan.entry.high)}
              </KeyValue>
              <KeyValue label="Stop-loss (sell if it falls to)">
                {formatNumber(plan.stopLoss.price)}
                {plan.stopLoss.downsidePct && (
                  <span className="block text-xs font-normal text-muted-foreground">
                    about {formatPercent(plan.stopLoss.downsidePct)} below entry
                  </span>
                )}
              </KeyValue>
              <KeyValue label="Holding period">{plan.holdingPeriod || <Unavailable />}</KeyValue>
              <KeyValue label="Confidence">
                {c ? `${formatNumber(c.score, { dp: 0 })} / 100 (${humanize(c.level)})` : <Unavailable />}
              </KeyValue>
            </dl>

            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label={`Targets for ${ev.symbol}`}>
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Target</th>
                    <th className="py-1 pr-3 font-medium">Price</th>
                    <th className="py-1 pr-3 font-medium">Gain if reached</th>
                    <th className="py-1 font-medium">Reward for each 1 of risk</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.targets.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-1">
                        <Unavailable what="Targets" />
                      </td>
                    </tr>
                  )}
                  {plan.targets.map((t) => (
                    <tr key={t.n} className="border-t">
                      <td className="py-1 pr-3">Target {t.n}</td>
                      <td className="py-1 pr-3 tabular">{formatNumber(t.price)}</td>
                      <td className="py-1 pr-3 tabular">
                        {t.upsidePct ? formatPercent(t.upsidePct) : <Unavailable />}
                      </td>
                      <td className="py-1 tabular">
                        {t.riskReward ? formatNumber(t.riskReward) : <Unavailable />}
                        {t.netRiskReward && (
                          <span className="text-xs text-muted-foreground">
                            {' '}
                            ({formatNumber(t.netRiskReward)} after fees)
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Suggested size</p>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KeyValue label="Shares">
                  {plan.size.quantity ? formatQty(plan.size.quantity) : <Unavailable />}
                </KeyValue>
                <KeyValue label="Share of portfolio">
                  {plan.size.allocationPct ? formatPercent(plan.size.allocationPct) : <Unavailable />}
                </KeyValue>
                <KeyValue label="Estimated cost (with fees)">
                  {plan.size.estimatedCost ? formatPKR(plan.size.estimatedCost) : <Unavailable />}
                  {plan.size.estimatedBuyFees && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      of which fees {formatPKR(plan.size.estimatedBuyFees)}
                    </span>
                  )}
                </KeyValue>
                <KeyValue label="Most you lose at the stop">
                  {plan.size.maxLossAtStop ? formatPKR(plan.size.maxLossAtStop) : <Unavailable />}
                </KeyValue>
              </dl>
            </div>
          </>
        ) : (
          <p className="text-sm" data-testid="no-plan">
            <Unavailable what="Entry range, stop-loss and targets" />. They are only shown when the advisor
            returns a full plan.
          </p>
        )}

        {c && (
          <details className="rounded-md border p-2 text-sm">
            <summary className="cursor-pointer font-medium">How the confidence number is made</summary>
            <ul className="mt-2 space-y-1">
              {c.components.map((k) => (
                <li key={k.name}>
                  <span className="font-medium">{humanize(k.name)}</span> (weight {k.weight}%): scored{' '}
                  {formatNumber(k.score, { dp: 0 })} out of 100, adds{' '}
                  {formatNumber(k.contribution, { dp: 1 })}.{' '}
                  <span className="text-muted-foreground">{k.detail}</span>
                </li>
              ))}
              {c.caps.map((cap) => (
                <li key={cap} className="text-amber-900 dark:text-amber-300">
                  Cap applied: {cap}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div>
          <p className="mb-1 text-sm font-semibold">Why buy</p>
          <WhyBuy ev={ev} />
        </div>

        <div data-testid="when-to-buy" data-timing={timing.kind}>
          <p className="mb-1 text-sm font-semibold">When to buy</p>
          <p className="text-sm">{timing.text}</p>
        </div>

        {ev.invalidation.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-semibold">This idea is wrong if</p>
            <ul className="list-disc pl-5 text-sm">
              {ev.invalidation.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        )}
        <WarningList items={ev.warnings} />
        {ev.explanation?.available && ev.explanation.summary && (
          <p className="text-sm text-muted-foreground">{ev.explanation.summary}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {href ? (
            <Button asChild size="sm">
              <Link href={href}>
                Prepare order preview <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          ) : (
            <Button size="sm" disabled>
              Prepare order preview
            </Button>
          )}
          <Button asChild size="sm" variant="outline">
            <Link href={`/research/${encodeURIComponent(ev.symbol)}`}>
              <FileSearch aria-hidden="true" /> Full research
            </Link>
          </Button>
          <p className="text-xs text-muted-foreground">
            Advisory only. This opens the order form with the numbers filled in; nothing is sent until you
            preview, approve and place it yourself.
          </p>
        </div>
        <LiveTradingNote />
      </CardContent>
    </Card>
  );
}
