import { describe, it, expect } from 'vitest';
import { isOpenNow } from '../hours';

const hours = { mon: [['09:00', '13:00'], ['16:00', '20:00']], sat: [['22:00', '02:00']] } as Record<string, [string, string][]>;
// Helper: a Date at Beirut local time (UTC+3 in October)
const beirut = (iso: string) => new Date(iso + '+03:00');

describe('isOpenNow', () => {
  it('respects the override first', () => {
    expect(isOpenNow(hours, true, 'Asia/Beirut', beirut('2026-10-19T03:00'))).toBe(true);
    expect(isOpenNow(hours, false, 'Asia/Beirut', beirut('2026-10-19T10:00'))).toBe(false);
  });
  it('is open 24/7 with no hours configured', () => { expect(isOpenNow({}, null, 'Asia/Beirut', beirut('2026-10-19T03:00'))).toBe(true); });
  it('handles split days and closed days', () => {
    expect(isOpenNow(hours, null, 'Asia/Beirut', beirut('2026-10-19T10:00'))).toBe(true);   // Monday morning
    expect(isOpenNow(hours, null, 'Asia/Beirut', beirut('2026-10-19T14:30'))).toBe(false);  // siesta
    expect(isOpenNow(hours, null, 'Asia/Beirut', beirut('2026-10-19T19:59'))).toBe(true);
    expect(isOpenNow(hours, null, 'Asia/Beirut', beirut('2026-10-20T10:00'))).toBe(false);  // Tuesday: closed
  });
  it('rolls past midnight', () => {
    expect(isOpenNow(hours, null, 'Asia/Beirut', beirut('2026-10-17T23:30'))).toBe(true);   // Saturday night
    expect(isOpenNow(hours, null, 'Asia/Beirut', beirut('2026-10-18T01:30'))).toBe(true);   // Sunday 01:30 — still Saturday's range
    expect(isOpenNow(hours, null, 'Asia/Beirut', beirut('2026-10-18T02:30'))).toBe(false);
  });
});
