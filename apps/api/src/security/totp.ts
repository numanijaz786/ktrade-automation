import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) — the parameters every authenticator app supports.
 * Implemented on node:crypto to avoid a dependency; verified against the RFC 6238 Appendix B vectors.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret (RFC 4226 recommendation), base32 for authenticator apps. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function timeStep(epochMs: number): bigint {
  return BigInt(Math.floor(epochMs / 1000 / TOTP_STEP_SECONDS));
}

export function hotp(secret: Buffer, counter: bigint, digits = TOTP_DIGITS, algorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export interface TotpVerifyResult {
  ok: boolean;
  /** The matched step — persist it and reject any code at or before it (replay protection). */
  step?: bigint;
}

/**
 * Verifies a code within ±`window` steps (clock skew), rejecting steps ≤ lastUsedStep (replay).
 * Constant-time comparison of each candidate.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastUsedStep: bigint | null = null,
  window = 1,
): TotpVerifyResult {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const secret = base32Decode(secretBase32);
  const current = timeStep(nowMs);
  const provided = Buffer.from(code);
  for (let w = -window; w <= window; w++) {
    const step = current + BigInt(w);
    if (step < 0n || (lastUsedStep !== null && step <= lastUsedStep)) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, provided)) return { ok: true, step };
  }
  return { ok: false };
}

export function otpauthUri(secretBase32: string, account: string, issuer = 'KTrade Smart Trading'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
