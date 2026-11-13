'use client';

import Link from 'next/link';
import { CheckCircle2, PowerOff, XCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { FeeLine, RiskCheck } from '@/lib/api/types';
import { formatPKR, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ProvenanceBadge } from './provenance-badge';

/** Per-component fees/taxes, each with its own provenance badge (ESTIMATED until a contract note confirms). */
export function FeeBreakdown({
  lines,
  total,
  caption = 'Fee breakdown',
  className,
}: {
  lines: FeeLine[];
  total?: string | null;
  caption?: string;
  className?: string;
}) {
  if (!lines.length) return <p className="text-xs text-muted-foreground">No fee lines recorded.</p>;
  return (
    <table className={cn('w-full text-xs tabular', className)} aria-label={caption}>
      <tbody>
        {lines.map((f, i) => (
          <tr key={`${f.component}-${i}`} className="border-b last:border-0">
            <td className="py-1 pr-2">
              {humanize(f.component)}
              {(f.note || f.basis) && (
                <span className="block text-[0.6875rem] text-muted-foreground">{f.note ?? f.basis}</span>
              )}
            </td>
            <td className="py-1 text-right whitespace-nowrap">{formatPKR(f.amount)}</td>
            <td className="py-1 pl-2 text-right">
              <ProvenanceBadge source={f.source} compact />
            </td>
          </tr>
        ))}
        {total !== undefined && (
          <tr className="font-medium">
            <td className="pt-1.5">Total fees</td>
            <td className="pt-1.5 text-right">{formatPKR(total)}</td>
            <td />
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** Every risk rule with pass/fail, observed value and limit. Pass/fail uses an icon and a word, never colour alone. */
export function RiskChecks({ checks }: { checks: RiskCheck[] }) {
  if (!checks.length) return <p className="text-xs text-muted-foreground">No risk checks recorded.</p>;
  return (
    <ul className="divide-y rounded-lg border text-sm" aria-label="Risk checks">
      {checks.map((c) => (
        <li
          key={c.rule}
          data-rule={c.rule}
          data-passed={c.passed}
          className={cn('flex items-start gap-2 px-3 py-2', !c.passed && 'bg-destructive/5')}
        >
          {c.passed ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-gain" aria-hidden="true" />
          ) : (
            <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {humanize(c.rule)}{' '}
              <span className={cn('text-xs', c.passed ? 'text-muted-foreground' : 'text-destructive')}>
                {c.passed ? 'pass' : 'FAIL'}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">{c.message}</p>
          </div>
          {(c.observed || c.limit) && (
            <dl className="shrink-0 text-right text-xs tabular">
              {c.observed && (
                <div>
                  <dt className="inline text-muted-foreground">observed </dt>
                  <dd className="inline">{c.observed}</dd>
                </div>
              )}
              {c.limit && (
                <div>
                  <dt className="inline text-muted-foreground">limit </dt>
                  <dd className="inline">{c.limit}</dd>
                </div>
              )}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Live trading is disabled by the global kill switch. Explains the only supported way to enable it:
 * Settings → Kill switch, confirmed with step-up. Never suggests a bypass.
 */
export function KillSwitchNotice({ className }: { className?: string }) {
  return (
    <Alert variant="destructive" className={className} data-testid="kill-switch-notice">
      <PowerOff aria-hidden="true" />
      <AlertTitle>Live trading is switched off (kill switch engaged)</AlertTitle>
      <AlertDescription>
        <p>
          Live orders cannot be previewed or approved while the kill switch is engaged. To enable live
          trading, open{' '}
          <Link href="/settings#kill-switch" className="font-medium underline underline-offset-2">
            Settings → Kill switch
          </Link>
          , give a reason and confirm with step-up (your authenticator code or password). Execution stays
          manual: you place every approved order yourself in the KTrade app. Paper trading is unaffected.
        </p>
      </AlertDescription>
    </Alert>
  );
}
