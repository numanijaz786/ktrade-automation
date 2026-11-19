'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LoadingBlock } from '@/components/states';
import { PageHeader } from '@/components/page-header';
import { useActivePortfolio } from '@/lib/portfolio-context';
import { OrderTicket, parsePrefill } from './order-ticket';

function Ticket() {
  const { portfolioId } = useActivePortfolio();
  const params = useSearchParams();
  const prefill = parsePrefill(params);
  // Remount the ticket when the active portfolio changes so it starts clean.
  const [nonce, setNonce] = useState(0);
  const fromAdvisor = prefill.symbol !== undefined;
  return (
    <>
      {fromAdvisor && (
        <p
          className="rounded-md border border-sky-600/30 bg-sky-600/5 p-3 text-sm"
          data-testid="prefill-note"
        >
          Filled in from the advisor’s plan. Nothing has been sent: check every field, then preview, approve
          and place the order yourself.
        </p>
      )}
      <OrderTicket
        key={`${portfolioId ?? 'none'}-${nonce}`}
        prefill={prefill}
        onReset={() => setNonce((n) => n + 1)}
      />
    </>
  );
}

export default function TradePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Buy / Sell"
        description="Preview an order (fees + every risk check), approve it with step-up, then see the result. Live orders are placed by you in the KTrade app."
      />
      <Suspense fallback={<LoadingBlock rows={6} />}>
        <Ticket />
      </Suspense>
    </div>
  );
}
