import { describe, expect, it } from 'vitest';
import { PsxCalendar } from '../market-data/calendar.js';
import { signalExpiresAt } from './signal-expiry.js';

describe('signalExpiresAt', () => {
  const cal = new PsxCalendar(['2026-11-17']); // a Tuesday holiday

  it('D1: expires at the close of the next trading session (weekend skipped)', () => {
    // Friday 2026-11-13 bar (stored at the 09:30 PKT open) → Monday 2026-11-16 15:30 PKT = 10:30Z.
    expect(signalExpiresAt('D1', new Date('2026-11-13T04:30:00Z'), cal).toISOString()).toBe(
      '2026-11-16T10:30:00.000Z',
    );
  });

  it('D1: skips holidays', () => {
    // Monday's bar → Tuesday is a holiday → Wednesday's close.
    expect(signalExpiresAt('D1', new Date('2026-11-16T04:30:00Z'), cal).toISOString()).toBe(
      '2026-11-18T10:30:00.000Z',
    );
  });

  it('intraday: one bar after the source bar has closed', () => {
    expect(signalExpiresAt('M15', new Date('2026-11-16T05:00:00Z'), cal).toISOString()).toBe(
      '2026-11-16T05:30:00.000Z',
    );
  });
});
