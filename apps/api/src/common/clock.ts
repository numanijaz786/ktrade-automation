import { Global, Module } from '@nestjs/common';

/** Injectable time source so time-dependent logic (lockouts, expiry, TOTP) is deterministic in tests. */
export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('CLOCK');

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock }],
  exports: [CLOCK],
})
export class ClockModule {}
