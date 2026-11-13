/** Domain error codes from docs/07 §1 (RFC 9457 problem+json `code`). */
export type KnownApiErrorCode =
  | 'RISK_CHECK_FAILED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'KILL_SWITCH_ON'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_MISMATCH'
  | 'STALE_PRICE'
  | 'DUPLICATE_IMPORT'
  | 'STEP_UP_REQUIRED'
  | 'STEP_UP_FAILED'
  | 'INVALID_TOTP'
  | 'TOTP_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'REGISTRATION_CLOSED'
  | 'INVALID_STATE'
  | 'INVALID_ORDER_STATE'
  | 'NOT_FOUND'
  | 'UNKNOWN_SYMBOL'
  | 'ALREADY_EXISTS'
  | 'LIMIT_REACHED'
  | 'VALIDATION_FAILED'
  | 'FORBIDDEN'
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
  | 'EMPTY_FILE'
  // web / BFF
  | 'UNAUTHENTICATED'
  | 'CSRF_FAILED'
  | 'NOT_AVAILABLE'
  | 'NETWORK_ERROR'
  | 'BAD_RESPONSE';

/**
 * The API is the source of truth for codes and adds new ones over time, so any string is accepted;
 * the known ones keep editor completion.
 */
export type ApiErrorCode = KnownApiErrorCode | (string & {});

export interface FieldError {
  path: string;
  message: string;
}

/** Client-side representation of an RFC 9457 problem document. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly title: string;
  readonly errors: FieldError[];
  readonly requestId?: string;

  constructor(
    code: ApiErrorCode,
    status: number,
    title: string,
    detail?: string,
    extra: { errors?: FieldError[]; requestId?: string } = {},
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.title = title;
    this.errors = extra.errors ?? [];
    this.requestId = extra.requestId;
  }
}

/** Thrown by every method of an API group whose backend does not exist yet. Never replaced by demo data. */
export function notAvailable(): ApiError {
  return new ApiError('NOT_AVAILABLE', 501, 'Not available yet', 'Coming in a later phase');
}

export function isNotAvailable(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'NOT_AVAILABLE';
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return `${e.title}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}
