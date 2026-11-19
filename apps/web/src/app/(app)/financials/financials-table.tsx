'use client';

import { Pencil } from 'lucide-react';
import { ProvenanceBadge } from '@/components/provenance-badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FINANCIAL_ITEM_LABELS, isPerShareItem } from '@/lib/api/research-rules';
import { FINANCIAL_ITEM_KEYS, type FinancialPeriod } from '@/lib/api/types';
import { formatDate, formatNumber, humanize } from '@/lib/format';
import { isWebUrl } from '../intelligence/news-feed';

/** Only the figures the API returned are listed; a missing figure is simply absent, never zero. */
export function FinancialsTable({
  rows,
  isOwner,
  onEdit,
}: {
  rows: FinancialPeriod[];
  isOwner: boolean;
  onEdit: (p: FinancialPeriod) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <Table aria-label="Financial periods">
        <TableHeader>
          <TableRow>
            <TableHead>Period end</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Published</TableHead>
            <TableHead>Currency</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Figures entered</TableHead>
            {isOwner && <TableHead className="w-0" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => (
            <TableRow key={p.id} data-testid="financial-row">
              <TableCell className="whitespace-nowrap">{formatDate(p.periodEnd)}</TableCell>
              <TableCell>{humanize(p.periodType)}</TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(p.publishedAt)}</TableCell>
              <TableCell>{p.currency}</TableCell>
              <TableCell className="whitespace-normal">
                <div className="flex flex-wrap items-center gap-1.5">
                  <ProvenanceBadge source={p.source} />
                  <span className="text-xs">{p.sourceRef}</span>
                  {isWebUrl(p.sourceUrl) && (
                    <a
                      href={p.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs underline"
                    >
                      Open document
                    </a>
                  )}
                </div>
              </TableCell>
              <TableCell className="whitespace-normal">
                <dl className="grid grid-cols-[auto_auto] gap-x-3 text-xs sm:grid-cols-[auto_auto_auto_auto]">
                  {FINANCIAL_ITEM_KEYS.filter((k) => p.items[k] !== undefined).map((k) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{FINANCIAL_ITEM_LABELS[k]}</dt>
                      <dd className="text-right tabular-nums">
                        {formatNumber(p.items[k], { dp: isPerShareItem(k) ? 4 : 2 })}
                      </dd>
                    </div>
                  ))}
                </dl>
              </TableCell>
              {isOwner && (
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEdit(p)}
                    aria-label={`Edit ${p.periodEnd}`}
                  >
                    <Pencil aria-hidden="true" /> Edit
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
