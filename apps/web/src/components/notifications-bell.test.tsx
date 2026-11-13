import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotificationsPage from '@/app/(app)/notifications/page';
import type { Notification, NotificationPage, NotificationQuery } from '@/lib/api/types';
import { mockClient, renderWithClient } from '@/test/render';
import { NotificationsBell } from './notifications-bell';

const n = (id: string, read: boolean, title = `Notification ${id}`): Notification => ({
  id,
  type: 'PRICE_ABOVE',
  title,
  body: `Body ${id}`,
  createdAt: '2026-11-13T06:00:00.000Z',
  readAt: read ? '2026-11-13T07:00:00.000Z' : null,
  read,
  channel: 'IN_APP',
  status: read ? 'READ' : 'SENT',
  alertId: 'a1',
  link: '/alerts',
});

/** An in-memory inbox behind the client mock, so mutations are visible on refetch. */
function inbox(rows: Notification[]) {
  const state = rows.map((r) => ({ ...r }));
  const list = vi.fn(async (q: NotificationQuery = {}): Promise<NotificationPage> => {
    const data = state.filter((r) => !q.unread || !r.read).slice(0, q.limit ?? 50);
    return { data, nextCursor: null, unreadCount: state.filter((r) => !r.read).length };
  });
  const markRead = vi.fn(async (id: string) => {
    const r = state.find((x) => x.id === id)!;
    r.read = true;
    r.readAt = '2026-11-13T08:00:00.000Z';
    return { ...r };
  });
  const markAllRead = vi.fn(async () => {
    const updated = state.filter((r) => !r.read).length;
    state.forEach((r) => (r.read = true));
    return { updated };
  });
  return { list, markRead, markAllRead };
}

describe('NotificationsBell', () => {
  it('shows the unread count and marks one / all as read from the dropdown', async () => {
    const api = inbox([n('1', false, 'OGDC: price above'), n('2', false), n('3', true)]);
    renderWithClient(<NotificationsBell />, mockClient({ notifications: api }));
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    expect(screen.getByTestId('unread-count')).toHaveTextContent('2');
    expect(api.list).toHaveBeenCalledWith({ unread: true, limit: 1 });

    await userEvent.click(bell);
    const latest = await screen.findByRole('list', { name: 'Latest notifications' });
    expect(within(latest).getAllByTestId('notification')).toHaveLength(3);
    expect(screen.getByText(/notifications are in-app only/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mark “OGDC: price above” as read' }));
    expect(api.markRead).toHaveBeenCalledWith('1');
    await waitFor(() => expect(screen.getByTestId('unread-count')).toHaveTextContent('1'));

    await userEvent.click(screen.getByRole('button', { name: /Mark all read/ }));
    expect(api.markAllRead).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('unread-count')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('polls the unread count every 30 s against the API', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = inbox([n('1', false)]);
      renderWithClient(<NotificationsBell />, mockClient({ notifications: api }));
      await screen.findByRole('button', { name: 'Notifications, 1 unread' });
      const unreadCalls = () => api.list.mock.calls.filter(([q]) => q?.unread).length;
      expect(unreadCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await waitFor(() => expect(unreadCalls()).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows no badge when everything is read', async () => {
    renderWithClient(<NotificationsBell />, mockClient({ notifications: inbox([n('1', true)]) }));
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByTestId('unread-count')).not.toBeInTheDocument();
  });
});

describe('Notifications page', () => {
  it('lists the inbox, filters unread, marks read and shows the in-app-only note', async () => {
    const api = inbox([n('1', false, 'LUCK: price below'), n('2', true, 'Old one')]);
    renderWithClient(<NotificationsPage />, mockClient({ notifications: api }));
    const list = await screen.findByRole('list', { name: 'Notifications' });
    expect(within(list).getAllByTestId('notification')).toHaveLength(2);
    expect(screen.getByText('1 unread')).toBeInTheDocument();
    expect(screen.getByText(/Email and Telegram delivery are not configured yet/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Unread' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Notifications' })).getAllByTestId('notification'),
      ).toHaveLength(1),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Mark “LUCK: price below” as read' }));
    expect(api.markRead).toHaveBeenCalledWith('1');
    expect(await screen.findByText('No unread notifications')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark all read/ })).toBeDisabled();
  });
});
