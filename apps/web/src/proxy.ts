import { NextResponse, type NextRequest } from 'next/server';
import { CSRF_COOKIE, csrfCookie, randomToken } from '@/lib/bff/cookies';

/**
 * Issues the double-submit CSRF cookie when the sign-in pages load, so the very first
 * `POST /bff/auth/login|register` can carry `x-csrf-token`. (`GET /bff/auth/me` issues it too.)
 * Auth itself is not checked here: the session cookies are scoped to `/bff` and never reach pages.
 */
export function proxy(request: NextRequest) {
  const res = NextResponse.next();
  if (!request.cookies.get(CSRF_COOKIE)?.value) res.headers.append('Set-Cookie', csrfCookie(randomToken()));
  return res;
}

export const config = {
  matcher: ['/login', '/register'],
};
