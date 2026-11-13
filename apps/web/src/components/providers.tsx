'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiClientProvider, type ApiClient } from '@/lib/api/client';
import { getDemoClient } from '@/lib/api/demo-client';
import { ApiError } from '@/lib/api/errors';
import { qk } from '@/lib/api/hooks';
import { HttpApiClient } from '@/lib/api/http-client';
import { DATA_MODE } from '@/lib/api/mode';
import { PortfolioProvider } from '@/lib/portfolio-context';

/** Client errors (4xx) and NOT_AVAILABLE (501) are final; only transient failures are retried once. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.status < 500 || error.code === 'NOT_AVAILABLE')) return false;
  return failureCount < 1;
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: shouldRetry },
      mutations: { retry: false },
    },
  });
}

let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
  // Isolate server renders; reuse one client in the browser.
  if (typeof window === 'undefined') return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

/**
 * App-wide client providers. `NEXT_PUBLIC_DATA_MODE=api` selects the BFF-backed HttpApiClient;
 * anything else the in-memory demo client.
 */
export function Providers({ children, client }: { children: ReactNode; client?: ApiClient }) {
  const [queryClient] = useState(getQueryClient);
  const [api] = useState<ApiClient>(
    () =>
      client ??
      (DATA_MODE === 'api'
        ? // A lost session flips `me` to null; <AuthGate> then redirects to /login.
          new HttpApiClient({ onUnauthenticated: () => queryClient.setQueryData(qk.me, null) })
        : getDemoClient()),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={api}>
          <PortfolioProvider>
            <TooltipProvider delayDuration={150}>
              {children}
              <Toaster richColors closeButton position="top-right" />
            </TooltipProvider>
          </PortfolioProvider>
        </ApiClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
