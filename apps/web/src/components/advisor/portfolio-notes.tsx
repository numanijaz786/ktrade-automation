'use client';

import { Section } from '@/components/page-header';
import type { DailyReport } from '@/lib/api/types-advisor';
import { formatPKR } from '@/lib/format';

const TITLE: Record<string, string> = {
  POSITION_CONCENTRATION: 'Too much in one stock',
  SECTOR_EXPOSURE: 'Sector mix',
  CASH_ALLOCATION: 'Cash',
  DRAWDOWN: 'Biggest fall so far (drawdown)',
  UNPRICED_HOLDINGS: 'Holdings without a price',
  SIMULATED_PRICES: 'Simulated prices',
};

/** Whole-portfolio notes straight from the API: concentration, cash and drawdown. */
export function PortfolioNotes({ report }: { report: DailyReport }) {
  return (
    <Section
      title="Portfolio notes"
      description={`${report.portfolio.name} · cash ${formatPKR(report.portfolio.cash)} · total value ${formatPKR(report.portfolio.equity)}`}
    >
      {report.portfolioNotes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes.</p>
      ) : (
        <ul className="space-y-2 text-sm" data-testid="portfolio-notes">
          {report.portfolioNotes.map((n, i) => (
            <li
              key={`${n.kind}-${i}`}
              className={`rounded-md border p-2 ${n.severity === 'WARN' ? 'border-amber-600/40 bg-amber-500/5' : ''}`}
            >
              <p className="text-xs font-medium text-muted-foreground">{TITLE[n.kind] ?? n.kind}</p>
              <p>{n.text}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
