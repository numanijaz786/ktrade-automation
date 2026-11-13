import type { ReactNode } from 'react';
import type { OrderStatus } from '@ktrade/shared';
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  Hand,
  Hourglass,
  Send,
  ShieldAlert,
  XCircle,
  HelpCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { humanize } from '@/lib/format';

type Tone = 'neutral' | 'info' | 'warn' | 'good' | 'bad';

const TONES: Record<Tone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  info: 'border-sky-600/30 bg-sky-600/10 text-sky-800 dark:text-sky-300',
  warn: 'border-amber-600/40 bg-amber-500/10 text-amber-900 dark:text-amber-300',
  good: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300',
  bad: 'border-destructive/30 bg-destructive/10 text-destructive',
};

const ORDER: Record<OrderStatus, { tone: Tone; icon: LucideIcon; label?: string }> = {
  DRAFT: { tone: 'neutral', icon: CircleDashed },
  PREVIEWED: { tone: 'info', icon: Clock },
  REJECTED_BY_RISK: { tone: 'bad', icon: ShieldAlert, label: 'Rejected by risk' },
  APPROVED: { tone: 'info', icon: CheckCircle2 },
  EXPIRED: { tone: 'neutral', icon: Hourglass },
  AWAITING_MANUAL_PLACEMENT: { tone: 'warn', icon: Hand, label: 'Place in KTrade' },
  PLACED_BY_USER: { tone: 'info', icon: Send, label: 'Placed (no fill yet)' },
  SUBMITTED: { tone: 'info', icon: Send },
  ACCEPTED: { tone: 'info', icon: Send },
  PARTIALLY_FILLED: { tone: 'warn', icon: CircleDashed, label: 'Partially filled' },
  FILLED: { tone: 'good', icon: CheckCircle2 },
  CANCEL_REQUESTED: { tone: 'warn', icon: Ban, label: 'Cancel requested' },
  CANCELLED: { tone: 'neutral', icon: Ban },
  REJECTED_BY_BROKER: { tone: 'bad', icon: XCircle, label: 'Rejected by broker' },
  UNKNOWN: { tone: 'bad', icon: HelpCircle },
};

export function StatusPill({
  tone,
  icon: Icon,
  children,
  className,
}: {
  tone: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {Icon && <Icon className="size-3.5" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function OrderStatusBadge({ status, className }: { status: OrderStatus; className?: string }) {
  const m = ORDER[status];
  return (
    <StatusPill tone={m.tone} icon={m.icon} className={className}>
      {m.label ?? humanize(status)}
    </StatusPill>
  );
}

export function GenericStatus({
  value,
  tone = 'neutral',
  className,
}: {
  value: string;
  tone?: Tone;
  className?: string;
}) {
  return (
    <StatusPill tone={tone} className={className}>
      {humanize(value)}
    </StatusPill>
  );
}

export type { Tone as StatusTone };
