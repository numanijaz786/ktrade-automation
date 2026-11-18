import { createHash } from 'node:crypto';

/** Lower-case, strip punctuation and collapse whitespace so "Board Meeting!" and "board  meeting" collide. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Host lower-cased; fragment and trailing slashes dropped; unparsable input is just trimmed + lower-cased. */
export function normalizeUrl(url: string | null | undefined): string {
  if (!url) return '';
  const t = url.trim();
  try {
    const u = new URL(t);
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return t.toLowerCase();
  }
}

/** sha-256 over normalised title + url + the exact publishedAt instant (UTC). */
export function announcementDedupeHash(input: {
  title: string;
  url?: string | null;
  publishedAt: Date;
}): string {
  const material = [
    normalizeTitle(input.title),
    normalizeUrl(input.url),
    input.publishedAt.toISOString(),
  ].join('\n');
  return createHash('sha256').update(material).digest('hex');
}
