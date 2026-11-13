import { generateKeyPairSync, randomBytes } from 'node:crypto';

// Runs before every test file is imported, so ConfigModule's import-time validation sees a complete env.
// Keys are generated per run: no test secret is ever committed.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
process.env.JWT_PRIVATE_KEY_B64 ??= Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
process.env.JWT_PUBLIC_KEY_B64 ??= Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
process.env.APP_MASTER_KEY ??= randomBytes(32).toString('base64');
process.env.COOKIE_SECURE ??= 'false';
