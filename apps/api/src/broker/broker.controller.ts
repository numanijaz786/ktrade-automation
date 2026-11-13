import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { type AuthUser, CurrentUser, ReqMeta, type RequestMeta, Roles } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { BrokerAccountsService } from './broker-accounts.service.js';

const createAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  /** Only the last 4 characters are ever stored, masked. Never send credentials. */
  clientCodeLast4: z.string().trim().regex(/^[A-Za-z0-9]{4}$/).optional(),
  portfolioName: z.string().trim().min(1).max(80).default('KTrade (live)'),
});

@ApiTags('broker')
@ApiBearerAuth()
@Controller('broker')
export class BrokerController {
  constructor(private readonly accounts: BrokerAccountsService) {}

  @Get('accounts')
  list(@CurrentUser() user: AuthUser) {
    return this.accounts.list(user.id);
  }

  @Post('accounts')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Register your KTrade account + LIVE portfolio (no credentials; automation adapters disabled)' })
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(createAccountSchema)) body: z.infer<typeof createAccountSchema>, @ReqMeta() meta: RequestMeta) {
    return this.accounts.create(user.id, body, meta);
  }

  @Get('accounts/:id/connections')
  connections(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.accounts.connections(user.id, id);
  }
}
