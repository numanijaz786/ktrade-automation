import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Container builds (infra/docker/web.Dockerfile) set NEXT_OUTPUT=standalone to emit a self-contained
  // `server.js` with only the traced node_modules. `next dev` / `next start` are unaffected otherwise.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
