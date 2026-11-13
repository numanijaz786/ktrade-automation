'use client';

import Link from 'next/link';
import { FlaskConical, Hand, Power, PowerOff } from 'lucide-react';
import { useDataMode, useKillSwitch } from '@/lib/api/hooks';
import { cn } from '@/lib/utils';

/**
 * Always-visible status strip (docs/02 §7): data mode, manual live execution, kill switch.
 * Each item carries an icon + text so meaning never depends on colour.
 */
export function GlobalBanners() {
  const { data: mode } = useDataMode();
  const { data: ks } = useKillSwitch();
  const simulated = !mode || mode.priceSource === 'SIMULATED';
  return (
    <div role="region" aria-label="Trading status" className="border-b bg-muted/40 text-xs">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 lg:px-6">
        <li
          className={cn(
            'inline-flex items-center gap-1.5 font-medium',
            simulated ? 'text-fuchsia-800 dark:text-fuchsia-300' : 'text-foreground',
          )}
        >
          <FlaskConical className="size-3.5" aria-hidden="true" />
          <span>
            Prices: {mode ? mode.priceSource : 'SIMULATED'}
            {simulated && (
              <span className="font-normal text-muted-foreground"> — demo data, not real market prices</span>
            )}
            {mode && mode.delayMinutes > 0 && ` (${mode.delayMinutes} min delay)`}
          </span>
        </li>
        <li className="inline-flex items-center gap-1.5 text-amber-900 dark:text-amber-300">
          <Hand className="size-3.5" aria-hidden="true" />
          <span>
            <span className="font-medium">Live execution is manual</span>
            <span className="text-muted-foreground"> — place approved orders in the KTrade app</span>
          </span>
        </li>
        <li className="inline-flex items-center gap-1.5">
          {ks?.liveTradingEnabled === false ? (
            <Link
              href="/settings#kill-switch"
              className="inline-flex items-center gap-1.5 font-medium text-destructive underline-offset-2 hover:underline"
            >
              <PowerOff className="size-3.5" aria-hidden="true" />
              Kill switch ENGAGED — live approvals blocked
            </Link>
          ) : (
            <Link
              href="/settings#kill-switch"
              className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-2 hover:underline"
            >
              <Power className="size-3.5" aria-hidden="true" />
              Kill switch: off (live preparation allowed)
            </Link>
          )}
        </li>
      </ul>
    </div>
  );
}
