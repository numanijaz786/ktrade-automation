'use client';

import { useState } from 'react';
import { Play } from 'lucide-react';
import { toast } from 'sonner';
import { DailyReportView } from '@/components/advisor/daily-report-view';
import { HorizonSelect } from '@/components/advisor/horizon-select';
import { PageHeader } from '@/components/page-header';
import { EmptyState, QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/errors';
import { useAdvisorDailyReport, useMe, useRunAdvisor } from '@/lib/api/hooks';
import type { AdvisorHorizon } from '@/lib/api/types-advisor';
import { useActivePortfolio } from '@/lib/portfolio-context';

export default function AdvisorPage() {
  const { portfolioId } = useActivePortfolio();
  const [horizon, setHorizon] = useState<AdvisorHorizon>('SWING');
  const me = useMe();
  const run = useRunAdvisor();
  const report = useAdvisorDailyReport(portfolioId, horizon);
  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Investment Advisor"
        description="A daily, rules-based review in plain English. It only uses stored, checked data, and it says so when there is not enough of it. Switch portfolio at the top of the page."
        actions={
          <>
            <HorizonSelect value={horizon} onChange={setHorizon} />
            {me.data?.role === 'OWNER' && portfolioId && (
              <Button
                size="sm"
                disabled={run.isPending}
                onClick={() =>
                  run.mutate(
                    { portfolioId },
                    {
                      onSuccess: (r) =>
                        toast.success(
                          `Advisor checked ${r.evaluated} stock views: ${r.actionable} actionable, ${r.notActionable} not.`,
                        ),
                      onError: (e) => toast.error(errorMessage(e)),
                    },
                  )
                }
              >
                <Play aria-hidden="true" /> {run.isPending ? 'Running…' : 'Run advisor now'}
              </Button>
            )}
          </>
        }
      />
      {!portfolioId ? (
        <EmptyState
          title="Pick a portfolio"
          description="The advisor needs a portfolio to size ideas against."
        />
      ) : (
        <QueryState query={report} rows={8}>
          {(r) => <DailyReportView report={r} />}
        </QueryState>
      )}
    </div>
  );
}
