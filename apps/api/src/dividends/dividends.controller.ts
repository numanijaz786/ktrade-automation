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
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser, ReqMeta, type RequestMeta, Roles } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  type CreateDividendInput,
  createDividendSchema,
  type ListDividendsQuery,
  listDividendsSchema,
  type MarkPaidInput,
  markPaidSchema,
  type ReconcileInput,
  reconcileSchema,
  type UpdateDividendInput,
  updateDividendSchema,
} from './dividends.schemas.js';
import { DividendsService } from './dividends.service.js';
import { EntitlementsService } from './entitlements.service.js';

@ApiTags('dividends')
@ApiBearerAuth()
@Controller()
export class DividendsController {
  constructor(
    private readonly dividends: DividendsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ───────────── declarations ─────────────

  @Get('dividends')
  @ApiOperation({ summary: 'Cash-dividend declarations (newest book closure first)' })
  list(@Query(new ZodValidationPipe(listDividendsSchema)) q: ListDividendsQuery) {
    return this.dividends.list(q);
  }

  @Get('dividends/:id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.dividends.get(id);
  }

  @Post('dividends')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Record a dividend declaration (USER_REPORTED)' })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createDividendSchema)) body: CreateDividendInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.dividends.create(user.id, body, meta);
  }

  @Patch('dividends/:id')
  @Roles('OWNER')
  @ApiOperation({
    summary: 'Edit a declaration while none of its entitlements is paid; clears its estimated entitlements',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateDividendSchema)) body: UpdateDividendInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.dividends.update(user.id, id, body, meta);
  }

  @Delete('dividends/:id')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Delete a declaration while none of its entitlements is paid' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.dividends.remove(user.id, id, meta);
  }

  // ───────────── entitlements ─────────────

  @Get('portfolios/:id/dividend-entitlements')
  entitlementsOf(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.entitlements.list(user.id, id);
  }

  @Post('portfolios/:id/dividend-entitlements/compute')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Compute estimated entitlements from settled ledger holdings before each book closure (idempotent; paid rows untouched)',
  })
  compute(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.entitlements.compute(user.id, id, meta);
  }

  @Post('dividend-entitlements/:id/mark-paid')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record the dividend payment received: creates one DIVIDEND cash movement' })
  markPaid(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(markPaidSchema)) body: MarkPaidInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.entitlements.markPaid(user.id, id, body, meta);
  }

  @Post('dividend-entitlements/:id/reconcile')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a paid dividend against a broker/CDC statement (manual)' })
  reconcile(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(reconcileSchema)) body: ReconcileInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.entitlements.reconcile(user.id, id, body, meta);
  }
}
