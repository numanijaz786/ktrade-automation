import { type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates and parses input with a Zod schema (shared with the web app via @ktrade/shared).
 * Throws ZodError, which ProblemDetailsFilter maps to 422 with per-field errors.
 *   @Body(new ZodValidationPipe(previewOrderSchema)) body: PreviewOrderInput
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    return this.schema.parse(value);
  }
}
