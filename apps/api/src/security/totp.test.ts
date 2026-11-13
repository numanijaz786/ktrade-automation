import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  timeStep,
  verifyTotp,
} from './totp.js';

// RFC 6238 Appendix B: SHA1 seed "12345678901234567890", 8-digit codes.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)('matches the RFC test vector at T=%i', (t, expected) => {
    expect(hotp(RFC_SECRET, timeStep(t * 1000), 8)).toBe(expected);
  });

  it('base32 round-trips arbitrary bytes', () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 128]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('generates 160-bit secrets', () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('verifies the current code and tolerates ±1 step of clock skew', () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1_700_000_000_000;
    const code = hotp(RFC_SECRET, timeStep(now));
    expect(verifyTotp(secret, code, now).ok).toBe(true);
    expect(verifyTotp(secret, code, now + 30_000).ok).toBe(true); // one step later
    expect(verifyTotp(secret, code, now + 90_000).ok).toBe(false); // three steps later
  });

  it('rejects replay of an already-used step', () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1_700_000_000_000;
    const code = hotp(RFC_SECRET, timeStep(now));
    const first = verifyTotp(secret, code, now);
    expect(first.ok).toBe(true);
    expect(verifyTotp(secret, code, now, first.step!).ok).toBe(false);
  });

  it('rejects malformed codes without throwing', () => {
    expect(verifyTotp(base32Encode(RFC_SECRET), '12a456', Date.now()).ok).toBe(false);
    expect(verifyTotp(base32Encode(RFC_SECRET), '1234567', Date.now()).ok).toBe(false);
  });

  it('builds an otpauth URI for authenticator apps', () => {
    expect(otpauthUri('ABC', 'me@example.com')).toMatch(
      /^otpauth:\/\/totp\/KTrade%20Smart%20Trading%3Ame%40example\.com\?secret=ABC/,
    );
  });
});
