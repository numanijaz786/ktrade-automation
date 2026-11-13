import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../config/config.module.js';

export const REDIS = Symbol('REDIS');

@Injectable()
export class RedisHealth implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Redis');

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * lazyConnect never opens a socket by itself, and with the offline queue disabled every command
   * fails until connected — so connect explicitly. Non-blocking: if Redis is down the app still starts
   * (reporting not-ready) and ioredis keeps retrying in the background.
   */
  onModuleInit(): void {
    this.redis.on('error', (err: Error) => this.logger.warn(`Redis connection error: ${err.message}`));
    this.redis.connect().catch(() => undefined);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfig],
      // lazyConnect + bounded retries: the API starts (and reports not-ready) when Redis is down.
      useFactory: (config: AppConfig) =>
        new Redis(config.get('REDIS_URL'), {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        }),
    },
    RedisHealth,
  ],
  exports: [REDIS, RedisHealth],
})
export class RedisModule {}
