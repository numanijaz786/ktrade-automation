import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import {
  AllowViewerWrite,
  type AuthUser,
  CurrentUser,
  ReqMeta,
  type RequestMeta,
  Roles,
} from '../auth/decorators.js';
import { TokenService } from '../auth/token.service.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { BacktestsService } from './backtests.service.js';
import { templatesView } from './definition.js';
import {
  type CompareBacktestsInput,
  compareBacktestsSchema,
  type CreateStrategyInput,
  createStrategySchema,
  listBacktestsSchema,
  listSignalsSchema,
  type RunBacktestInput,
  runBacktestSchema,
  type UpdateStrategyInput,
  updateStrategySchema,
  type ValidateStrategyInput,
  validateStrategySchema,
} from './strategies.schemas.js';
import { StrategiesService } from './strategies.service.js';

@ApiTags('strategies')
@ApiBearerAuth()
@Controller('strategies')
export class StrategiesController {
  constructor(
    private readonly strategies: StrategiesService,
    private readonly tokens: TokenService,
  ) {}

  @Get('templates')
  @ApiOperation({
    summary: 'Built-in strategy templates with their parameter schema (JSON Schema for UI forms)',
  })
  templates() {
    return templatesView();
  }

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @AllowViewerWrite()
  @ApiOperation({
    summary:
      'Validate a definition (rule DSL → 422 with JSON paths) and dry-run it over the last N completed daily bars. Persists nothing.',
  })
  validate(@Body(new ZodValidationPipe(validateStrategySchema)) body: ValidateStrategyInput) {
    return this.strategies.validate(body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.strategies.list(user.id);
  }

  @Post()
  @Roles('OWNER')
  @ApiOperation({
    summary: 'Create a strategy from a template (type + parameters) or CUSTOM_RULES (rule DSL)',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createStrategySchema)) body: CreateStrategyInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.strategies.create(user.id, body, meta);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.strategies.get(user.id, id);
  }

  @Patch(':id')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Edit a strategy; changing its definition or sizing bumps `version`' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateStrategySchema)) body: UpdateStrategyInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.strategies.update(user.id, id, body, meta);
  }

  @Delete(':id')
  @Roles('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.strategies.remove(user.id, id, meta);
  }

  /**
   * 🔐 for LIVE strategies. Step-up is checked here (same TokenService verification as the global StepUpGuard /
   * @RequireStepUp) because the requirement depends on the strategy's mode: PAPER activations need none.
   */
  @Post(':id/activate')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'X-Step-Up-Token', required: false, description: 'Required when the strategy is LIVE' })
  @ApiOperation({ summary: 'Activate (LIVE strategies 🔐; autoExecute is refused for LIVE)' })
  async activate(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('x-step-up-token') stepUpToken: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ) {
    const mode = await this.strategies.modeOf(user.id, id);
    let stepUp = false;
    if (mode === 'LIVE') {
      stepUp = typeof stepUpToken === 'string' && (await this.tokens.verifyStepUp(stepUpToken, user.id));
      if (!stepUp)
        throw new ForbiddenException({
          message: 'Fresh second-factor verification required',
          code: 'STEP_UP_REQUIRED',
        });
    }
    return this.strategies.setActive(user.id, id, true, meta, stepUp);
  }

  @Post(':id/deactivate')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.strategies.setActive(user.id, id, false, meta, false);
  }

  @Post(':id/evaluate')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Evaluate at the latest completed bar: records a signal (idempotent per bar) and a run log. PAPER + autoExecute places a paper order; LIVE never approves anything.',
  })
  evaluate(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.strategies.evaluate(user.id, id, meta);
  }

  @Get(':id/signals')
  signals(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(listSignalsSchema)) q: z.infer<typeof listSignalsSchema>,
  ) {
    return this.strategies.signals(user.id, { ...q, strategyId: id });
  }

  @Get(':id/executions')
  @ApiOperation({ summary: 'Evaluation run log' })
  executions(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.strategies.executions(user.id, id);
  }
}

@ApiTags('strategies')
@ApiBearerAuth()
@Controller('signals')
export class SignalsController {
  constructor(private readonly strategies: StrategiesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listSignalsSchema)) q: z.infer<typeof listSignalsSchema>,
  ) {
    return this.strategies.signals(user.id, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One signal with its explanation trace' })
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.strategies.signalById(user.id, id);
  }
}

@ApiTags('backtests')
@ApiBearerAuth()
@Controller('backtests')
export class BacktestsController {
  constructor(private readonly backtests: BacktestsService) {}

  @Post()
  @Roles('OWNER')
  @ApiOperation({
    summary:
      'Run a D1 backtest synchronously (≤ 10 years, ≤ 5000 bars) with the real fee engine; persists results + trades',
  })
  run(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(runBacktestSchema)) body: RunBacktestInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.backtests.run(user.id, body, meta);
  }

  @Post('compare')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compare up to 5 strategies on the same symbol/range, plus the buy-and-hold benchmark',
  })
  compare(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(compareBacktestsSchema)) body: CompareBacktestsInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.backtests.compare(user.id, body, meta);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listBacktestsSchema)) q: z.infer<typeof listBacktestsSchema>,
  ) {
    return this.backtests.list(user.id, q);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.backtests.get(user.id, id);
  }

  @Get(':id/trades')
  trades(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.backtests.trades(user.id, id);
  }
}
