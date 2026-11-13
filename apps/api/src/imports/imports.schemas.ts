import { z } from 'zod';
import { IMPORT_KINDS, IMPORT_ROW_STATUSES } from '@ktrade/shared';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export const uploadImportSchema = z.object({
  portfolioId: z.string().uuid(),
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\\/:*?"<>|]+$/, 'must be a plain file name'),
  /** File text (UTF-8). CSV only for now; binary formats (PDF/XLSX) arrive with the KTrade parsers. */
  content: z
    .string()
    .min(1, 'file is empty')
    .refine(
      (c) => Buffer.byteLength(c, 'utf8') <= MAX_IMPORT_BYTES,
      `file exceeds ${MAX_IMPORT_BYTES / 1024 / 1024} MB`,
    ),
  kind: z.enum(IMPORT_KINDS).optional(),
});
export type UploadImportInput = z.infer<typeof uploadImportSchema>;

export const listImportsSchema = z.object({ portfolioId: z.string().uuid().optional() });
export const listRowsSchema = z.object({ status: z.enum(IMPORT_ROW_STATUSES).optional() });

/** Review actions: skip any non-committed row; include = override a DUPLICATE flag (never an INVALID row). */
export const rowActionSchema = z.object({ action: z.enum(['skip', 'include']) });
export type RowAction = z.infer<typeof rowActionSchema>['action'];
