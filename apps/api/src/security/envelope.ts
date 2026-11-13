import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption (docs/04 §2): each record gets a random 256-bit data key (DEK) that encrypts the
 * plaintext with AES-256-GCM; the DEK itself is wrapped by the master key (KEK) with AES-256-GCM.
 * AAD binds ciphertext to its owner/purpose so records cannot be swapped between rows.
 * Deleting the wrapped DEK crypto-shreds the record.
 */
export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  /** iv(12) | tag(16) | encrypted DEK(32) */
  wrappedDek: Buffer;
  keyVersion: number;
}

const ALG = 'aes-256-gcm';
const IV_LEN = 12;

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALG, key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}

function gcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv(ALG, key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function assertKek(kek: Buffer): void {
  if (kek.length !== 32) throw new Error('Master key must be exactly 32 bytes (base64-encoded in APP_MASTER_KEY)');
}

export function seal(kek: Buffer, keyVersion: number, plaintext: Buffer, aad: string): Sealed {
  assertKek(kek);
  const aadBuf = Buffer.from(aad, 'utf8');
  const dek = randomBytes(32);
  try {
    const data = gcmEncrypt(dek, plaintext, aadBuf);
    const wrap = gcmEncrypt(kek, dek, Buffer.from(`dek|${aad}|v${keyVersion}`, 'utf8'));
    return {
      ciphertext: data.ct,
      iv: data.iv,
      authTag: data.tag,
      wrappedDek: Buffer.concat([wrap.iv, wrap.tag, wrap.ct]),
      keyVersion,
    };
  } finally {
    dek.fill(0);
  }
}

export function open(kek: Buffer, sealed: Sealed, aad: string): Buffer {
  assertKek(kek);
  const w = sealed.wrappedDek;
  const dek = gcmDecrypt(
    kek,
    w.subarray(0, IV_LEN),
    w.subarray(IV_LEN + 16),
    w.subarray(IV_LEN, IV_LEN + 16),
    Buffer.from(`dek|${aad}|v${sealed.keyVersion}`, 'utf8'),
  );
  try {
    return gcmDecrypt(dek, sealed.iv, sealed.ciphertext, sealed.authTag, Buffer.from(aad, 'utf8'));
  } finally {
    dek.fill(0);
  }
}

/** Compact single-buffer form for small secrets stored in one column (e.g. users.totpSecretEnc). */
export function sealToBuffer(kek: Buffer, keyVersion: number, plaintext: string, aad: string): Buffer {
  const s = seal(kek, keyVersion, Buffer.from(plaintext, 'utf8'), aad);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(s.keyVersion, 0);
  header.writeUInt16BE(s.wrappedDek.length, 2);
  return Buffer.concat([header, s.wrappedDek, s.iv, s.authTag, s.ciphertext]);
}

export function openFromBuffer(kek: Buffer, buf: Buffer, aad: string): string {
  const keyVersion = buf.readUInt16BE(0);
  const wrapLen = buf.readUInt16BE(2);
  let o = 4;
  const wrappedDek = buf.subarray(o, (o += wrapLen));
  const iv = buf.subarray(o, (o += IV_LEN));
  const authTag = buf.subarray(o, (o += 16));
  const ciphertext = buf.subarray(o);
  return open(kek, { keyVersion, wrappedDek, iv, authTag, ciphertext }, aad).toString('utf8');
}
