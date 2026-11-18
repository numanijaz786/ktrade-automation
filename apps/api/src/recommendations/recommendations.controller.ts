import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type AuthUser, CurrentUser, ReqMeta, type RequestMeta, Roles } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { OutcomeEvaluator } from './outcome-evaluator.service.js';
import {
  type ListRecommendationsQuery,
  listRecommendationsSchema,
  type PerformanceQuery,
  performanceQuerySchema,
} from './recommendations.schemas.js';
import { RecommendationsStore } from './recommendations.store.js';

@ApiTags('recommendations')
@ApiBearerAuth()
@Controller('recommendations')
export class RecommendationsController {
  constructor(
    private readonly store: RecommendationsStore,
    private readonly evaluator: OutcomeEvaluator,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Stored recommendations (newest first) with their latest outcome' })
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listRecommendationsSchema)) q: ListRecommendationsQuery,
  ) {
    return this.store.list(user.id, q);
  }

  // Declared before ':id' so "performance" is never read as an id.
  @Get('performance')
  @ApiOperation({
    summary: 'Win rate, average return, target-hit rate, stop frequency, holding days; per horizon',
  })
  performance(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(performanceQuerySchema)) q: PerformanceQuery,
  ) {
    return this.store.performance(user.id, q);
  }

  @Post('evaluate-outcomes')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Append outcome rows for open actionable recommendations from stored D1 bars' })
  evaluate(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.evaluator.evaluateOpen(user.id, meta);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One recommendation with its full outcome history' })
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.store.get(user.id, id);
  }
}
