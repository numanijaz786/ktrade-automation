'use client';

import { useMemo } from 'react';
import { PageHeader, Section } from '@/components/page-header';
import { ErrorState, LoadingBlock, QueryState } from '@/components/states';
import { marketProviderRow, researchProviderRow } from '@/lib/api/http/mappers-research';
import { useProviders, useQuotes, useResearchProviders } from '@/lib/api/hooks';
import { FreshnessSummary, ProviderList, SimulatedBanner, summarizeQuotes } from './providers';

export default function DataHealthPage() {
  const market = useProviders();
  const research = useResearchProviders();
  const quotes = useQuotes();
  const freshness = useMemo(() => (quotes.data ? summarizeQuotes(quotes.data) : null), [quotes.data]);
  const activeSimulated = market.data?.find((p) => p.active)?.source === 'SIMULATED';
  const allSimulated = freshness ? (freshness.total > 0 ? freshness.allSimulated : activeSimulated) : false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data providers and system health"
        description="Where each kind of data comes from, how fresh it is, and exactly what is missing."
      />

      {allSimulated && <SimulatedBanner />}

      <Section title="Price data freshness" description="Taken from the prices stored right now.">
        {quotes.isPending ? (
          <LoadingBlock rows={2} />
        ) : quotes.isError || !freshness ? (
          <ErrorState error={quotes.error} onRetry={() => void quotes.refetch()} />
        ) : (
          <FreshnessSummary f={freshness} />
        )}
      </Section>

      <Section title="Price providers" description="Where market prices come from.">
        <QueryState query={market} rows={3}>
          {(list) => <ProviderList rows={list.map(marketProviderRow)} />}
        </QueryState>
      </Section>

      <Section
        title="Research data providers"
        description="Announcements, financial statements and macro data. Only owner-entered data is on until a licensed source is connected."
      >
        <QueryState query={research} rows={3}>
          {(list) => <ProviderList rows={list.map(researchProviderRow)} />}
        </QueryState>
      </Section>
    </div>
  );
}
