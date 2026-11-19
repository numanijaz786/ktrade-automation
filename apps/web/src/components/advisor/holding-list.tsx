'use client';

import { Section } from '@/components/page-header';
import { PnlText } from '@/components/money';
import { EmptyState } from '@/components/states';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { HoldingAdvice } from '@/lib/api/types-advisor';
import { formatNumber, formatPKR, formatQty } from '@/lib/format';
import { Disclaimer, PriceLine, Unavailable } from './advisor-bits';
import { HoldingCard, TEMPORARY_DECLINE_TEXT } from './holding-card';

/** Exit signals first, then the rest. The order is only a presentation choice; no advice is changed. */
const urgency = (h: HoldingAdvice): number =>
  h.advice === 'EXIT' ? 0 : h.advice === 'PARTIAL_SELL' ? 1 : h.advice === 'TARGET_REACHED' ? 2 : 3;

export function HoldingList({ holdings, mode }: { holdings: HoldingAdvice[]; mode: 'sell' | 'portfolio' }) {
  if (holdings.length === 0)
    return <EmptyState title="No holdings in this portfolio" description="Nothing to review yet." />;
  const sorted = [...holdings].sort((a, b) => urgency(a) - urgency(b) || a.symbol.localeCompare(b.symbol));
  return (
    <div className="space-y-6" data-testid="holding-list">
      {mode === 'sell' && (
        <p
          className="rounded-md border border-sky-600/30 bg-sky-600/5 p-3 text-sm"
          data-testid="decline-banner"
        >
          {TEMPORARY_DECLINE_TEXT}
        </p>
      )}
      {mode === 'portfolio' && (
        <Section
          title="Dividends and fees"
          description="Per holding. Selling fees are estimates from the current fee schedule, not a contract note."
        >
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stock</TableHead>
                  <TableHead>Shares</TableHead>
                  <TableHead>Average price</TableHead>
                  <TableHead>Latest price</TableHead>
                  <TableHead>Dividends received</TableHead>
                  <TableHead>Estimated selling fees</TableHead>
                  <TableHead>If sold now (net)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((h) => (
                  <TableRow key={h.symbol}>
                    <TableCell className="font-medium">{h.symbol}</TableCell>
                    <TableCell className="tabular">{formatQty(h.quantity)}</TableCell>
                    <TableCell className="tabular">
                      {h.avgCost ? formatNumber(h.avgCost) : <Unavailable />}
                    </TableCell>
                    <TableCell>
                      <PriceLine price={h.price} />
                    </TableCell>
                    <TableCell className="tabular">
                      {h.pnl?.dividendsReceived ? formatPKR(h.pnl.dividendsReceived) : <Unavailable />}
                    </TableCell>
                    <TableCell className="tabular">
                      {h.pnl?.estimatedSellFees ? formatPKR(h.pnl.estimatedSellFees) : <Unavailable />}
                    </TableCell>
                    <TableCell>
                      {h.pnl?.unrealizedNet ? <PnlText value={h.pnl.unrealizedNet} /> : <Unavailable />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {sorted.map((h) => (
          <HoldingCard key={h.symbol} h={h} />
        ))}
      </div>
      <Disclaimer />
    </div>
  );
}
