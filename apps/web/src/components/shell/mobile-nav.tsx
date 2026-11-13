'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { isActive, MOBILE_NAV } from './nav-items';

function Items({ pathname }: { pathname: string | null }) {
  const { setOpenMobile } = useSidebar();
  return (
    <ul className="grid grid-cols-5">
      {MOBILE_NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-medium outline-none focus-visible:bg-muted',
                active ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <item.icon className="size-5" aria-hidden="true" />
              {item.label}
            </Link>
          </li>
        );
      })}
      <li>
        <button
          type="button"
          onClick={() => setOpenMobile(true)}
          className="flex w-full flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-medium text-muted-foreground outline-none focus-visible:bg-muted"
        >
          <Menu className="size-5" aria-hidden="true" />
          More
        </button>
      </li>
    </ul>
  );
}

function ActiveItems() {
  return <Items pathname={usePathname()} />;
}

/** Bottom navigation for phones (< md). */
export function MobileNav() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <Suspense fallback={<Items pathname={null} />}>
        <ActiveItems />
      </Suspense>
    </nav>
  );
}
