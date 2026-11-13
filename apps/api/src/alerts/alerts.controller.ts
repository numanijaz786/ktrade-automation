import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser, ReqMeta, type RequestMeta, Roles } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { AlertEvaluatorService } from './alert-evaluator.service.js';
import {
  type CreateAlertInput,
  createAlertSchema,
  type UpdateAlertInput,
  updateAlertSchema,
} from './alerts.schemas.js';
import { AlertsService } from './alerts.service.js';

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('alerts')
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly evaluator: AlertEvaluatorService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Your alerts' })
  list(@CurrentUser() user: AuthUser) {
    return this.alerts.list(user.id);
  }

  @Post()
  @Roles('OWNER')
  @ApiOperation({
    summary:
      'Create an alert. Typed params: PRICE_ABOVE/BELOW {price}, PCT_CHANGE_ABOVE/BELOW {pct}, VOLUME_SPIKE {multiple} (× 20-day avg volume), PORTFOLIO_DAILY_LOSS {pct}, POSITION_STOP_LOSS {pct} below avg cost',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createAlertSchema)) body: CreateAlertInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.alerts.create(user.id, body, meta);
  }

  @Post('evaluate')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Evaluate your active alerts now (manual trigger); idempotent per cooldown window',
  })
  evaluate(@CurrentUser() user: AuthUser) {
    return this.evaluator.evaluate(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.alerts.get(user.id, id);
  }

  @Patch(':id')
  @Roles('OWNER')
  @ApiOperation({
    summary: 'Update params/channels/cooldown/triggerOnce/isActive (type and target are immutable)',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateAlertSchema)) body: UpdateAlertInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.alerts.update(user.id, id, body, meta);
  }

  @Delete(':id')
  @Roles('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.alerts.remove(user.id, id, meta);
  }
}
