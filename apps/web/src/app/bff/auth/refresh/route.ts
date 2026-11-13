import { handleRefresh } from '@/lib/bff/handlers';

/** Internal: the catch-all refreshes on its own; this exists for explicit session renewal. */
export function POST(req: Request) {
  return handleRefresh(req);
}
