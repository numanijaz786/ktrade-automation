'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiClientProvider, type ApiClient } from '@/lib/api/client';
import { getDemoClient } from '@/lib/api/demo-client';
import { PortfolioProvider } from '@/lib/portfolio-context';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
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
 * App-wide client providers. The API client is the in-memory demo today; swapping in the
 * HTTP/BFF client is a one-line change here.
 */
export function Providers({ children, client }: { children: ReactNode; client?: ApiClient }) {
  const [api] = useState<ApiClient>(() => client ?? getDemoClient());
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={getQueryClient()}>
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
