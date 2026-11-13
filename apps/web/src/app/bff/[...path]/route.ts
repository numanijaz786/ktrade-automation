import { handleProxy } from '@/lib/bff/handlers';

/** Authenticated pass-through to the NestJS API (`API_BASE_URL`); see lib/bff/handlers.ts. */
async function proxy(req: Request, ctx: RouteContext<'/bff/[...path]'>) {
  const { path } = await ctx.params;
  return handleProxy(req, path);
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
