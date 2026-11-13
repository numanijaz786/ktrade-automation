import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { type AuthUser, CurrentUser, ReqMeta, type RequestMeta, Roles } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { isIsoDate } from '../market-data/calendar.js';
import { PerformanceService } from './performance.service.js';
import { PERFORMANCE_RANGES } from './snapshot-math.js';
import { SnapshotService } from './snapshot.service.js';

const isoDate = z.string().refine(isIsoDate, 'must be a YYYY-MM-DD date');
const backfillSchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .strict()
  .refine((b) => !b.from || !b.to || b.from <= b.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  });
const performanceSchema = z.object({ range: z.enum(PERFORMANCE_RANGES).default('ALL') });

@ApiTags('portfolio')
@ApiBearerAuth()
@Controller('portfolios/:id')
export class SnapshotsController {
  constructor(
    private readonly snapshots: SnapshotService,
    private readonly performance: PerformanceService,
    private readonly audit: AuditService,
  ) {}

  @Post('snapshots/backfill')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Rebuild daily close snapshots for every PSX trading day in [from, to] (default: first activity → last completed session). Idempotent.',
  })
  async backfill(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(backfillSchema)) body: z.infer<typeof backfillSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.performance.owned(user.id, id);
    const result = await this.snapshots.backfill(id, body.from, body.to);
    await this.audit.record({
      action: 'portfolio.snapshots_backfilled',
      actorType: 'USER',
      actorUserId: user.id,
      entityType: 'portfolio',
      entityId: id,
      metadata: { from: result.from, to: result.to, tradingDays: result.tradingDays },
      ...meta,
    });
    return result;
  }

  @Get('performance')
  @ApiOperation({
    summary:
      'Performance over `range` (1M|3M|6M|YTD|1Y|ALL): value/daily P&L/TWR-index series, TWR, max drawdown, monthly P&L, simple return and XIRR, with provenance',
  })
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(performanceSchema)) q: z.infer<typeof performanceSchema>,
  ) {
    return this.performance.performance(user.id, id, q.range);
  }
}
