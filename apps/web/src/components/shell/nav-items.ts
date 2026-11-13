import {
  Activity,
  ArrowLeftRight,
  Banknote,
  Bell,
  BotMessageSquare,
  BriefcaseBusiness,
  CandlestickChart,
  ChartNoAxesCombined,
  Cable,
  FileBarChart,
  FlaskConical,
  LayoutDashboard,
  ListChecks,
  Lock,
  ReceiptText,
  Settings,
  ShoppingCart,
  Sparkles,
  Star,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/portfolio', label: 'Portfolio', icon: BriefcaseBusiness },
      { href: '/holdings', label: 'Holdings', icon: Wallet },
      { href: '/transactions', label: 'Transactions', icon: ReceiptText },
      { href: '/dividends', label: 'Dividends', icon: Banknote },
    ],
  },
  {
    label: 'Trading',
    items: [
      { href: '/trade', label: 'Buy / Sell', icon: ShoppingCart },
      { href: '/orders', label: 'Orders', icon: ListChecks },
      { href: '/paper', label: 'Paper trading', icon: ArrowLeftRight },
      { href: '/market/overview', label: 'Market overview', icon: Activity },
      { href: '/market', label: 'Stock explorer', icon: CandlestickChart },
      { href: '/watchlists', label: 'Watchlists', icon: Star },
    ],
  },
  {
    label: 'Automation',
    items: [
      { href: '/strategies', label: 'Strategies', icon: Sparkles },
      { href: '/backtests', label: 'Backtesting', icon: FlaskConical },
      { href: '/assistant', label: 'AI assistant', icon: BotMessageSquare },
      { href: '/analytics', label: 'Analytics & reports', icon: FileBarChart },
    ],
  },
  {
    label: 'Account',
    items: [
      { href: '/notifications', label: 'Notifications', icon: Bell },
      { href: '/integration', label: 'KTrade integration', icon: Cable },
      { href: '/security', label: 'Security', icon: Lock },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

/** Bottom navigation on phones (the rest live behind “More”). */
export const MOBILE_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/holdings', label: 'Holdings', icon: Wallet },
  { href: '/trade', label: 'Trade', icon: ShoppingCart },
  { href: '/market/overview', label: 'Market', icon: ChartNoAxesCombined },
];

/** Exact match for `/market` so it is not highlighted together with `/market/overview`. */
const EXACT = new Set(['/market']);

export function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (EXACT.has(href))
    return pathname === href || (pathname.startsWith(`${href}/`) && pathname !== '/market/overview');
  return pathname === href || pathname.startsWith(`${href}/`);
}
