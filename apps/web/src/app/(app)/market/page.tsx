import { Suspense } from 'react';
import { LoadingBlock } from '@/components/states';
import { StockExplorer } from './stock-explorer';

export default function MarketPage() {
  // useSearchParams (initial ?q= / ?sector=) needs a Suspense boundary under Cache Components.
  return (
    <Suspense fallback={<LoadingBlock rows={10} />}>
      <StockExplorer />
    </Suspense>
  );
}
