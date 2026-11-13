/** Domain error codes from docs/07 §1 (RFC 9457 problem+json `code`). */
export type ApiErrorCode =
  | 'RISK_CHECK_FAILED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'KILL_SWITCH_ON'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_MISMATCH'
  | 'STALE_PRICE'
  | 'DUPLICATE_IMPORT'
  | 'STEP_UP_REQUIRED'
  | 'INVALID_TOTP'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_STATE'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  // statement imports (apps/api/src/imports)
  | 'IMPORT_HAS_INVALID_ROWS'
  | 'IMPORT_OVERSELL'
  | 'IMPORT_ROW_REJECTED'
  | 'IMPORT_REQUIRES_LIVE_PORTFOLIO'
  | 'INVALID_IMPORT_STATE'
  | 'NOTHING_TO_COMMIT'
  | 'ROW_NOT_INCLUDABLE'
  | 'UNSUPPORTED_FILE'
  | 'PARSE_FAILED'
  | 'EMPTY_FILE';

/** Client-side representation of an RFC 9457 problem document. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly title: string;

  constructor(code: ApiErrorCode, status: number, title: string, detail?: string) {
    super(detail ?? title);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.title = title;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return `${e.title}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}
