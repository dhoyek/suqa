import { describe, it, expect } from 'vitest';
import { NEXT_STATUS } from '../orders';

describe('order state machine (client mirror)', () => {
  it('matches the SQL transitions the merchant may trigger', () => {
    expect(NEXT_STATUS.pending).toEqual(['accepted', 'rejected']);
    expect(NEXT_STATUS.accepted).toEqual(['preparing']);
    expect(NEXT_STATUS.ready).toEqual(['out_for_delivery', 'delivered']);
    expect(NEXT_STATUS.delivered).toBeUndefined();
    expect(NEXT_STATUS.cancelled).toBeUndefined();
  });
});
