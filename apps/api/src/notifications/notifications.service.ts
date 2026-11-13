import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AlertType, NotificationChannel } from '@ktrade/shared';
import { CLOCK, type Clock } from '../common/clock.js';
import type { Notification, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailChannel, InAppChannel, type NotificationChannelAdapter, TelegramChannel } from './channels.js';

type Db = Prisma.TransactionClient;

export interface NotifyInput {
  userId: string;
  /** What happened (stored as `data.type`). */
  type: AlertType;
  title: string;
  body: string;
  /** Idempotency key, unique per (user, channel). A retry with the same key creates nothing. */
  dedupeKey: string;
  data?: Record<string, unknown>;
  alertId?: string | null;
  /** Default ['IN_APP']. */
  channels?: readonly NotificationChannel[];
}

export interface ListNotificationsQuery {
  unread?: boolean;
  limit: number;
  cursor?: string;
}

/**
 * Notification fan-out + in-app inbox (docs/07). One row per (notification, channel); dedupe via the unique
 * (userId, channel, dedupeKey) index with `skipDuplicates`, so retried evaluations and re-run order transitions
 * never create duplicates and never abort the caller's transaction.
 * Only IN_APP delivers; EMAIL/TELEGRAM are recorded as FAILED "channel not configured" — nothing leaves the box.
 */
@Injectable()
export class NotificationsService {
  private readonly adapters: ReadonlyMap<NotificationChannel, NotificationChannelAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    inApp: InAppChannel,
    email: EmailChannel,
    telegram: TelegramChannel,
  ) {
    this.adapters = new Map<NotificationChannel, NotificationChannelAdapter>([
      [inApp.channel, inApp],
      [email.channel, email],
      [telegram.channel, telegram],
    ]);
  }

  /** Create the notification on each channel. Pass `db` to write inside the caller's transaction. */
  async notify(input: NotifyInput, db?: Db): Promise<{ created: number }> {
    const now = this.clock.now();
    const channels = [...new Set(input.channels?.length ? input.channels : (['IN_APP'] as const))];
    const rows = channels.map((channel) => {
      const adapter = this.adapters.get(channel);
      const result = adapter
        ? adapter.deliver({ userId: input.userId, title: input.title, body: input.body }, now)
        : { status: 'FAILED' as const, sentAt: null, attempts: 0, error: 'unknown channel' };
      return {
        userId: input.userId,
        alertId: input.alertId ?? null,
        channel,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 2000),
        data: { ...(input.data ?? {}), type: input.type } as Prisma.InputJsonValue,
        dedupeKey: input.dedupeKey,
        status: result.status,
        attempts: result.attempts,
        error: result.error,
        sentAt: result.sentAt,
        createdAt: now,
      };
    });
    const { count } = await (db ?? this.prisma).notification.createMany({ data: rows, skipDuplicates: true });
    return { created: count };
  }

  /** The in-app inbox, newest first. */
  async list(userId: string, q: ListNotificationsQuery) {
    const where: Prisma.NotificationWhereInput = {
      userId,
      channel: 'IN_APP',
      ...(q.unread ? { readAt: null } : {}),
    };
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      }),
      this.prisma.notification.count({ where: { userId, channel: 'IN_APP', readAt: null } }),
    ]);
    const page = rows.slice(0, q.limit);
    return {
      data: page.map(view),
      nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
      unreadCount,
    };
  }

  async markRead(userId: string, id: string) {
    const n = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!n) throw new NotFoundException({ message: 'Notification not found', code: 'NOT_FOUND' });
    if (n.readAt) return view(n);
    const updated = await this.prisma.notification.update({
      where: { id },
      data: { readAt: this.clock.now(), status: 'READ' },
    });
    return view(updated);
  }

  async markAllRead(userId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, channel: 'IN_APP', readAt: null },
      data: { readAt: this.clock.now(), status: 'READ' },
    });
    return { updated: count };
  }
}

function view(n: Notification) {
  const data = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    type: typeof data.type === 'string' ? data.type : null,
    title: n.title,
    body: n.body,
    data,
    channel: n.channel,
    status: n.status,
    alertId: n.alertId,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt?.toISOString() ?? null,
  };
}
