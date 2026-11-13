'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Bell, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useApiClient } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { useMediaQuery } from '@/hooks/use-now';
import { useLogout, useMe, useNotifications } from '@/lib/api/hooks';
import { useActivePortfolio } from '@/lib/portfolio-context';
import { AppSidebar } from './app-sidebar';
import { GlobalBanners } from './global-banners';
import { MobileNav } from './mobile-nav';
import { ThemeToggle } from './theme-toggle';

function PortfolioSwitcher() {
  const { portfolioId, portfolios, setPortfolioId } = useActivePortfolio();
  if (!portfolios.length) return null;
  return (
    <Select value={portfolioId} onValueChange={setPortfolioId}>
      <SelectTrigger size="sm" aria-label="Active portfolio" className="max-w-[12rem] sm:max-w-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {portfolios.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name} · {p.kind === 'PAPER' ? 'Paper' : 'Live'}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NotificationsButton() {
  const { data } = useNotifications(true);
  const n = data?.length ?? 0;
  return (
    <Button variant="ghost" size="icon" asChild>
      <Link
        href="/notifications"
        aria-label={n ? `Notifications, ${n} unread` : 'Notifications'}
        className="relative"
      >
        <Bell aria-hidden="true" />
        {n > 0 && (
          <span className="absolute top-1 right-1 size-2 rounded-full bg-destructive" aria-hidden="true" />
        )}
      </Link>
    </Button>
  );
}

/** API mode: who is signed in, and sign-out (clears the httpOnly session cookies via the BFF). */
function SessionButton() {
  const api = useApiClient();
  const me = useMe();
  const logout = useLogout();
  const router = useRouter();
  if (api.kind !== 'http' || !me.data) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={logout.isPending}
      onClick={() =>
        logout.mutate(undefined, {
          onSuccess: () => router.replace('/login'),
          onError: (e) => toast.error(errorMessage(e)),
        })
      }
      aria-label={`Sign out ${me.data.displayName}`}
    >
      <LogOut aria-hidden="true" />
      <span className="hidden sm:inline">Sign out</span>
    </Button>
  );
}

/**
 * Responsive shell: full sidebar ≥ xl, collapsible icon rail on tablets, bottom nav on phones
 * (the sidebar becomes a sheet behind “More”).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1279px)');
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !isTablet;
  return (
    <SidebarProvider open={open} onOpenChange={setUserOpen}>
      <a
        href="#main"
        className="sr-only z-50 rounded bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
          <div className="flex h-12 items-center gap-2 px-4 lg:px-6">
            <SidebarTrigger className="-ml-1 hidden md:inline-flex" aria-label="Toggle sidebar" />
            <Separator orientation="vertical" className="mr-1 hidden h-5 md:block" />
            <span className="truncate text-sm font-semibold md:hidden">PSX Smart Trading</span>
            <div className="ml-auto flex items-center gap-1">
              <PortfolioSwitcher />
              <NotificationsButton />
              <ThemeToggle />
              <SessionButton />
            </div>
          </div>
          <GlobalBanners />
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1400px] flex-1 px-4 pt-5 pb-24 outline-none md:pb-10 lg:px-6"
        >
          {children}
        </main>
      </SidebarInset>
      <MobileNav />
    </SidebarProvider>
  );
}
