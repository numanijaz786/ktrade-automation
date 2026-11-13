// Prints fresh local-development secrets for apps/api/.env. Run: pnpm --filter @ktrade/api keys:generate
// Output goes to YOUR terminal only. Never commit it, never paste it into chats or tickets.
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (s) => Buffer.from(s).toString('base64');

process.stdout.write(
  [
    `JWT_PRIVATE_KEY_B64=${b64(privateKey.export({ type: 'pkcs8', format: 'pem' }))}`,
    `JWT_PUBLIC_KEY_B64=${b64(publicKey.export({ type: 'spki', format: 'pem' }))}`,
    `APP_MASTER_KEY=${randomBytes(32).toString('base64')}`,
    '',
  ].join('\n'),
);
