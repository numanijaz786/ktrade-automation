import { describe, expect, it } from 'vitest';
import { validateEnv } from '../config/env.js';
import { isTrustProxyEntry, trustProxySetting } from './trust-proxy.js';

describe('trust proxy configuration', () => {
  it('accepts named ranges, single addresses and reasonably narrow CIDRs', () => {
    for (const ok of [
      'loopback',
      'uniquelocal',
      '127.0.0.1',
      '::1',
      '172.30.250.10',
      '172.30.250.0/24',
      'fd00::/64',
    ])
      expect(isTrustProxyEntry(ok), ok).toBe(true);
  });

  it('rejects hop counts, wildcards, wide ranges and junk (they would make X-Forwarded-For spoofable)', () => {
    for (const bad of [
      'true',
      '*',
      '1',
      '2',
      '0.0.0.0/0',
      '::/0',
      '10.0.0.0/7',
      '172.30.250.0/33',
      'web',
      'a/b/c',
      '',
    ])
      expect(isTrustProxyEntry(bad), bad).toBe(false);
  });

  it('defaults to loopback only; empty means trust nobody; invalid entries fail startup', () => {
    const base = { ...process.env };
    delete base.TRUST_PROXY_ADDRESSES;
    expect(validateEnv(base).TRUST_PROXY_ADDRESSES).toEqual(['loopback']);
    expect(
      validateEnv({ ...base, TRUST_PROXY_ADDRESSES: 'loopback, 172.30.250.10' }).TRUST_PROXY_ADDRESSES,
    ).toEqual(['loopback', '172.30.250.10']);
    expect(trustProxySetting(validateEnv({ ...base, TRUST_PROXY_ADDRESSES: '' }).TRUST_PROXY_ADDRESSES)).toBe(
      false,
    );
    expect(() => validateEnv({ ...base, TRUST_PROXY_ADDRESSES: 'loopback,true' })).toThrow(
      /TRUST_PROXY_ADDRESSES/,
    );
  });
});
