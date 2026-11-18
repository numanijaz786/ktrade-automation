'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import type { DividendPaymentStatus } from '@ktrade/shared';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { StatusPill, type StatusTone } from '@/components/status-badge';
import type { DividendTaxStatus } from '@/lib/api/types';
import { Dec } from '@/lib/decimal';
import { formatNumber, humanize } from '@/lib/format';

/** The calendar date in PKT (the API's trading-calendar day) of an instant. Call with a clock read outside render. */
export function pktDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}

/** DPS keeps its significant decimals (up to 6), never fewer than 2. */
export function formatDps(v: string): string {
  try {
    const canonical = Dec.of(v).toString();
    const dp = Math.max(2, canonical.split('.')[1]?.length ?? 0);
    return `Rs ${formatNumber(v, { dp })}`;
  } catch {
    return '—';
  }
}

const STATUS_TONE: Record<DividendPaymentStatus, StatusTone> = {
  ANNOUNCED: 'neutral',
  ENTITLED: 'info',
  PAID: 'good',
  RECONCILED: 'good',
  CANCELLED: 'neutral',
};

export function EntitlementStatus({ status }: { status: DividendPaymentStatus }) {
  return <StatusPill tone={STATUS_TONE[status]}>{humanize(status)}</StatusPill>;
}

const TAX_LABEL: Record<DividendTaxStatus, { label: string; tone: StatusTone }> = {
  CONFIGURED: { label: 'Verified rate', tone: 'info' },
  NOT_CONFIGURED: { label: 'Not configured', tone: 'warn' },
  RECOMPUTE_REQUIRED: { label: 'Recompute', tone: 'warn' },
  AS_PAID: { label: 'As paid', tone: 'good' },
};

export function TaxStatusPill({ status }: { status: DividendTaxStatus }) {
  const m = TAX_LABEL[status];
  return <StatusPill tone={m.tone}>{m.label}</StatusPill>;
}

export const TAX_SETUP_HELP =
  'Dividend withholding is estimated only from verified tax rates and your filer status. Confirm both (USER_ACTION_REQUIRED.md, item 4) and enter them in Settings, then recompute.';

/**
 * WHT / net placeholder when no verified rate applies. Never shows a number: the API stores 0 as a
 * placeholder and no rate is ever computed client-side.
 */
export function TaxNotConfigured({ note, status }: { note: string | null; status: DividendTaxStatus }) {
  const label = status === 'RECOMPUTE_REQUIRED' ? 'recompute required' : 'not configured';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="tax-not-configured"
          className="cursor-help text-xs text-amber-900 underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-300"
          aria-label={`${label}. ${note ?? ''} ${TAX_SETUP_HELP}`}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-left">
        {note && <p className="font-medium">{note}</p>}
        <p>{TAX_SETUP_HELP}</p>
        <p>
          <Link href="/settings" className="underline">
            Open Settings
          </Link>
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p className="text-xs text-destructive" role="alert" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
