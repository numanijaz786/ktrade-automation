import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiClientProvider, type ApiClient } from '@/lib/api/client';
import { PortfolioProvider } from '@/lib/portfolio-context';

/** A client with only the groups a test needs; anything else throws if touched. */
export function mockClient(groups: Partial<{ [K in keyof ApiClient]: Partial<ApiClient[K]> }>): ApiClient {
  return { kind: 'http', ...groups } as unknown as ApiClient;
}

export function renderWithClient(ui: ReactElement, client: ApiClient, opts: { portfolios?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const inner = <TooltipProvider>{ui}</TooltipProvider>;
  return render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        {opts.portfolios ? <PortfolioProvider>{inner}</PortfolioProvider> : inner}
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}
