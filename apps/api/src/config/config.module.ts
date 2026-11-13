import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';
import { type Env, validateEnv } from './env.js';

/** Typed accessor so services never read process.env directly. */
export class AppConfig {
  constructor(private readonly config: ConfigService<Env, true>) {}
  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }
}

@Global()
@Module({
  imports: [NestConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv })],
  providers: [
    {
      provide: AppConfig,
      useFactory: (c: ConfigService<Env, true>) => new AppConfig(c),
      inject: [ConfigService],
    },
  ],
  exports: [AppConfig],
})
export class ConfigModule {}
