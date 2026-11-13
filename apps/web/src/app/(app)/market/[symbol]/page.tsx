import { Suspense } from 'react';
import { LoadingBlock } from '@/components/states';
import { StockDetailView } from './stock-detail';

export default function StockDetailPage() {
  // The symbol comes from useParams (runtime data) — stream it in under Cache Components.
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <StockDetailView />
    </Suspense>
  );
}
