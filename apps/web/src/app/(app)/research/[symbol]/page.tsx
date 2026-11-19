'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { StockResearchView } from '@/components/advisor/stock-research';
import { LoadingBlock } from '@/components/states';

function Inner() {
  const { symbol: raw } = useParams<{ symbol: string }>();
  const symbol = decodeURIComponent(raw ?? '').toUpperCase();
  return <StockResearchView symbol={symbol} />;
}

export default function StockResearchPage() {
  // The symbol comes from useParams (runtime data): stream it in under Cache Components.
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <Inner />
    </Suspense>
  );
}
