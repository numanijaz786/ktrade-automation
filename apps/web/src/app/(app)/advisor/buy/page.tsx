'use client';

import { useState } from 'react';
import { DataQualityBanner, Disclaimer, NotEnoughDataPanel } from '@/components/advisor/advisor-bits';
import { BuyList } from '@/components/advisor/daily-report-view';
import { HorizonSelect } from '@/components/advisor/horizon-select';
import { PageHeader } from '@/components/page-header';
import { EmptyState, QueryState } from '@/components/states';
import { useAdvisorDailyReport } from '@/lib/api/hooks';
import type { AdvisorHorizon } from '@/lib/api/types-advisor';
import { useActivePortfolio } from '@/lib/portfolio-context';

export default function BuyOpportunitiesPage() {
  const { portfolioId } = useActivePortfolio();
  const [horizon, setHorizon] = useState<AdvisorHorizon>('SWING');
  const report = useAdvisorDailyReport(portfolioId, horizon);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Today’s Buy Opportunities"
        description="Ideas with a full plan: where to buy, where to stop, targets and size. Advisory only."
        actions={<HorizonSelect value={horizon} onChange={setHorizon} />}
      />
      {!portfolioId ? (
        <EmptyState title="Pick a portfolio" />
      ) : (
        <QueryState query={report} rows={6}>
          {(r) => (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold" data-testid="advisor-headline">
                {r.headline}
              </h2>
              <DataQualityBanner q={r.dataQuality} />
              {r.notEnoughData && <NotEnoughDataPanel n={r.notEnoughData} />}
              <BuyList report={r} />
              <Disclaimer text={r.disclaimer} />
            </div>
          )}
        </QueryState>
      )}
    </div>
  );
}
