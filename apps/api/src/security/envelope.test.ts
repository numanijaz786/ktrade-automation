import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, openFromBuffer, seal, sealToBuffer } from './envelope.js';

const kek = randomBytes(32);

describe('envelope encryption', () => {
  it('round-trips', () => {
    const s = seal(kek, 1, Buffer.from('telegram-bot-token'), 'user1|notify:telegram|rec1');
    expect(open(kek, s, 'user1|notify:telegram|rec1').toString()).toBe('telegram-bot-token');
    expect(s.ciphertext.toString()).not.toContain('telegram');
  });

  it('uses a fresh DEK and IV per record (no deterministic ciphertext)', () => {
    const a = seal(kek, 1, Buffer.from('same'), 'aad');
    const b = seal(kek, 1, Buffer.from('same'), 'aad');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it('fails closed on wrong AAD (record swapping), wrong key, or tampering', () => {
    const s = seal(kek, 1, Buffer.from('secret'), 'user1|x');
    expect(() => open(kek, s, 'user2|x')).toThrow();
    expect(() => open(randomBytes(32), s, 'user1|x')).toThrow();
    const tampered = { ...s, ciphertext: Buffer.from(s.ciphertext) };
    tampered.ciphertext[0]! ^= 0xff;
    expect(() => open(kek, tampered, 'user1|x')).toThrow();
    expect(() => open(kek, { ...s, keyVersion: 2 }, 'user1|x')).toThrow();
  });

  it('rejects master keys that are not 32 bytes', () => {
    expect(() => seal(randomBytes(16), 1, Buffer.from('x'), 'a')).toThrow(/32 bytes/);
  });

  it('compact buffer form round-trips', () => {
    const buf = sealToBuffer(kek, 3, 'JBSWY3DPEHPK3PXP', 'totp|u1');
    expect(openFromBuffer(kek, buf, 'totp|u1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => openFromBuffer(kek, buf, 'totp|u2')).toThrow();
  });
});
