import { describe, expect, it } from 'vitest';
import { inShopOrder } from './itemCats';

describe('a shop\'s own section order (89)', () => {
  const shared = [{ key: 'Drinks', sort_order: 10 }, { key: 'Salads', sort_order: 20 }, { key: 'Manakish', sort_order: 30 }, { key: 'Pizza', sort_order: 40 }];
  it('no own order = the shared list untouched', () => { expect(inShopOrder(shared, [])).toBe(shared); });
  it('listed sections first, as listed; the rest after them in the shared order', () => {
    expect(inShopOrder(shared, ['Manakish', 'Pizza']).map(c => c.key)).toEqual(['Manakish', 'Pizza', 'Drinks', 'Salads']);
    expect(inShopOrder(shared, ['Pizza', 'Gone', 'Drinks']).map(c => c.key)).toEqual(['Pizza', 'Drinks', 'Salads', 'Manakish']);   // a key that no longer exists is ignored
    expect(inShopOrder(shared, ['Pizza']).map(c => c.sort_order)).toEqual([0, 1, 2, 3]);
  });
});
