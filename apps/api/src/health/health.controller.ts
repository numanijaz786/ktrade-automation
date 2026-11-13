import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisHealth } from '../redis/redis.module.js';

/** Liveness and readiness. Public, and deliberately terse (no versions, hosts or error details). */
@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisHealth,
  ) {}

  @Get('health')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness: the process is up' })
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: database and Redis reachable' })
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: 'ready' | 'not_ready'; checks: Record<string, boolean> }> {
    const [database, redis] = await Promise.all([this.prisma.ping(), this.redis.ping()]);
    const ok = database && redis;
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ready' : 'not_ready', checks: { database, redis } };
  }
}
