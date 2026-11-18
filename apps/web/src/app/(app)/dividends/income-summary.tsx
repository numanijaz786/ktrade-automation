'use client';

import { StatTile } from '@/components/stat-tile';
import { summarizeDividendIncome } from '@/lib/api/dividends-rules';
import type { DividendEntitlement } from '@/lib/api/types';
import { formatPKR } from '@/lib/format';

/** Received net, WHT withheld and pending gross — sums of recorded figures, each with its weakest provenance. */
export function IncomeSummary({ rows, loading }: { rows: DividendEntitlement[]; loading?: boolean }) {
  const s = summarizeDividendIncome(rows);
  return (
    <div className="grid gap-3 sm:grid-cols-3" aria-label="Dividend income summary">
      <StatTile
        label="Received (net)"
        loading={loading}
        value={formatPKR(s.receivedNet.value)}
        source={s.receivedNet.source ?? undefined}
        hint={s.receivedNet.count ? `${s.receivedNet.count} payment(s) recorded` : 'No payments recorded yet'}
      />
      <StatTile
        label="WHT withheld"
        loading={loading}
        value={formatPKR(s.whtWithheld.value)}
        source={s.whtWithheld.source ?? undefined}
        hint="As entered from payment advices"
      />
      <StatTile
        label="Pending (gross, before WHT)"
        loading={loading}
        value={formatPKR(s.pendingGross.value)}
        source={s.pendingGross.source ?? undefined}
        note="Estimated from settled holdings; not yet received."
        hint={
          s.pendingWithoutTax > 0
            ? `${s.pendingWithoutTax} without a verified WHT rate — net not estimated`
            : `${s.pendingGross.count} unpaid entitlement(s)`
        }
      />
    </div>
  );
}
