'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Bell, Check, CheckCheck, Info } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { errorMessage } from '@/lib/api/errors';
import { useNotificationMutations, useNotifications } from '@/lib/api/hooks';
import type { Notification } from '@/lib/api/types';
import { formatDateTime, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';

const LATEST = 8;

/** EMAIL and TELEGRAM adapters are disabled server-side (ADR-027): nothing is ever sent externally. */
export function InAppOnlyNote({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-start gap-1.5 text-xs text-muted-foreground', className)}>
      <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      Email and Telegram delivery are not configured yet — notifications are in-app only.
    </p>
  );
}

/** One inbox row: unread dot + title + body + time, with a per-row "mark read". */
export function NotificationItem({
  n,
  onMarkRead,
  busy,
  compact = false,
}: {
  n: Notification;
  onMarkRead: (id: string) => void;
  busy?: boolean;
  compact?: boolean;
}) {
  return (
    <li
      className={cn('flex items-start gap-2.5 rounded-md p-2', !n.read && 'bg-muted/60')}
      data-testid="notification"
      data-read={n.read}
    >
      <span
        className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-primary')}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className={cn('text-sm', !n.read && 'font-medium')}>
          {!n.read && <span className="sr-only">Unread: </span>}
          {n.link ? (
            <Link href={n.link} className="underline-offset-2 hover:underline">
              {n.title}
            </Link>
          ) : (
            n.title
          )}
        </p>
        <p className={cn('text-xs text-muted-foreground', compact && 'line-clamp-2')}>{n.body}</p>
        <p className="text-[0.6875rem] text-muted-foreground">
          {formatDateTime(n.createdAt)}
          {n.type && ` · ${humanize(n.type)}`}
        </p>
      </div>
      {!n.read && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          disabled={busy}
          aria-label={`Mark “${n.title}” as read`}
          onClick={() => onMarkRead(n.id)}
        >
          <Check aria-hidden="true" />
        </Button>
      )}
    </li>
  );
}

/** Header bell: unread count (polled every 30 s in api mode) and a dropdown of the latest notifications. */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const unread = useNotifications(true, 1);
  const latest = useNotifications(false, LATEST);
  const m = useNotificationMutations();
  const count = unread.data?.unreadCount ?? latest.data?.unreadCount ?? 0;
  const rows = latest.data?.data ?? [];
  const onError = (e: unknown) => toast.error(errorMessage(e));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}
        >
          <Bell aria-hidden="true" />
          {count > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[0.625rem] leading-none font-semibold text-white tabular"
              data-testid="unread-count"
              aria-hidden="true"
            >
              {count > 99 ? '99+' : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <p className="text-sm font-semibold">
            Notifications
            {count > 0 && <span className="font-normal text-muted-foreground"> · {count} unread</span>}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={count === 0 || m.markAllRead.isPending}
            onClick={() => m.markAllRead.mutate(undefined, { onError })}
          >
            <CheckCheck aria-hidden="true" /> Mark all read
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto p-1.5">
          {latest.isPending ? (
            <p className="p-3 text-sm text-muted-foreground">Loading…</p>
          ) : latest.isError ? (
            <p className="p-3 text-sm text-destructive">{errorMessage(latest.error)}</p>
          ) : rows.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">You’re all caught up.</p>
          ) : (
            <ul className="space-y-0.5" aria-label="Latest notifications">
              {rows.map((n) => (
                <NotificationItem
                  key={n.id}
                  n={n}
                  compact
                  busy={m.markRead.isPending}
                  onMarkRead={(id) => m.markRead.mutate(id, { onError })}
                />
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-2 border-t px-3 py-2">
          <InAppOnlyNote />
          <Button variant="outline" size="sm" className="w-full" asChild>
            <Link href="/notifications" onClick={() => setOpen(false)}>
              View all notifications
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
