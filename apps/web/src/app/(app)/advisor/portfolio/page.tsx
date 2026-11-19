'use client';

import { useState } from 'react';
import { HoldingList } from '@/components/advisor/holding-list';
import { HorizonSelect } from '@/components/advisor/horizon-select';
import { PortfolioNotes } from '@/components/advisor/portfolio-notes';
import { PageHeader } from '@/components/page-header';
import { EmptyState, QueryState } from '@/components/states';
import { useAdvisorDailyReport, useAdvisorHoldings } from '@/lib/api/hooks';
import type { AdvisorHorizon } from '@/lib/api/types-advisor';
import { useActivePortfolio } from '@/lib/portfolio-context';

export default function PortfolioManagerPage() {
  const { portfolioId } = useActivePortfolio();
  const [horizon, setHorizon] = useState<AdvisorHorizon>('SWING');
  const holdings = useAdvisorHoldings(portfolioId, horizon);
  const report = useAdvisorDailyReport(portfolioId, horizon);
  return (
    <div className="space-y-6">
      <PageHeader
        title="My Portfolio Manager"
        description="How each holding is doing, what the advisor suggests, and what to watch across the whole portfolio."
        actions={<HorizonSelect value={horizon} onChange={setHorizon} />}
      />
      {!portfolioId ? (
        <EmptyState title="Pick a portfolio" />
      ) : (
        <>
          <QueryState query={report} rows={3}>
            {(r) => <PortfolioNotes report={r} />}
          </QueryState>
          <QueryState query={holdings} rows={6}>
            {(r) => <HoldingList holdings={r.holdings} mode="portfolio" />}
          </QueryState>
        </>
      )}
    </div>
  );
}
