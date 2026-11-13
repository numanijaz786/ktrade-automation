import { defineConfig } from 'prisma/config';

// DATABASE_URL is provided by the environment (infra/.env for docker compose, CI secrets in pipelines).
// A placeholder lets `prisma generate`/`validate` run without a database (they never connect).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
