'use client';

import Link from 'next/link';
import { PnlText } from '@/components/money';
import { StatusPill, type StatusTone } from '@/components/status-badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Dec } from '@/lib/decimal';
import { HOLDING_ADVICE_LABEL } from '@/lib/api/advisor-rules';
import type { HoldingAdvice, HoldingAdviceKind } from '@/lib/api/types-advisor';
import { formatNumber, formatPercent, formatPKR, formatQty } from '@/lib/format';
import { KeyValue, PriceLine, Unavailable, WarningList } from './advisor-bits';

const ADVICE_TONE: Record<HoldingAdviceKind, StatusTone> = {
  CONTINUE_HOLDING: 'good',
  PARTIAL_SELL: 'warn',
  EXIT: 'bad',
  TARGET_REACHED: 'info',
};

export const TEMPORARY_DECLINE_TEXT =
  'Never sell just because of a temporary decline. A lower price alone is not a reason to sell: the advisor only suggests selling when its stop-loss, a target or a real change in the company says so.';

const isLoss = (v: string | null): boolean => {
  if (!v) return false;
  try {
    return Dec.of(v).isNeg();
  } catch {
    return false;
  }
};

/** One holding with fees-aware P&L and the advisor's exit advice. Every figure comes from the API. */
export function HoldingCard({ h }: { h: HoldingAdvice }) {
  const pnl = h.pnl;
  const simulated = (pnl?.priceSource ?? h.price?.source) === 'SIMULATED';
  const losing = isLoss(pnl?.unrealizedNet ?? null) || isLoss(pnl?.unrealizedGross ?? null);
  const showDeclineNote = h.advice === 'CONTINUE_HOLDING' && losing;
  return (
    <Card data-testid="holding-card" data-symbol={h.symbol} className="gap-3">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold">
              <Link href={`/research/${encodeURIComponent(h.symbol)}`} className="hover:underline">
                {h.symbol}
              </Link>
              <span className="ml-2 text-sm font-normal text-muted-foreground">{h.name}</span>
            </h3>
            <p className="text-xs text-muted-foreground">{h.sector ?? 'Sector unavailable'}</p>
          </div>
          {h.advice ? (
            <StatusPill tone={ADVICE_TONE[h.advice]}>{HOLDING_ADVICE_LABEL[h.advice]}</StatusPill>
          ) : (
            <StatusPill tone="neutral">No advice</StatusPill>
          )}
        </div>
        <p className="text-sm">{h.headline}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KeyValue label="Shares you own">{formatQty(h.quantity)}</KeyValue>
          <KeyValue label="Your average purchase price">
            {h.avgCost ? formatNumber(h.avgCost) : <Unavailable />}
          </KeyValue>
          <KeyValue label="Value now">{h.marketValue ? formatPKR(h.marketValue) : <Unavailable />}</KeyValue>
          <div>
            <dt className="text-xs text-muted-foreground">Latest price</dt>
            <dd>
              <PriceLine price={h.price} />
            </dd>
          </div>
        </dl>

        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Profit or loss (after fees)</p>
          {pnl ? (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="pnl">
              <KeyValue label="Before selling fees">
                <PnlText value={pnl.unrealizedGross} />
              </KeyValue>
              <KeyValue label="Estimated selling fees">
                {pnl.estimatedSellFees ? formatPKR(pnl.estimatedSellFees) : <Unavailable />}
              </KeyValue>
              <KeyValue label="If you sold now (net)">
                {pnl.unrealizedNet ? (
                  <>
                    <PnlText value={pnl.unrealizedNet} />
                    {pnl.unrealizedNetPct && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {formatPercent(pnl.unrealizedNetPct, { signed: true })} of cost
                      </span>
                    )}
                  </>
                ) : (
                  <Unavailable />
                )}
              </KeyValue>
              <KeyValue label="Dividends received">
                {pnl.dividendsReceived ? formatPKR(pnl.dividendsReceived) : <Unavailable />}
              </KeyValue>
            </dl>
          ) : (
            <p className="text-sm">
              <Unavailable what="Profit and loss" /> (no stored price).
            </p>
          )}
          {simulated && (
            <p className="mt-1 text-xs text-fuchsia-800 dark:text-fuchsia-300">
              These figures use SIMULATED prices: for testing only, not real profit or loss.
            </p>
          )}
        </div>

        {h.advice && (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="exit-plan">
            <KeyValue label="Sell range">
              {h.sellRange ? (
                `${formatNumber(h.sellRange.low)} – ${formatNumber(h.sellRange.high)}`
              ) : (
                <Unavailable />
              )}
            </KeyValue>
            <KeyValue label="Stop-loss">
              {h.stop ? (
                <>
                  {formatNumber(h.stop.price)}
                  {h.stop.origin === 'SUGGESTED_FROM_ATR' && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      suggested from volatility
                    </span>
                  )}
                </>
              ) : (
                <Unavailable />
              )}
            </KeyValue>
            <KeyValue label="Targets">
              {h.targets.length === 0 ? (
                <Unavailable />
              ) : (
                h.targets.map((t) => `T${t.n} ${formatNumber(t.price)}`).join(' · ')
              )}
              {h.targets.length > 0 && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {h.targetsReached} reached
                </span>
              )}
            </KeyValue>
            <KeyValue label="Shares to sell now">
              {h.suggestedSellQty ? formatQty(h.suggestedSellQty) : 'none'}
            </KeyValue>
          </dl>
        )}
        {h.planNote && <p className="text-xs text-muted-foreground">{h.planNote}</p>}

        {showDeclineNote && (
          <p
            className="rounded-md border border-sky-600/30 bg-sky-600/5 p-2 text-sm"
            data-testid="decline-note"
          >
            {TEMPORARY_DECLINE_TEXT}
          </p>
        )}

        {h.reasons.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-semibold">Why</p>
            <ul className="list-disc pl-5 text-sm">
              {h.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {h.notActionableReasons.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-semibold">Why there is no advice</p>
            <ul className="list-disc pl-5 text-sm">
              {h.notActionableReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {h.invalidations.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-semibold">What would change this advice</p>
            <ul className="list-disc pl-5 text-sm">
              {h.invalidations.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        <WarningList items={h.warnings} />
      </CardContent>
    </Card>
  );
}
