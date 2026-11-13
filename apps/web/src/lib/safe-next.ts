/** Post-login redirect target: same-origin absolute paths only (no `//host`, no scheme, no backslashes). */
export function safeNextPath(next: string | null | undefined, fallback = '/market/overview'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  if (next.startsWith('/login') || next.startsWith('/register') || next.startsWith('/bff')) return fallback;
  return next;
}
