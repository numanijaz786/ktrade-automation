'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Next 16: error boundaries receive `retry` (re-fetch + re-render the segment).
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 text-center">
      <AlertTriangle className="size-8 text-destructive" aria-hidden="true" />
      <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
      <p className="text-sm text-muted-foreground">
        {error instanceof Error ? error.message : 'Unexpected error'}
      </p>
      <Button onClick={() => retry()}>Try again</Button>
    </div>
  );
}
