'use client';

import { useState } from 'react';
import { CheckCheck } from 'lucide-react';
import { toast } from 'sonner';
import { InAppOnlyNote, NotificationItem } from '@/components/notifications-bell';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { errorMessage } from '@/lib/api/errors';
import { useNotificationFeed, useNotificationMutations } from '@/lib/api/hooks';

export default function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const feed = useNotificationFeed(unreadOnly);
  const m = useNotificationMutations();
  const rows = feed.data?.pages.flatMap((p) => p.data) ?? [];
  const unreadCount = feed.data?.pages[0]?.unreadCount ?? 0;
  const onError = (e: unknown) => toast.error(errorMessage(e));
  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description={
          unreadCount ? `${unreadCount} unread` : 'Alerts, order fills and rejections, strategy signals.'
        }
        actions={
          <>
            <div role="group" aria-label="Filter" className="flex gap-1">
              <Button
                size="sm"
                variant={unreadOnly ? 'ghost' : 'secondary'}
                aria-pressed={!unreadOnly}
                onClick={() => setUnreadOnly(false)}
              >
                All
              </Button>
              <Button
                size="sm"
                variant={unreadOnly ? 'secondary' : 'ghost'}
                aria-pressed={unreadOnly}
                onClick={() => setUnreadOnly(true)}
              >
                Unread
              </Button>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!unreadCount || m.markAllRead.isPending}
              onClick={() =>
                m.markAllRead.mutate(undefined, {
                  onSuccess: (r) => toast.success(`Marked ${r.updated} as read`),
                  onError,
                })
              }
            >
              <CheckCheck aria-hidden="true" /> Mark all read
            </Button>
          </>
        }
      />
      <InAppOnlyNote />
      {feed.isPending ? (
        <LoadingBlock rows={6} />
      ) : feed.isError ? (
        <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}
          description="Triggered alerts, filled or risk-rejected orders and strategy signals appear here."
        />
      ) : (
        <Card>
          <CardContent className="p-2">
            <ul className="space-y-1" aria-label="Notifications">
              {rows.map((n) => (
                <NotificationItem
                  key={n.id}
                  n={n}
                  busy={m.markRead.isPending}
                  onMarkRead={(id) => m.markRead.mutate(id, { onError })}
                />
              ))}
            </ul>
            {feed.hasNextPage && (
              <div className="p-2 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={feed.isFetchingNextPage}
                  onClick={() => void feed.fetchNextPage()}
                >
                  Load more
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
