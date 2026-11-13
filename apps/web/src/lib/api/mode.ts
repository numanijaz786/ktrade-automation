/**
 * `NEXT_PUBLIC_DATA_MODE=api|demo` (inlined at build time). Default `demo` so the app runs without a
 * backend. In `api` mode every figure comes from the NestJS API through the BFF; demo data is never mixed in.
 */
export type AppDataMode = 'api' | 'demo';

export function parseDataMode(v: string | undefined): AppDataMode {
  return v === 'api' ? 'api' : 'demo';
}

export const DATA_MODE: AppDataMode = parseDataMode(process.env.NEXT_PUBLIC_DATA_MODE);
