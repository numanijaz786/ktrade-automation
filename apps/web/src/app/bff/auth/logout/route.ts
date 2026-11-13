import { handleLogout } from '@/lib/bff/handlers';

export function POST(req: Request) {
  return handleLogout(req);
}
