'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CandlestickChart } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { useNotifications } from '@/lib/api/hooks';
import { isActive, NAV_GROUPS } from './nav-items';

function NavMenu({ pathname }: { pathname: string | null }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const { data: unread } = useNotifications(true);
  return (
    <>
      {NAV_GROUPS.map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => isMobile && setOpenMobile(false)}
                      >
                        <item.icon aria-hidden="true" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.href === '/notifications' && !!unread?.unreadCount && (
                      <SidebarMenuBadge aria-label={`${unread.unreadCount} unread`}>
                        {unread.unreadCount}
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

function ActiveNavMenu() {
  return <NavMenu pathname={usePathname()} />;
}

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon" aria-label="Main navigation">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="PSX Smart Trading">
              <Link href="/dashboard">
                <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <CandlestickChart className="size-4" aria-hidden="true" />
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">PSX Smart Trading</span>
                  <span className="truncate text-xs text-muted-foreground">KTrade · personal</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/* usePathname suspends on dynamic routes under Cache Components; keep the rest of the shell static. */}
        <Suspense fallback={<NavMenu pathname={null} />}>
          <ActiveNavMenu />
        </Suspense>
      </SidebarContent>
      <SidebarFooter className="px-3 pb-3 text-[0.6875rem] text-muted-foreground group-data-[collapsible=icon]:hidden">
        Live orders are prepared here and placed by you in the KTrade app.
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
