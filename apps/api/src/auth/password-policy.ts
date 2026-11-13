import * as argon2 from 'argon2';

/** OWASP Password Storage Cheat Sheet: Argon2id, m=64 MiB, t=3, p=1 (docs/04 §2). Dependency-free on purpose. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60_000;
