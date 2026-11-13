import { Global, Module } from '@nestjs/common';
import { EmailChannel, InAppChannel, TelegramChannel } from './channels.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Global so the order pipeline and the strategy engine can emit notifications without module rewiring.
 * Depends only on Prisma + Clock (no cycles).
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [InAppChannel, EmailChannel, TelegramChannel, NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
