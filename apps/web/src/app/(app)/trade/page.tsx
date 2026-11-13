'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { useActivePortfolio } from '@/lib/portfolio-context';
import { OrderTicket } from './order-ticket';

export default function TradePage() {
  const { portfolioId } = useActivePortfolio();
  // Remount the ticket when the active portfolio changes so it starts clean.
  const [nonce, setNonce] = useState(0);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Buy / Sell"
        description="Preview an order (fees + every risk check), approve it with step-up, then see the result. Live orders are placed by you in the KTrade app."
      />
      <OrderTicket key={`${portfolioId ?? 'none'}-${nonce}`} onReset={() => setNonce((n) => n + 1)} />
    </div>
  );
}
