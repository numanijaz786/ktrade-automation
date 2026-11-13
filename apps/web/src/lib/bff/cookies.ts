/**
 * Cookie names, flags and helpers for the BFF. Runtime-agnostic (Web Crypto only) so the same code
 * serves route handlers and `proxy.ts`.
 */

export const ACCESS_COOKIE = 'ktrade_at';
export const REFRESH_COOKIE = 'ktrade_rt';
export const CSRF_COOKIE = 'ktrade_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** The access token is sent to every BFF route. */
export const ACCESS_COOKIE_PATH = '/bff';
/**
 * The refresh token must reach the catch-all proxy so it can refresh once on a 401, so it is scoped to
 * `/bff` (not `/bff/auth`). It is still httpOnly + SameSite=Strict and never sent to pages.
 */
export const REFRESH_COOKIE_PATH = '/bff';
export const CSRF_COOKIE_PATH = '/';

export interface CookieOptions {
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax';
  maxAge?: number;
}

/**
 * Secure in production. `BFF_COOKIE_SECURE=false` opts out explicitly (plain-http local smoke tests),
 * mirroring the API's `COOKIE_SECURE` switch.
 */
export function cookiesSecure(): boolean {
  const override = process.env.BFF_COOKIE_SECURE;
  if (override === 'false') return false;
  if (override === 'true') return true;
  return process.env.NODE_ENV === 'production';
}

const COOKIE_VALUE_RE = /^[A-Za-z0-9._~+/=-]*$/;

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  if (!COOKIE_VALUE_RE.test(value)) throw new Error(`Refusing to set cookie ${name}: unsafe characters`);
  const parts = [`${name}=${value}`, `Path=${o.path}`];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAge))}`);
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  parts.push(`SameSite=${o.sameSite ?? 'Strict'}`);
  return parts.join('; ');
}

export function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function accessCookie(token: string, maxAge: number): string {
  return serializeCookie(ACCESS_COOKIE, token, {
    path: ACCESS_COOKIE_PATH,
    httpOnly: true,
    secure: cookiesSecure(),
    sameSite: 'Strict',
    maxAge,
  });
}

export function refreshCookie(token: string, maxAge: number | undefined): string {
  return serializeCookie(REFRESH_COOKIE, token, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    secure: cookiesSecure(),
    sameSite: 'Strict',
    maxAge,
  });
}

/** Readable by page JS on purpose (double-submit): it is a CSRF nonce, not a credential. */
export function csrfCookie(token: string): string {
  return serializeCookie(CSRF_COOKIE, token, {
    path: CSRF_COOKIE_PATH,
    httpOnly: false,
    secure: cookiesSecure(),
    sameSite: 'Strict',
  });
}

export function clearSessionCookies(): string[] {
  const secure = cookiesSecure();
  return [
    serializeCookie(ACCESS_COOKIE, '', { path: ACCESS_COOKIE_PATH, httpOnly: true, secure, maxAge: 0 }),
    serializeCookie(REFRESH_COOKIE, '', { path: REFRESH_COOKIE_PATH, httpOnly: true, secure, maxAge: 0 }),
  ];
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time string comparison (length is folded into the result, not short-circuited). */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const len = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0 && ea.length > 0;
}

/** Extracts `name`'s value and lifetime (seconds) from an upstream `Set-Cookie` list. */
export function readSetCookie(
  setCookies: string[],
  name: string,
  nowMs: number,
): { value: string; maxAge: number | undefined } | null {
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(';');
    const i = pair.indexOf('=');
    if (i <= 0 || pair.slice(0, i).trim() !== name) continue;
    const value = pair.slice(i + 1).trim();
    let maxAge: number | undefined;
    for (const a of attrs) {
      const [k, ...v] = a.trim().split('=');
      const key = k.toLowerCase();
      if (key === 'max-age') maxAge = Number(v.join('='));
      else if (key === 'expires' && maxAge === undefined) {
        const t = Date.parse(v.join('='));
        if (!Number.isNaN(t)) maxAge = Math.floor((t - nowMs) / 1000);
      }
    }
    return { value, maxAge };
  }
  return null;
}
