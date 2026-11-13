'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { usePortfolios } from './api/hooks';
import type { Portfolio } from './api/types';

interface ActivePortfolio {
  portfolioId: string | undefined;
  portfolio: Portfolio | undefined;
  portfolios: Portfolio[];
  setPortfolioId: (id: string) => void;
}

const Ctx = createContext<ActivePortfolio | null>(null);

/** The portfolio the dashboard-style pages show (LIVE by default; PAPER selectable). */
export function PortfolioProvider({ children }: { children: ReactNode }) {
  const { data = [] } = usePortfolios();
  const [selected, setSelected] = useState<string | null>(null);
  const value = useMemo<ActivePortfolio>(() => {
    const fallback = data.find((p) => p.kind === 'LIVE') ?? data[0];
    const portfolio = data.find((p) => p.id === selected) ?? fallback;
    return { portfolioId: portfolio?.id, portfolio, portfolios: data, setPortfolioId: setSelected };
  }, [data, selected]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActivePortfolio(): ActivePortfolio {
  const v = useContext(Ctx);
  if (!v) throw new Error('useActivePortfolio must be used inside <PortfolioProvider>');
  return v;
}
