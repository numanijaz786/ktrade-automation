import { handleStepUp } from '@/lib/bff/handlers';

export function POST(req: Request) {
  return handleStepUp(req);
}
