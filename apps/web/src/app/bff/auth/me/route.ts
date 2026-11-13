import { handleMe } from '@/lib/bff/handlers';

export function GET(req: Request) {
  return handleMe(req);
}
