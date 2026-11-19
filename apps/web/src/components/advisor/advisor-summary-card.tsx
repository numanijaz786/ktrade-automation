'use client';

import Link from 'next/link';
import { ArrowRight, Brain } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdvisorDailyReport } from '@/lib/api/hooks';

/** Dashboard card: today's advisor headline and a link. Shows no price level of any kind. */
export function AdvisorSummaryCard({ portfolioId }: { portfolioId: string }) {
  const q = useAdvisorDailyReport(portfolioId, 'SWING');
  const r = q.data;
  return (
    <Card data-testid="advisor-card">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
        <div className="flex min-w-0 items-start gap-3">
          <Brain className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">AI Investment Advisor</p>
            {q.isPending ? (
              <Skeleton className="mt-1 h-5 w-64" />
            ) : r ? (
              <>
                <p className="font-semibold" data-testid="advisor-card-headline">
                  {r.headline}
                </p>
                {r.notEnoughData ? (
                  <p className="text-sm text-muted-foreground">{r.notEnoughData.summary}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {r.topBuys.length} buy idea{r.topBuys.length === 1 ? '' : 's'} · {r.avoidOrSell.length} to
                    avoid or sell
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Today’s advisor review is unavailable right now. Open the advisor to try again.
              </p>
            )}
          </div>
        </div>
        <Link
          href="/advisor"
          className="inline-flex items-center gap-1 text-sm font-medium underline-offset-2 hover:underline"
        >
          Open the advisor <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </CardContent>
    </Card>
  );
}
