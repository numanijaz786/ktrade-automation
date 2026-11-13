import { z } from 'zod';

/**
 * Environment contract. The app refuses to start when anything is missing or malformed (fail fast).
 * Secrets are never logged; see docs/04.
 */
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Both URI schemes are valid for PostgreSQL (libpq); rediss:// is Redis over TLS.
  DATABASE_URL: z
    .string()
    .url()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// or postgresql:// URL'),
  REDIS_URL: z
    .string()
    .url()
    .regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL'),
  CORS_ORIGINS: csv,
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // ── Security (docs/04). Generate with: pnpm --filter @ktrade/api keys:generate ──
  /** base64 of a PKCS#8 PEM Ed25519 private key. */
  JWT_PRIVATE_KEY_B64: z.string().min(40),
  /** base64 of an SPKI PEM Ed25519 public key. */
  JWT_PUBLIC_KEY_B64: z.string().min(40),
  JWT_ISSUER: z.string().default('ktrade-api'),
  JWT_AUDIENCE: z.string().default('ktrade-web'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  STEP_UP_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  /** base64 of exactly 32 random bytes — key-encryption key for the credential vault. */
  APP_MASTER_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be base64 of exactly 32 bytes'),
  APP_MASTER_KEY_VERSION: z.coerce.number().int().min(1).max(65535).default(1),
  /** Background quote refresh (every 15 s). Off by default: quotes then refresh lazily on read. */
  MARKET_DATA_TICKER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Daily portfolio snapshots after 16:00 PKT on trading days (idempotent). Off by default. */
  SNAPSHOT_SCHEDULER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Evaluate alerts every 60 s during PSX market hours. Off by default (POST /alerts/evaluate still works). */
  ALERTS_SCHEDULER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    // Report variable NAMES and issues only — never values (they may be secrets).
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
