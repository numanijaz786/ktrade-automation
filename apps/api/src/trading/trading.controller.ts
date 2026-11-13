import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { type AuthUser, CurrentUser, ReqMeta, type RequestMeta, RequireStepUp, Roles } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  approveOrderSchema,
  idempotencyKeySchema,
  killSwitchSchema,
  listOrdersSchema,
  markPlacedSchema,
  previewOrderSchema,
  type PreviewOrderInput,
  recordFillSchema,
  type RecordFillInput,
} from './trading.schemas.js';
import { TradingService } from './trading.service.js';

@ApiTags('orders')
@ApiBearerAuth()
@Controller()
export class TradingController {
  constructor(private readonly trading: TradingService) {}

  @Post('orders/preview')
  @Roles('OWNER')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Preview an order: fee estimate + all risk checks. Creates a PREVIEWED or REJECTED_BY_RISK order.' })
  preview(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(previewOrderSchema)) body: PreviewOrderInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.trading.preview(user.id, body, idempotencyKeySchema.parse(key), meta);
  }

  @Post('orders/:id/approve')
  @Roles('OWNER')
  @RequireStepUp()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '🔐 Approve a previewed order (bound to its preview hash; risk re-checked)' })
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(approveOrderSchema)) body: z.infer<typeof approveOrderSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.trading.approve(user.id, id, body.previewHash, meta);
  }

  @Post('orders/:id/mark-placed')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Live/manual: you placed this order in the KTrade app (not broker-confirmed)' })
  markPlaced(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(markPlacedSchema)) body: z.infer<typeof markPlacedSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.trading.markPlaced(user.id, id, body.brokerOrderRef, meta);
  }

  @Post('orders/:id/fills')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Live/manual: record a fill you saw in KTrade (USER_REPORTED until a contract note confirms)' })
  recordFill(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(recordFillSchema)) body: RecordFillInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.trading.recordFill(user.id, id, body, meta);
  }

  @Post('orders/:id/cancel')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @ReqMeta() meta: RequestMeta) {
    return this.trading.cancel(user.id, id, meta);
  }

  @Get('orders')
  list(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(listOrdersSchema)) q: z.infer<typeof listOrdersSchema>) {
    return this.trading.list(user.id, q);
  }

  @Get('orders/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.trading.present(id, user.id);
  }

  @Get('admin/kill-switch')
  killSwitch() {
    return this.trading.killSwitch();
  }

  @Put('admin/kill-switch')
  @Roles('OWNER')
  @RequireStepUp()
  @ApiOperation({ summary: '🔐 Global live-trading switch (default OFF)' })
  setKillSwitch(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(killSwitchSchema)) body: z.infer<typeof killSwitchSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.trading.setKillSwitch(user.id, body.liveTradingEnabled, body.reason, meta);
  }
}
