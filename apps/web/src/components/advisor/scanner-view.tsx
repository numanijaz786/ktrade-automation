'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/states';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ScannerReport } from '@/lib/api/types-advisor';
import { formatNumber } from '@/lib/format';
import { ActionBadge, PriceLine, Unavailable } from './advisor-bits';

/** Ranked scan results. Each row says in plain words which number matched which threshold. */
export function ScannerResults({ report }: { report: ScannerReport }) {
  if (report.results.length === 0)
    return (
      <EmptyState
        title="No stock meets this filter today — that’s a valid result"
        description={
          report.note ??
          'The scanner only looks at stocks with verified, fresh data, and it never relaxes a filter to find something.'
        }
      />
    );
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Stock</TableHead>
              <TableHead>Why it matched</TableHead>
              <TableHead>Latest price</TableHead>
              <TableHead>Advisor view</TableHead>
              <TableHead>Confidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.results.map((r) => (
              <TableRow key={r.symbol} data-testid="scanner-row">
                <TableCell>{r.rank}</TableCell>
                <TableCell>
                  <Link
                    href={`/research/${encodeURIComponent(r.symbol)}`}
                    className="font-medium hover:underline"
                  >
                    {r.symbol}
                  </Link>
                  {r.name && <span className="block text-xs text-muted-foreground">{r.name}</span>}
                </TableCell>
                <TableCell>
                  <span data-testid="matched">
                    {r.matched.metric}: <span className="font-medium tabular">{r.matched.value}</span> (needed{' '}
                    {r.matched.threshold})
                  </span>
                </TableCell>
                <TableCell>
                  <PriceLine price={r.price} />
                </TableCell>
                <TableCell>
                  <ActionBadge action={r.action} />
                </TableCell>
                <TableCell className="tabular">
                  {r.confidence ? `${formatNumber(r.confidence, { dp: 0 })} / 100` : <Unavailable />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        {report.results.length} of {report.verifiedEvaluations} stocks with verified data matched. A match is
        a reason to look closer, not a reason to buy.
      </p>
    </div>
  );
}
