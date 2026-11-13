import { Injectable } from '@nestjs/common';
import type { NotificationChannel } from '@ktrade/shared';

/** What a channel decided for one notification. Persisted on the `notifications` row. */
export interface DeliveryResult {
  status: 'SENT' | 'FAILED';
  sentAt: Date | null;
  attempts: number;
  error: string | null;
}

export interface OutgoingNotification {
  userId: string;
  title: string;
  body: string;
}

/**
 * Channel abstraction. `deliver` must not perform external I/O inside a DB transaction; real external
 * channels (SMTP, Telegram) would instead leave the row PENDING for an out-of-transaction dispatcher.
 * None is configured yet, so the external adapters refuse deterministically.
 */
export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
  deliver(msg: OutgoingNotification, now: Date): DeliveryResult;
}

export const CHANNEL_NOT_CONFIGURED = 'channel not configured';

/** In-app inbox: the row itself is the delivery. */
@Injectable()
export class InAppChannel implements NotificationChannelAdapter {
  readonly channel = 'IN_APP' as const;
  readonly enabled = true;
  deliver(_msg: OutgoingNotification, now: Date): DeliveryResult {
    return { status: 'SENT', sentAt: now, attempts: 1, error: null };
  }
}

/**
 * Email: DISABLED. Sending needs owner-side SMTP/OAuth setup (USER_ACTION_REQUIRED #6). Never sends anything;
 * every attempt is recorded as FAILED with the reason, so the owner can see what would have been sent.
 */
@Injectable()
export class EmailChannel implements NotificationChannelAdapter {
  readonly channel = 'EMAIL' as const;
  readonly enabled = false;
  deliver(): DeliveryResult {
    return { status: 'FAILED', sentAt: null, attempts: 0, error: CHANNEL_NOT_CONFIGURED };
  }
}

/** Telegram: DISABLED until a bot token is configured by the owner. Never sends anything. */
@Injectable()
export class TelegramChannel implements NotificationChannelAdapter {
  readonly channel = 'TELEGRAM' as const;
  readonly enabled = false;
  deliver(): DeliveryResult {
    return { status: 'FAILED', sentAt: null, attempts: 0, error: CHANNEL_NOT_CONFIGURED };
  }
}
