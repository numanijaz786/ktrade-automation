/**
 * BFF (backend-for-frontend) request handlers. The browser only ever talks to `/bff/*`; these
 * functions talk to the NestJS API (`API_BASE_URL`) and keep every token server-side:
 *
 *  - access token  → httpOnly cookie `ktrade_at` (Path=/bff, Max-Age = expiresIn)
 *  - refresh token → httpOnly cookie `ktrade_rt` (Path=/bff), taken from the API's own Set-Cookie
 *  - CSRF          → double-submit: readable `ktrade_csrf` cookie must equal the `x-csrf-token` header
 *                    on every non-GET request (constant-time compare)
 *
 * Responses to the browser never contain a token. Nothing here logs a token, cookie or body.
 * Pure `Request → Response` functions so they are unit-testable without a Next server.
 */
import {
  ACCESS_COOKIE,
  accessCookie,
  clearSessionCookies,
  CSRF_COOKIE,
  csrfCookie,
  CSRF_HEADER,
  parseCookieHeader,
  randomToken,
  readSetCookie,
  REFRESH_COOKIE,
  refreshCookie,
  safeEqual,
} from './cookies';

export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3001/api/v1';
/** Imports carry up to 2 MB of file text inside JSON; the API's own limit is 3 MB. */
export const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_AUTH_BODY_BYTES = 16 * 1024;
/** Concurrent requests that hit an expired access token share one refresh (rotation reuse = logout). */
const REFRESH_SHARE_MS = 30_000;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SEGMENT_RE = /^[A-Za-z0-9._~:@+-]+$/;
/** `/auth/*` is reachable through the catch-all only for these (login/register/refresh would leak tokens). */
const AUTH_PASSTHROUGH = new Set(['sessions', '2fa', 'password']);
const FORWARD_REQUEST_HEADERS = ['idempotency-key', 'x-step-up-token', 'x-request-id', 'user-agent'];

export function apiBaseUrl(): string {
  return (process.env.API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
}

// ─── responses ─────────────────────────────────────────────────────────────

function baseHeaders(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  h.set('Cache-Control', 'no-store');
  return h;
}

export function problem(
  status: number,
  code: string,
  title: string,
  detail?: string,
  setCookies: string[] = [],
) {
  const h = baseHeaders({ 'Content-Type': 'application/problem+json' });
  for (const c of setCookies) h.append('Set-Cookie', c);
  return new Response(
    JSON.stringify({ type: 'about:blank', title, status, code, ...(detail ? { detail } : {}) }),
    {
      status,
      headers: h,
    },
  );
}

function json(body: unknown, status = 200, setCookies: string[] = []): Response {
  const h = baseHeaders({ 'Content-Type': 'application/json' });
  for (const c of setCookies) h.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers: h });
}

// ─── CSRF ──────────────────────────────────────────────────────────────────

function cookiesOf(req: Request) {
  return parseCookieHeader(req.headers.get('cookie'));
}

/** Same-origin check on top of the token: a present `Origin` must match this host. */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** null when the request may proceed, otherwise the 403 to return. */
export function checkCsrf(req: Request): Response | null {
  if (SAFE_METHODS.has(req.method)) return null;
  const cookie = cookiesOf(req)[CSRF_COOKIE] ?? '';
  const header = req.headers.get(CSRF_HEADER) ?? '';
  if (!originAllowed(req) || !cookie || !header || !safeEqual(cookie, header)) {
    return problem(403, 'CSRF_FAILED', 'Forbidden', 'Missing or invalid CSRF token');
  }
  return null;
}

/** Set-Cookie for a fresh CSRF nonce when the browser has none. */
export function csrfIssue(req: Request): string[] {
  return cookiesOf(req)[CSRF_COOKIE] ? [] : [csrfCookie(randomToken())];
}

// ─── upstream ──────────────────────────────────────────────────────────────

interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  user: unknown;
}

interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshMaxAge: number | undefined;
  user: unknown;
}

type RefreshResult = { ok: true; session: Session } | { ok: false; status: number; body: string };

function upstreamHeaders(req: Request | null, extra: Record<string, string> = {}): Headers {
  const h = new Headers({ Accept: 'application/json', ...extra });
  if (req) {
    for (const name of FORWARD_REQUEST_HEADERS) {
      const v = req.headers.get(name);
      if (v) h.set(name, v);
    }
  }
  return h;
}

function getSetCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const one = res.headers.get('set-cookie');
  return one ? [one] : [];
}

/** Reads the API's token response + its `ktrade_rt` Set-Cookie. Never logs either. */
async function readSession(res: Response): Promise<Session | null> {
  const body = (await res.json().catch(() => null)) as TokenResponse | null;
  const rt = readSetCookie(getSetCookies(res), REFRESH_COOKIE, Date.now());
  if (!body || typeof body.accessToken !== 'string' || !rt?.value) return null;
  return {
    accessToken: body.accessToken,
    expiresIn: Number(body.expiresIn) || 900,
    refreshToken: rt.value,
    refreshMaxAge: rt.maxAge,
    user: body.user,
  };
}

function sessionCookies(s: Session): string[] {
  return [accessCookie(s.accessToken, s.expiresIn), refreshCookie(s.refreshToken, s.refreshMaxAge)];
}

const inflightRefresh = new Map<string, { at: number; promise: Promise<RefreshResult> }>();

async function doRefresh(refreshToken: string, req: Request | null): Promise<RefreshResult> {
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/auth/refresh`, {
      method: 'POST',
      headers: upstreamHeaders(req, { Cookie: `${REFRESH_COOKIE}=${refreshToken}` }),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 502, body: '' };
  }
  if (!res.ok) return { ok: false, status: res.status, body: await res.text().catch(() => '') };
  const session = await readSession(res);
  return session ? { ok: true, session } : { ok: false, status: 502, body: '' };
}

/** Single-flight refresh keyed by the refresh token (never persisted, evicted after 30 s). */
export function refreshSession(refreshToken: string, req: Request | null): Promise<RefreshResult> {
  const now = Date.now();
  for (const [k, v] of inflightRefresh) if (now - v.at > REFRESH_SHARE_MS) inflightRefresh.delete(k);
  const hit = inflightRefresh.get(refreshToken);
  if (hit) return hit.promise;
  const promise = doRefresh(refreshToken, req);
  inflightRefresh.set(refreshToken, { at: now, promise });
  return promise;
}

/** Test hook. */
export function resetRefreshCache(): void {
  inflightRefresh.clear();
}

async function readBody(
  req: Request,
  limit: number,
): Promise<{ ok: true; text: string } | { ok: false; res: Response }> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > limit) return { ok: false, res: problem(413, 'PAYLOAD_TOO_LARGE', 'Payload too large') };
  const text = await req.text();
  if (new TextEncoder().encode(text).length > limit)
    return { ok: false, res: problem(413, 'PAYLOAD_TOO_LARGE', 'Payload too large') };
  if (text && !(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json'))
    return { ok: false, res: problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send application/json') };
  return { ok: true, text };
}

/** Upstream response → browser response: status + body unchanged, only safe headers, never Set-Cookie. */
async function passThrough(res: Response, setCookies: string[] = []): Promise<Response> {
  const h = baseHeaders();
  const ct = res.headers.get('content-type');
  if (ct) h.set('Content-Type', ct);
  const rid = res.headers.get('x-request-id');
  if (rid) h.set('x-request-id', rid);
  for (const c of setCookies) h.append('Set-Cookie', c);
  const body = res.status === 204 || res.status === 304 ? null : await res.text();
  return new Response(body, { status: res.status, headers: h });
}

const upstreamDown = (cookies: string[] = []) =>
  problem(502, 'UPSTREAM_UNAVAILABLE', 'Bad Gateway', 'The API is not reachable', cookies);

/**
 * Authenticated call to the API with refresh-once semantics:
 * no access cookie but a refresh cookie → refresh first; API 401 → refresh once and retry;
 * refresh failure → clear the session cookies and return 401.
 */
async function authedCall(
  req: Request,
  apiPath: string,
  init: { method: string; body?: string },
  extraCookies: string[] = [],
): Promise<Response> {
  const jar = cookiesOf(req);
  let access = jar[ACCESS_COOKIE];
  const refresh = jar[REFRESH_COOKIE];
  const setCookies = [...extraCookies];
  let refreshed = false;

  const unauthenticated = (body?: string, status = 401) => {
    const cookies = [...extraCookies, ...clearSessionCookies()];
    if (body && status === 401) {
      const h = baseHeaders({ 'Content-Type': 'application/problem+json' });
      for (const c of cookies) h.append('Set-Cookie', c);
      return new Response(body, { status: 401, headers: h });
    }
    return problem(401, 'UNAUTHENTICATED', 'Unauthorized', 'Sign in again', cookies);
  };

  const tryRefresh = async (): Promise<Response | null> => {
    if (!refresh) return unauthenticated();
    refreshed = true;
    const r = await refreshSession(refresh, req);
    if (!r.ok) return r.status === 502 ? upstreamDown(extraCookies) : unauthenticated(r.body, r.status);
    access = r.session.accessToken;
    setCookies.push(...sessionCookies(r.session));
    return null;
  };

  if (!access) {
    const fail = await tryRefresh();
    if (fail) return fail;
  }

  const call = () =>
    fetch(`${apiBaseUrl()}/${apiPath}`, {
      method: init.method,
      headers: upstreamHeaders(req, {
        Authorization: `Bearer ${access}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      }),
      body: init.body || undefined,
      cache: 'no-store',
      redirect: 'manual',
    });

  let res: Response;
  try {
    res = await call();
    if (res.status === 401 && !refreshed) {
      await res.body?.cancel().catch(() => undefined);
      const fail = await tryRefresh();
      if (fail) return fail;
      res = await call();
    }
  } catch {
    return upstreamDown(setCookies);
  }
  if (res.status === 401) return unauthenticated(await res.text().catch(() => undefined));
  return passThrough(res, setCookies);
}

// ─── route handlers ────────────────────────────────────────────────────────

/** POST /bff/auth/login | /bff/auth/register — returns `{ user }` only. */
export async function handleCredentials(req: Request, kind: 'login' | 'register'): Promise<Response> {
  const csrf = checkCsrf(req);
  if (csrf) return csrf;
  const body = await readBody(req, MAX_AUTH_BODY_BYTES);
  if (!body.ok) return body.res;
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/auth/${kind}`, {
      method: 'POST',
      headers: upstreamHeaders(req, { 'Content-Type': 'application/json' }),
      body: body.text || '{}',
      cache: 'no-store',
    });
  } catch {
    return upstreamDown();
  }
  if (!res.ok) return passThrough(res);
  const session = await readSession(res);
  if (!session) return problem(502, 'BAD_UPSTREAM_RESPONSE', 'Bad Gateway', 'Unexpected auth response');
  return json({ user: session.user }, kind === 'register' ? 201 : 200, sessionCookies(session));
}

/** POST /bff/auth/refresh — rotates the refresh token; returns `{ user }`. */
export async function handleRefresh(req: Request): Promise<Response> {
  const csrf = checkCsrf(req);
  if (csrf) return csrf;
  const rt = cookiesOf(req)[REFRESH_COOKIE];
  if (!rt) return problem(401, 'NO_SESSION', 'Unauthorized', 'No session', clearSessionCookies());
  const r = await refreshSession(rt, req);
  if (!r.ok) {
    if (r.status === 502) return upstreamDown();
    return problem(401, 'SESSION_EXPIRED', 'Unauthorized', 'Sign in again', clearSessionCookies());
  }
  return json({ user: r.session.user }, 200, sessionCookies(r.session));
}

/** POST /bff/auth/logout — revokes the API session (best effort) and always clears the cookies. */
export async function handleLogout(req: Request): Promise<Response> {
  const csrf = checkCsrf(req);
  if (csrf) return csrf;
  const jar = cookiesOf(req);
  let access = jar[ACCESS_COOKIE];
  if (!access && jar[REFRESH_COOKIE]) {
    const r = await refreshSession(jar[REFRESH_COOKIE], req);
    if (r.ok) access = r.session.accessToken;
  }
  if (access) {
    await fetch(`${apiBaseUrl()}/auth/logout`, {
      method: 'POST',
      headers: upstreamHeaders(req, { Authorization: `Bearer ${access}` }),
      cache: 'no-store',
    })
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }
  const h = baseHeaders();
  for (const c of clearSessionCookies()) h.append('Set-Cookie', c);
  return new Response(null, { status: 204, headers: h });
}

/** GET /bff/auth/me — also issues the CSRF cookie when the browser has none (even on 401). */
export async function handleMe(req: Request): Promise<Response> {
  return authedCall(req, 'auth/me', { method: 'GET' }, csrfIssue(req));
}

/** POST /bff/auth/step-up — `{ stepUpToken, expiresIn }`; the client keeps it in memory only. */
export async function handleStepUp(req: Request): Promise<Response> {
  const csrf = checkCsrf(req);
  if (csrf) return csrf;
  const body = await readBody(req, MAX_AUTH_BODY_BYTES);
  if (!body.ok) return body.res;
  return authedCall(req, 'auth/step-up', { method: 'POST', body: body.text || '{}' });
}

/** `/bff/[...path]` → `${API_BASE_URL}/${path}` with the caller's session. */
export async function handleProxy(req: Request, segments: string[]): Promise<Response> {
  if (!segments.length || segments.some((s) => s === '.' || s === '..' || !SEGMENT_RE.test(s)))
    return problem(400, 'BAD_PATH', 'Bad Request', 'Invalid path');
  if (segments[0] === 'auth' && !AUTH_PASSTHROUGH.has(segments[1] ?? ''))
    return problem(404, 'NOT_FOUND', 'Not Found');
  const csrf = checkCsrf(req);
  if (csrf) return csrf;
  let body: string | undefined;
  if (!SAFE_METHODS.has(req.method)) {
    const read = await readBody(req, MAX_BODY_BYTES);
    if (!read.ok) return read.res;
    body = read.text || undefined;
  }
  const search = new URL(req.url).search;
  const path = segments.map(encodeURIComponent).join('/') + search;
  return authedCall(req, path, { method: req.method, body });
}
