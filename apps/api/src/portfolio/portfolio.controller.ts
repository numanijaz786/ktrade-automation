import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { d } from '@ktrade/finance-core';
import { DECIMAL_STRING_RE, positiveDecimalString } from '@ktrade/shared';
import {
  type AuthUser,
  CurrentUser,
  ReqMeta,
  type RequestMeta,
  RequireStepUp,
  Roles,
} from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { PortfolioService } from './portfolio.service.js';

const createPaperSchema = z.object({
  name: z.string().trim().min(1).max(80),
  initialCash: positiveDecimalString,
});
const cashSchema = z.object({
  type: z.enum(['DEPOSIT', 'WITHDRAWAL']),
  amount: positiveDecimalString,
  valueDate: z.string().date(),
  description: z.string().trim().max(200).optional(),
});
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});
// Guarded: Zod 4 runs refinements even after the regex check failed (d('abc') would throw → 500).
const pctString = positiveDecimalString.refine(
  (v) => !DECIMAL_STRING_RE.test(v) || d(v).lte(100),
  'must be ≤ 100',
);
const riskLimitsSchema = z.object({
  maxOrderValue: positiveDecimalString,
  maxOrderQty: positiveDecimalString,
  maxDailyTradedValue: positiveDecimalString,
  maxDailyOrders: z.number().int().min(1).max(1000),
  maxPositionPct: pctString,
  priceBandPct: pctString,
  maxDailyLossPct: pctString,
  allowMarketOrders: z.boolean(),
});

@ApiTags('portfolio')
@ApiBearerAuth()
@Controller()
export class PortfolioController {
  constructor(private readonly portfolios: PortfolioService) {}

  @Get('portfolios')
  list(@CurrentUser() user: AuthUser) {
    return this.portfolios.list(user.id);
  }

  @Post('portfolios')
  @Roles('OWNER')
  createPaper(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createPaperSchema)) b: z.infer<typeof createPaperSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.portfolios.createPaper(user.id, b.name, b.initialCash, meta);
  }

  @Get('portfolios/:id/holdings')
  holdings(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.portfolios.holdings(user.id, id);
  }

  @Get('portfolios/:id/transactions')
  transactions(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(pageSchema)) q: z.infer<typeof pageSchema>,
  ) {
    return this.portfolios.transactions(user.id, id, q.limit, q.cursor);
  }

  @Post('portfolios/:id/cash-movements')
  @Roles('OWNER')
  addCash(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(cashSchema)) b: z.infer<typeof cashSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.portfolios.addCash(user.id, id, b.type, b.amount, b.valueDate, b.description, meta);
  }

  @Get('portfolios/:id/risk-limits')
  riskLimits(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.portfolios.riskLimits(user.id, id);
  }

  @Put('portfolios/:id/risk-limits')
  @Roles('OWNER')
  @RequireStepUp()
  setRiskLimits(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(riskLimitsSchema)) b: z.infer<typeof riskLimitsSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.portfolios.setRiskLimits(user.id, id, b, meta);
  }

  @Get('dashboard/summary')
  summary(@CurrentUser() user: AuthUser, @Query('portfolioId', new ParseUUIDPipe()) portfolioId: string) {
    return this.portfolios.summary(user.id, portfolioId);
  }
}
