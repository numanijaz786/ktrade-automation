// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCookieHeader, readSetCookie, safeEqual } from './cookies';
import {
  handleCredentials,
  handleLogout,
  handleMe,
  handleProxy,
  handleRefresh,
  handleStepUp,
  resetRefreshCache,
  trustedClientIp,
} from './handlers';

const API = 'http://api.test/api/v1';
const CSRF = 'csrf-token-abc';
const ACCESS = 'eyJhbGciOiJFZERTQSJ9.access.sig';
const NEW_ACCESS = 'eyJhbGciOiJFZERTQSJ9.access2.sig';
const RT = 'rt-old-0123456789';
const NEW_RT = 'rt-new-9876543210';
const USER = { id: 'u1', email: 'o@example.com', displayName: 'Owner', role: 'OWNER', totpEnabled: false };

function req(
  path: string,
  init: {
    method?: string;
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
) {
  const headers = new Headers(init.headers);
  const jar = { ...(init.cookies ?? {}) };
  if (Object.keys(jar).length)
    headers.set(
      'cookie',
      Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    );
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`http://web.test${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const csrf = { cookies: { ktrade_csrf: CSRF }, headers: { 'x-csrf-token': CSRF } };

function tokenResponse(access: string, rt: string) {
  const h = new Headers({ 'content-type': 'application/json' });
  h.append(
    'set-cookie',
    `ktrade_rt=${rt}; Path=/api/v1/auth; Expires=${new Date(Date.now() + 7 * 86_400_000).toUTCString()}; HttpOnly; SameSite=Strict`,
  );
  return new Response(JSON.stringify({ accessToken: access, expiresIn: 900, user: USER }), {
    status: 200,
    headers: h,
  });
}

const problemRes = (status: number, code: string) =>
  new Response(JSON.stringify({ type: 'x', title: 'T', status, code, detail: 'd' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}
function cookieLine(res: Response, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('API_BASE_URL', API);
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('BFF_COOKIE_SECURE', '');
  resetRefreshCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('CSRF (double submit)', () => {
  it('rejects a mutating proxy call without the header, before contacting the API', async () => {
    const res = await handleProxy(
      req('/bff/watchlists', {
        method: 'POST',
        cookies: { ktrade_csrf: CSRF, ktrade_at: ACCESS },
        body: { name: 'x' },
      }),
      ['watchlists'],
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CSRF_FAILED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a header that does not match the cookie', async () => {
    const res = await handleProxy(
      req('/bff/watchlists', {
        method: 'POST',
        cookies: { ktrade_csrf: CSRF, ktrade_at: ACCESS },
        headers: { 'x-csrf-token': `${CSRF}x` },
        body: { name: 'x' },
      }),
      ['watchlists'],
    );
    expect(res.status).toBe(403);
  });

  it('rejects a cross-origin request even with a valid token', async () => {
    const res = await handleProxy(
      req('/bff/watchlists', {
        method: 'DELETE',
        cookies: { ...csrf.cookies, ktrade_at: ACCESS },
        headers: { ...csrf.headers, origin: 'https://evil.test', host: 'web.test' },
      }),
      ['watchlists'],
    );
    expect(res.status).toBe(403);
  });

  it('ignores a client-sent X-Forwarded-Host unless the BFF is behind the trusted proxy', async () => {
    const crossSite = () =>
      handleProxy(
        req('/bff/watchlists', {
          method: 'DELETE',
          cookies: { ...csrf.cookies, ktrade_at: ACCESS },
          headers: {
            ...csrf.headers,
            origin: 'https://evil.test',
            host: 'web.test',
            'x-forwarded-host': 'evil.test',
          },
        }),
        ['watchlists'],
      );
    expect((await crossSite()).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    // Behind nginx the header is nginx's own (public host), so it is the one compared.
    vi.stubEnv('BFF_TRUST_PROXY', 'true');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect((await crossSite()).status).toBe(204);
  });

  it('requires CSRF on login and register too', async () => {
    for (const kind of ['login', 'register'] as const) {
      const res = await handleCredentials(req(`/bff/auth/${kind}`, { method: 'POST', body: {} }), kind);
      expect(res.status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets GET through without a token and passes a valid token', async () => {
    fetchMock.mockResolvedValueOnce(okJson([]));
    expect(
      (await handleProxy(req('/bff/watchlists', { cookies: { ktrade_at: ACCESS } }), ['watchlists'])).status,
    ).toBe(200);
    fetchMock.mockResolvedValueOnce(okJson({ id: 'w' }));
    const res = await handleProxy(
      req('/bff/watchlists', {
        method: 'POST',
        cookies: { ...csrf.cookies, ktrade_at: ACCESS },
        headers: csrf.headers,
        body: { name: 'x' },
      }),
      ['watchlists'],
    );
    expect(res.status).toBe(200);
  });

  it('GET /bff/auth/me issues a readable CSRF cookie when absent, even on 401', async () => {
    const res = await handleMe(req('/bff/auth/me'));
    expect(res.status).toBe(401);
    const line = cookieLine(res, 'ktrade_csrf')!;
    expect(line).toMatch(/^ktrade_csrf=[A-Za-z0-9_-]{40,}; Path=\/; SameSite=Strict$/);
    expect(line).not.toContain('HttpOnly');
  });

  it('compares tokens in constant time semantics (length mismatch, empty)', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
  });
});

describe('login / register', () => {
  it('stores tokens in httpOnly cookies and returns only the user', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse(ACCESS, RT));
    const res = await handleCredentials(
      req('/bff/auth/login', { method: 'POST', ...csrf, body: { email: 'o@example.com', password: 'pw' } }),
      'login',
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ user: USER });
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain(RT);
    expect(text).not.toMatch(/accessToken|refreshToken/);

    const at = cookieLine(res, 'ktrade_at')!;
    expect(at).toBe(`ktrade_at=${ACCESS}; Path=/bff; Max-Age=900; HttpOnly; SameSite=Strict`);
    const rt = cookieLine(res, 'ktrade_rt')!;
    expect(rt).toMatch(new RegExp(`^ktrade_rt=${RT}; Path=/bff; Max-Age=\\d+; HttpOnly; SameSite=Strict$`));
    expect(res.headers.get('cache-control')).toBe('no-store');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/auth/login`);
    expect(init.method).toBe('POST');
  });

  it('marks cookies Secure in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    fetchMock.mockResolvedValueOnce(tokenResponse(ACCESS, RT));
    const res = await handleCredentials(
      req('/bff/auth/register', { method: 'POST', ...csrf, body: {} }),
      'register',
    );
    expect(res.status).toBe(201);
    for (const c of setCookies(res)) expect(c).toContain('; Secure');
  });

  it('passes API problem+json errors through unchanged and sets no cookie', async () => {
    fetchMock.mockResolvedValueOnce(problemRes(401, 'TOTP_REQUIRED'));
    const res = await handleCredentials(
      req('/bff/auth/login', { method: 'POST', ...csrf, body: {} }),
      'login',
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'TOTP_REQUIRED', detail: 'd' });
    expect(setCookies(res)).toEqual([]);
  });
});

describe('refresh once, then retry', () => {
  it('refreshes on a 401, updates both cookies and retries with the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(problemRes(401, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(tokenResponse(NEW_ACCESS, NEW_RT))
      .mockResolvedValueOnce(okJson({ breadth: { total: 30 } }));
    const res = await handleProxy(
      req('/bff/market/overview?x=1', { cookies: { ktrade_at: ACCESS, ktrade_rt: RT } }),
      ['market', 'overview'],
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ breadth: { total: 30 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [u1, i1] = fetchMock.mock.calls[0];
    expect(u1).toBe(`${API}/market/overview?x=1`);
    expect(new Headers(i1.headers).get('authorization')).toBe(`Bearer ${ACCESS}`);
    const [u2, i2] = fetchMock.mock.calls[1];
    expect(u2).toBe(`${API}/auth/refresh`);
    expect(new Headers(i2.headers).get('cookie')).toBe(`ktrade_rt=${RT}`);
    const [, i3] = fetchMock.mock.calls[2];
    expect(new Headers(i3.headers).get('authorization')).toBe(`Bearer ${NEW_ACCESS}`);

    expect(cookieLine(res, 'ktrade_at')).toContain(`ktrade_at=${NEW_ACCESS};`);
    expect(cookieLine(res, 'ktrade_rt')).toContain(`ktrade_rt=${NEW_RT};`);
  });

  it('does not refresh twice when the retry is also 401', async () => {
    fetchMock
      .mockResolvedValueOnce(problemRes(401, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(tokenResponse(NEW_ACCESS, NEW_RT))
      .mockResolvedValueOnce(problemRes(401, 'UNAUTHENTICATED'));
    const res = await handleProxy(req('/bff/portfolios', { cookies: { ktrade_at: ACCESS, ktrade_rt: RT } }), [
      'portfolios',
    ]);
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clears the cookies and returns 401 when the refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(problemRes(401, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(problemRes(401, 'SESSION_REVOKED'));
    const res = await handleProxy(req('/bff/portfolios', { cookies: { ktrade_at: ACCESS, ktrade_rt: RT } }), [
      'portfolios',
    ]);
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cookieLine(res, 'ktrade_at')).toMatch(/^ktrade_at=; Path=\/bff; Max-Age=0; HttpOnly/);
    expect(cookieLine(res, 'ktrade_rt')).toMatch(/^ktrade_rt=; Path=\/bff; Max-Age=0; HttpOnly/);
  });

  it('refreshes first when only the refresh cookie is left (access cookie expired)', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse(NEW_ACCESS, NEW_RT)).mockResolvedValueOnce(okJson(USER));
    const res = await handleMe(req('/bff/auth/me', { cookies: { ktrade_rt: RT, ktrade_csrf: CSRF } }));
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/auth/refresh`);
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('authorization')).toBe(`Bearer ${NEW_ACCESS}`);
  });

  it('shares one refresh between concurrent requests (rotation reuse would revoke the session)', async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) return tokenResponse(NEW_ACCESS, NEW_RT);
      const auth = new Headers(init.headers).get('authorization');
      return auth === `Bearer ${NEW_ACCESS}` ? okJson({ ok: true }) : problemRes(401, 'UNAUTHENTICATED');
    });
    const jar = { cookies: { ktrade_at: ACCESS, ktrade_rt: RT } };
    const results = await Promise.all([
      handleProxy(req('/bff/a', jar), ['a']),
      handleProxy(req('/bff/b', jar), ['b']),
      handleProxy(req('/bff/c', jar), ['c']),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('returns 401 without calling the API when there is no session at all', async () => {
    const res = await handleProxy(req('/bff/portfolios'), ['portfolios']);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('catch-all proxy', () => {
  it('passes problem+json errors through unchanged (status + body)', async () => {
    const body = { type: 'x', title: 'Conflict', status: 409, code: 'ALREADY_EXISTS', detail: 'dup' };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 409,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );
    const res = await handleProxy(
      req('/bff/watchlists', {
        method: 'POST',
        cookies: { ...csrf.cookies, ktrade_at: ACCESS },
        headers: csrf.headers,
        body: { name: 'a' },
      }),
      ['watchlists'],
    );
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toEqual(body);
  });

  it('forwards method, JSON body, Idempotency-Key, X-Step-Up-Token and x-request-id — never upstream Set-Cookie', async () => {
    const upstream = okJson({ id: 'o1' });
    upstream.headers.append('set-cookie', 'ktrade_rt=leak; Path=/api/v1/auth');
    fetchMock.mockResolvedValueOnce(upstream);
    const res = await handleProxy(
      req('/bff/orders/preview', {
        method: 'POST',
        cookies: { ...csrf.cookies, ktrade_at: ACCESS },
        headers: {
          ...csrf.headers,
          'idempotency-key': 'k-1',
          'x-step-up-token': 'su-1',
          'x-request-id': 'rid-1',
          cookie: '',
        },
        body: { symbol: 'OGDC' },
      }),
      ['orders', 'preview'],
    );
    expect(res.status).toBe(200);
    expect(setCookies(res)).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/orders/preview`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ symbol: 'OGDC' }));
    const h = new Headers(init.headers);
    expect(h.get('idempotency-key')).toBe('k-1');
    expect(h.get('x-step-up-token')).toBe('su-1');
    expect(h.get('x-request-id')).toBe('rid-1');
    expect(h.get('content-type')).toBe('application/json');
    expect(h.get('cookie')).toBeNull();
  });

  it('refuses token-issuing auth routes and path traversal', async () => {
    for (const p of [
      ['auth', 'login'],
      ['auth', 'refresh'],
      ['auth', 'register'],
    ]) {
      const res = await handleProxy(req(`/bff/${p.join('/')}`, { cookies: { ktrade_at: ACCESS } }), p);
      expect(res.status).toBe(404);
    }
    expect(
      (await handleProxy(req('/bff/x', { cookies: { ktrade_at: ACCESS } }), ['..', 'admin'])).status,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-JSON bodies and oversize payloads', async () => {
    const r = new Request('http://web.test/bff/imports', {
      method: 'POST',
      headers: {
        cookie: `ktrade_csrf=${CSRF}; ktrade_at=${ACCESS}`,
        'x-csrf-token': CSRF,
        'content-type': 'text/plain',
      },
      body: 'hello',
    });
    expect((await handleProxy(r, ['imports'])).status).toBe(415);
    const big = new Request('http://web.test/bff/imports', {
      method: 'POST',
      headers: {
        cookie: `ktrade_csrf=${CSRF}; ktrade_at=${ACCESS}`,
        'x-csrf-token': CSRF,
        'content-type': 'application/json',
        'content-length': String(4 * 1024 * 1024),
      },
      body: '{}',
    });
    expect((await handleProxy(big, ['imports'])).status).toBe(413);
  });
});

describe('step-up, refresh, logout', () => {
  it('step-up returns { stepUpToken, expiresIn } to the browser', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ stepUpToken: 'su.jwt', expiresIn: 300 }));
    const res = await handleStepUp(
      req('/bff/auth/step-up', {
        method: 'POST',
        cookies: { ...csrf.cookies, ktrade_at: ACCESS },
        headers: csrf.headers,
        body: { totpCode: '123456' },
      }),
    );
    expect(await res.json()).toEqual({ stepUpToken: 'su.jwt', expiresIn: 300 });
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/auth/step-up`);
  });

  it('POST /bff/auth/refresh rotates both cookies and returns only the user', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse(NEW_ACCESS, NEW_RT));
    const res = await handleRefresh(
      req('/bff/auth/refresh', {
        method: 'POST',
        cookies: { ...csrf.cookies, ktrade_rt: RT },
        headers: csrf.headers,
      }),
    );
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ user: USER });
    expect(text).not.toContain(NEW_ACCESS);
    expect(cookieLine(res, 'ktrade_rt')).toContain(NEW_RT);
  });

  it('logout revokes upstream and always clears cookies', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await handleLogout(
      req('/bff/auth/logout', {
        method: 'POST',
        cookies: { ...csrf.cookies, ktrade_at: ACCESS, ktrade_rt: RT },
        headers: csrf.headers,
      }),
    );
    expect(res.status).toBe(204);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/auth/logout`);
    expect(cookieLine(res, 'ktrade_at')).toContain('Max-Age=0');
    expect(cookieLine(res, 'ktrade_rt')).toContain('Max-Age=0');
  });
});

describe('client IP forwarding (BFF_TRUST_PROXY)', () => {
  const upstreamXff = (call = 0) => (fetchMock.mock.calls[call][1].headers as Headers).get('x-forwarded-for');
  const proxied = (headers: Record<string, string>) =>
    handleProxy(req('/bff/portfolios', { cookies: { ktrade_at: ACCESS }, headers }), ['portfolios']);

  it('is off by default: a client-sent X-Forwarded-For / X-Real-IP is never forwarded', async () => {
    fetchMock.mockResolvedValueOnce(okJson([]));
    await proxied({ 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '6.6.6.6' });
    expect(upstreamXff()).toBeNull();
    vi.stubEnv('BFF_TRUST_PROXY', 'TRUE'); // only the exact string "true" enables it
    expect(trustedClientIp(req('/', { headers: { 'x-real-ip': '6.6.6.6' } }))).toBeNull();
  });

  it('when trusted, forwards the nginx-set X-Real-IP as a single X-Forwarded-For hop', async () => {
    vi.stubEnv('BFF_TRUST_PROXY', 'true');
    fetchMock.mockResolvedValueOnce(okJson([]));
    await proxied({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6, 203.0.113.7' });
    expect(upstreamXff()).toBe('203.0.113.7');
  });

  it('falls back to the right-most X-Forwarded-For entry (the hop nginx wrote), never the left-most', () => {
    vi.stubEnv('BFF_TRUST_PROXY', 'true');
    expect(trustedClientIp(req('/', { headers: { 'x-forwarded-for': '6.6.6.6, 2001:db8::1' } }))).toBe(
      '2001:db8::1',
    );
  });

  it('drops anything that is not a plain IP', () => {
    vi.stubEnv('BFF_TRUST_PROXY', 'true');
    for (const bad of ['', 'unknown', '203.0.113.7:443', '999.1.1.1', '1.2.3.4 , 5.6.7.8', 'a'.repeat(60)]) {
      expect(trustedClientIp(req('/', { headers: { 'x-real-ip': bad } }))).toBeNull();
    }
    // An invalid X-Real-IP is not "rescued" by a different X-Forwarded-For value.
    expect(
      trustedClientIp(req('/', { headers: { 'x-real-ip': 'nope', 'x-forwarded-for': '203.0.113.7' } })),
    ).toBeNull();
  });

  it('forwards the client IP on login and refresh too (per-client API rate limits and audit)', async () => {
    vi.stubEnv('BFF_TRUST_PROXY', 'true');
    fetchMock.mockResolvedValueOnce(tokenResponse(ACCESS, RT));
    await handleCredentials(
      req('/bff/auth/login', {
        method: 'POST',
        ...csrf,
        headers: { ...csrf.headers, 'x-real-ip': '198.51.100.4' },
        body: { email: 'o@example.com', password: 'x' },
      }),
      'login',
    );
    expect(upstreamXff()).toBe('198.51.100.4');
    fetchMock.mockResolvedValueOnce(tokenResponse(NEW_ACCESS, NEW_RT));
    await handleRefresh(
      req('/bff/auth/refresh', {
        method: 'POST',
        cookies: { ...csrf.cookies, ktrade_rt: RT },
        headers: { ...csrf.headers, 'x-real-ip': '198.51.100.4' },
      }),
    );
    expect(upstreamXff(1)).toBe('198.51.100.4');
  });
});

describe('cookie helpers', () => {
  it('parses cookie headers and upstream Set-Cookie lifetimes', () => {
    expect(parseCookieHeader('a=1; b=two=2')).toEqual({ a: '1', b: 'two=2' });
    const now = Date.UTC(2026, 0, 1);
    const parsed = readSetCookie(
      [
        `other=x`,
        `ktrade_rt=abc; Path=/api/v1/auth; Expires=${new Date(now + 3600_000).toUTCString()}; HttpOnly`,
      ],
      'ktrade_rt',
      now,
    );
    expect(parsed).toEqual({ value: 'abc', maxAge: 3600 });
  });
});
