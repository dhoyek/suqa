import { describe, expect, it } from 'vitest';
import { fillCents } from '../sync/engine';

describe('storefront orders arrive in dollars; the till needs cents', () => {
  it('fills an order from its dollars (the HS-000020 case)', () => {
    const o = fillCents('orders', { id: 'o', total_usd: '8.26', subtotal_usd: '7.26', delivery_fee_usd: '1.00', fx_lbp_rate: 90000, total_cents: null, subtotal_cents: null, total_lbp: null, rate_lbp_per_usd: null });
    expect(o).toMatchObject({ total_cents: 826, subtotal_cents: 726, total_lbp: 743400, rate_lbp_per_usd: 90000 });
  });
  it('fills a line', () => {
    expect(fillCents('order_items', { id: 'l', unit_price_usd: 7.26, line_total_usd: 7.26, unit_price_cents: null, line_total_cents: null })).toMatchObject({ unit_price_cents: 726, line_total_cents: 726 });
  });
  it('never touches an order that already has cents, or other tables', () => {
    const pos = { id: 'p', total_usd: 5, total_cents: 480, subtotal_cents: 480, total_lbp: 1 }; expect(fillCents('orders', pos)).toBe(pos);
    const line = { id: 'l', line_total_cents: 100, unit_price_cents: 50, line_total_usd: 9 }; expect(fillCents('order_items', line)).toBe(line);
    const prod = { id: 'x', total_usd: 3 }; expect(fillCents('products', prod)).toBe(prod);
    const empty = { id: 'e', total_usd: null, total_cents: null }; expect(fillCents('orders', empty)).toBe(empty);
  });
});
