import {
  Body,
  Controller,
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
import { Throttle } from '@nestjs/throttler';
import type { z } from 'zod';
import { type AuthUser, CurrentUser, ReqMeta, type RequestMeta, Roles } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  listImportsSchema,
  listRowsSchema,
  rowActionSchema,
  uploadImportSchema,
  type UploadImportInput,
} from './imports.schemas.js';
import { ImportsService } from './imports.service.js';

@ApiTags('imports')
@ApiBearerAuth()
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post()
  @Roles('OWNER')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Upload a statement/CSV (JSON {portfolioId, fileName, content}); rows are staged for review',
  })
  upload(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(uploadImportSchema)) body: UploadImportInput,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.imports.upload(user.id, body, meta);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listImportsSchema)) q: z.infer<typeof listImportsSchema>,
  ) {
    return this.imports.list(user.id, q.portfolioId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.imports.present(user.id, id);
  }

  @Get(':id/rows')
  rows(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(listRowsSchema)) q: z.infer<typeof listRowsSchema>,
  ) {
    return this.imports.rows(user.id, id, q.status);
  }

  @Patch(':id/rows/:rowId')
  @Roles('OWNER')
  @ApiOperation({ summary: 'Review: skip a row, or include a row flagged as a duplicate' })
  updateRow(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('rowId', new ParseUUIDPipe()) rowId: string,
    @Body(new ZodValidationPipe(rowActionSchema)) body: z.infer<typeof rowActionSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.imports.updateRow(user.id, id, rowId, body.action, meta);
  }

  @Post(':id/commit')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Post all VALID rows to the ledger atomically (all or nothing)' })
  commit(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.imports.commit(user.id, id, meta);
  }

  @Post(':id/reject')
  @Roles('OWNER')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.imports.reject(user.id, id, meta);
  }
}
