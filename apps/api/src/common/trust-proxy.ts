import { isIP } from 'node:net';

/**
 * Which hops may set `X-Forwarded-For` (Express `trust proxy`, ADR-032 follow-up). Dependency-free so the env
 * schema can import it without loading Nest.
 *
 * Only explicit addresses/CIDRs and proxy-addr's named ranges are accepted. Hop counts, `true` and very wide
 * ranges are rejected: they would let any client spoof its IP and dodge per-client rate limits.
 */
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);
const MIN_PREFIX = { 4: 8, 6: 16 } as const;

export function isTrustProxyEntry(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) return true;
  const [addr = '', prefix, ...rest] = entry.split('/');
  if (rest.length) return false;
  const family = isIP(addr);
  if (family !== 4 && family !== 6) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= MIN_PREFIX[family] && bits <= (family === 4 ? 32 : 128);
}

/** Value for `app.set('trust proxy', …)`: the list, or `false` (trust nobody) when empty. */
export function trustProxySetting(entries: readonly string[]): string[] | false {
  return entries.length ? [...entries] : false;
}
