'use client';

import { useState } from 'react';
import { ScannerResults } from '@/components/advisor/scanner-view';
import { HorizonSelect } from '@/components/advisor/horizon-select';
import { Disclaimer } from '@/components/advisor/advisor-bits';
import { NativeSelect } from '@/components/native-select';
import { PageHeader } from '@/components/page-header';
import { EmptyState, QueryState } from '@/components/states';
import { Label } from '@/components/ui/label';
import { FILTER_LABEL } from '@/lib/api/advisor-rules';
import { useAdvisorScanner } from '@/lib/api/hooks';
import { SCANNER_FILTERS, type AdvisorHorizon, type ScannerFilter } from '@/lib/api/types-advisor';
import { useActivePortfolio } from '@/lib/portfolio-context';

export default function ScannerPage() {
  const { portfolioId } = useActivePortfolio();
  const [filter, setFilter] = useState<ScannerFilter>('undervalued');
  const [horizon, setHorizon] = useState<AdvisorHorizon>('SWING');
  const scan = useAdvisorScanner(filter, horizon, portfolioId);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock Scanner"
        description="Find stocks that match one idea, using only verified data. Up to 20 results, best first."
        actions={
          <>
            <div className="flex items-center gap-2">
              <Label htmlFor="scanner-filter" className="whitespace-nowrap">
                Look for
              </Label>
              <NativeSelect
                id="scanner-filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value as ScannerFilter)}
                className="w-52"
              >
                {SCANNER_FILTERS.map((f) => (
                  <option key={f} value={f}>
                    {FILTER_LABEL[f]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <HorizonSelect value={horizon} onChange={setHorizon} />
          </>
        }
      />
      {!portfolioId ? (
        <EmptyState title="Pick a portfolio" />
      ) : (
        <QueryState query={scan} rows={6}>
          {(r) => <ScannerResults report={r} />}
        </QueryState>
      )}
      <Disclaimer />
    </div>
  );
}
