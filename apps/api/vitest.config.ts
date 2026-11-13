import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC (not esbuild) so Nest's decorator metadata (emitDecoratorMetadata) is emitted in tests.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./test/setup-env.ts'],
    // ConfigModule validates env at import time, so test env must exist before any module loads.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'silent',
    },
    // Integration tests (Testcontainers) are opt-in: they need Docker. CI sets RUN_INTEGRATION=1.
    exclude: process.env.RUN_INTEGRATION ? [] : ['test/**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
