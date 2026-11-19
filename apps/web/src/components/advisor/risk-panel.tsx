'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/field';
import { Section } from '@/components/page-header';
import { QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MAX_RISK_PCT, riskAmount, validateRiskPct } from '@/lib/api/advisor-rules';
import { errorMessage } from '@/lib/api/errors';
import {
  useAdvisorDailyReport,
  useAdvisorSettings,
  useMe,
  useRiskLimits,
  useUpdateAdvisorSettings,
} from '@/lib/api/hooks';
import type { RiskLimits } from '@/lib/api/types';
import { formatNumber, formatPercent, formatPKR, formatQty } from '@/lib/format';
import { useActivePortfolio } from '@/lib/portfolio-context';
import { Unavailable } from './advisor-bits';

/** Risk per trade: what share of your portfolio you accept to lose if a stop-loss is hit. */
export function RiskPerTradeForm({ current, isOwner }: { current: string; isOwner: boolean }) {
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const save = useUpdateAdvisorSettings();
  function submit(e: FormEvent) {
    e.preventDefault();
    const err = validateRiskPct(value);
    setError(err);
    if (err) return;
    save.mutate(value.trim(), {
      onSuccess: () => toast.success('Risk per trade saved'),
      onError: (e2) => setError(errorMessage(e2)),
    });
  }
  return (
    <form onSubmit={submit} className="max-w-sm space-y-3" aria-label="Risk per trade">
      <FormField
        id="risk-pct"
        label="Risk per trade (% of your portfolio)"
        error={error ?? undefined}
        hint={`Greater than 0 and at most ${MAX_RISK_PCT}. Most people use 0.5 to 2.`}
      >
        <Input
          id="risk-pct"
          inputMode="decimal"
          value={value}
          disabled={!isOwner}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'risk-pct-error' : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
      </FormField>
      {isOwner ? (
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">Only the account owner can change this.</p>
      )}
    </form>
  );
}

function LimitsSummary({ l }: { l: RiskLimits }) {
  const rows: [string, string][] = [
    ['Largest single order', formatPKR(l.maxOrderValue)],
    ['Most shares in one order', formatQty(l.maxOrderQty)],
    ['Price band (how far from the last price an order may be)', formatPercent(l.priceBandPct)],
    ['Most value traded per day', formatPKR(l.maxDailyValue)],
    ['Most orders per day', formatNumber(String(l.maxDailyCount), { dp: 0 })],
    ['Largest share of the portfolio in one stock', formatPercent(l.maxPositionPct)],
    ['Daily loss limit', formatPercent(l.maxDailyLossPct)],
    ['Market orders allowed', l.allowMarketOrders ? 'Yes' : 'No (use limit orders)'],
  ];
  return (
    <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2" data-testid="risk-limits">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 border-b py-1 text-sm">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-medium tabular">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Position size in plain words, with a worked example built only from numbers the API returned. */
function PositionSizeExplainer({ portfolioId, riskPct }: { portfolioId: string; riskPct: string }) {
  const report = useAdvisorDailyReport(portfolioId, 'SWING');
  return (
    <QueryState query={report} rows={3}>
      {(r) => {
        const example = r.topBuys.find((b) => b.plan);
        return (
          <div className="space-y-3 text-sm" data-testid="size-explainer">
            <p>
              <strong>Position size</strong> is how many shares to buy so that, if the stop-loss is hit, you
              lose no more than your risk per trade. A closer stop means more shares; a farther stop means
              fewer.
            </p>
            {r.portfolio.equity ? (
              <p>
                Your portfolio is worth {formatPKR(r.portfolio.equity)}. At {formatNumber(riskPct, { dp: 2 })}
                % risk per trade, the most you should lose on one idea is{' '}
                <strong>{formatPKR(riskAmount(r.portfolio.equity, riskPct))}</strong> (the portfolio value
                times {formatNumber(riskPct, { dp: 2 })}%).
              </p>
            ) : (
              <p>
                <Unavailable what="Portfolio value" />, so the amount at risk cannot be shown.
              </p>
            )}
            {example?.plan ? (
              <p data-testid="size-example">
                Example from today’s advice for <strong>{example.symbol}</strong>: buy up to{' '}
                {formatQty(example.plan.size.quantity)} shares near {formatNumber(example.plan.entry.high)},
                with a stop-loss at {formatNumber(example.plan.stopLoss.price)}. If the stop is hit, the most
                you lose is {formatPKR(example.plan.size.maxLossAtStop)}. The advisor worked this out; nothing
                is estimated on this page.
              </p>
            ) : (
              <p className="text-muted-foreground">
                There is no buy idea today, so there is no stock-specific example to show.
              </p>
            )}
          </div>
        );
      }}
    </QueryState>
  );
}

export function RiskPage() {
  const { portfolioId } = useActivePortfolio();
  const me = useMe();
  const settings = useAdvisorSettings();
  const limits = useRiskLimits(portfolioId);
  return (
    <div className="space-y-8">
      <Section
        title="Risk per trade"
        description="The advisor sizes every idea so a stop-loss hit costs you about this much."
      >
        <QueryState query={settings} rows={2}>
          {(s) => (
            <div className="space-y-2">
              <RiskPerTradeForm
                key={s.riskPerTradePct}
                current={s.riskPerTradePct}
                isOwner={me.data?.role === 'OWNER'}
              />
              {s.isDefault && (
                <p className="text-xs text-muted-foreground">This is the default. Save to set your own.</p>
              )}
              {portfolioId && (
                <div className="pt-2">
                  <h3 className="mb-2 text-sm font-semibold">What this means for your money</h3>
                  <PositionSizeExplainer portfolioId={portfolioId} riskPct={s.riskPerTradePct} />
                </div>
              )}
            </div>
          )}
        </QueryState>
      </Section>
      <Section
        title="Portfolio risk limits"
        description="Hard limits checked on every order before it can be approved."
      >
        {portfolioId ? (
          <QueryState query={limits} rows={4}>
            {(l) =>
              l ? (
                <LimitsSummary l={l} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No risk limits are set for this portfolio yet.
                </p>
              )
            }
          </QueryState>
        ) : (
          <p className="text-sm text-muted-foreground">Pick a portfolio to see its limits.</p>
        )}
      </Section>
    </div>
  );
}
