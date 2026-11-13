import { handleCredentials } from '@/lib/bff/handlers';

export function POST(req: Request) {
  return handleCredentials(req, 'register');
}
