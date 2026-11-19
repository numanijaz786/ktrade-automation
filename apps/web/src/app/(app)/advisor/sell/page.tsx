'use client';

import { useState } from 'react';
import { HoldingList } from '@/components/advisor/holding-list';
import { HorizonSelect } from '@/components/advisor/horizon-select';
import { PageHeader } from '@/components/page-header';
import { EmptyState, QueryState } from '@/components/states';
import { useAdvisorHoldings } from '@/lib/api/hooks';
import type { AdvisorHorizon } from '@/lib/api/types-advisor';
import { useActivePortfolio } from '@/lib/portfolio-context';

export default function SellSignalsPage() {
  const { portfolioId } = useActivePortfolio();
  const [horizon, setHorizon] = useState<AdvisorHorizon>('SWING');
  const holdings = useAdvisorHoldings(portfolioId, horizon);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sell & Exit Signals"
        description="For each stock you own: keep, sell part, or exit. Profit and loss is shown after estimated selling fees."
        actions={<HorizonSelect value={horizon} onChange={setHorizon} />}
      />
      {!portfolioId ? (
        <EmptyState title="Pick a portfolio" />
      ) : (
        <QueryState query={holdings} rows={6}>
          {(r) => <HoldingList holdings={r.holdings} mode="sell" />}
        </QueryState>
      )}
    </div>
  );
}
