import { ALL_ENUMS } from '@ktrade/shared';
import { describe, expect, it } from 'vitest';
import * as PrismaEnums from '../src/generated/prisma/enums.js';

/**
 * Guards the contract between the database (Prisma enums) and every other layer (@ktrade/shared).
 * If this fails, update packages/shared/src/enums.ts to match schema.prisma (or vice versa).
 */
describe('Prisma enums ↔ @ktrade/shared enums', () => {
  const prisma = PrismaEnums as unknown as Record<string, Record<string, string>>;

  it('every Prisma enum exists in shared with identical values in identical order', () => {
    for (const [name, values] of Object.entries(prisma)) {
      expect(ALL_ENUMS[name], `shared is missing enum ${name}`).toBeDefined();
      expect([...(ALL_ENUMS[name] ?? [])], `enum ${name} differs`).toEqual(Object.values(values));
    }
  });

  it('shared declares no enums that the database does not have', () => {
    for (const name of Object.keys(ALL_ENUMS)) expect(prisma[name], `Prisma lacks enum ${name}`).toBeDefined();
  });
});
