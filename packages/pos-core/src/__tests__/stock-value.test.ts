import { describe, expect, it } from 'vitest';
import { stockValue } from '../reports';
import type { Product } from '../types';

const p = (o: Partial<Product>): Product => ({ id: Math.random().toString(36), tenant_id: 't', shop_id: 's', name: { ar: 'x', en: 'x' }, description: {}, price_usd: 0, price_currency: 'usd', price_lbp: 0,
  unit_kind: 'piece', decimal_qty: false, vat: false, track_stock: true, min_stock: 0, visible_online: true, is_available: true, is_active: true, on_hand: 0, reserved: 0, needs_review: false, updated_at: '', ...o } as Product);

describe('shop value (stock at cost / at selling price, per section)', () => {
  it('sums per section and in total; LBP prices use the rate; negative stock and missing cost are flagged, not counted', () => {
    const st = stockValue([
      p({ section: 'Dairy', on_hand: 10, cost_cents: 200, price_usd: 3 }),                               // cost 20.00, retail 30.00
      p({ section: 'Dairy', on_hand: 4, cost_cents: null, price_usd: 5 }),                               // no cost → 0 at cost, 20.00 retail
      p({ section: 'Drinks', on_hand: 6, cost_cents: 50, price_currency: 'lbp', price_lbp: 89_500 }),    // cost 3.00, retail 6 × $1.00
      p({ section: 'Drinks', on_hand: -3, cost_cents: 100, price_usd: 2 }),                              // below zero → counts as 0
      p({ section: null, on_hand: 1, cost_cents: 100, price_usd: 1.5, min_stock: 5 }),
    ], 89_500);
    expect(st).toMatchObject({ skus: 5, units: 21, cost_cents: 2000 + 300 + 100, retail_cents: 3000 + 2000 + 600 + 150, no_cost: 1, negative: 1 });
    expect(st.by_section.map(s => s.section)).toEqual(['Dairy', 'Drinks', '']);           // biggest value at cost first
    expect(st.by_section[0]).toMatchObject({ skus: 2, units: 14, cost_cents: 2000, retail_cents: 5000, no_cost: 1 });
    expect(st.by_section[1]).toMatchObject({ skus: 2, units: 6, cost_cents: 300, retail_cents: 600 });
    expect(st.by_section.reduce((a, s) => a + s.cost_cents, 0)).toBe(st.cost_cents);
    expect(st.low).toBe(2);   // the negative one and the one under its minimum
  });
});
