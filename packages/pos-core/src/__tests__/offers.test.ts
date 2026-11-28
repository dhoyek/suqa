import { describe, expect, it } from 'vitest';
import { bundleAlloc, bundleView, type Offer, type OfferProduct } from '../offers';

const sum = (units: number[], lines: Array<{ q: number }>) => units.reduce((s, u, i) => s + u * lines[i].q, 0);
describe('bundleAlloc — the same vectors as supabase/test/offers_bundles.sql', () => {
  it('$2.50 + $4.00 + 2 × $1.25 for $7.00: charged exactly, no item above its price', () => {
    const lines = [{ u: 250, q: 1 }, { u: 400, q: 1 }, { u: 125, q: 2 }];
    const a = bundleAlloc(700, lines);
    expect(a.normal).toBe(900); expect(a.charged).toBe(700); expect(sum(a.units, lines)).toBe(700);
    a.units.forEach((u, i) => expect(u).toBeLessThanOrEqual(lines[i].u));
  });
  it('3 of one item for $3.10: a remainder no line can take is left to the customer', () => {
    const a = bundleAlloc(310, [{ u: 125, q: 3 }]);
    expect(a.units).toEqual([103]); expect(a.charged).toBe(309);
  });
  it('no saving: the normal prices', () => { expect(bundleAlloc(900, [{ u: 250, q: 1 }, { u: 400, q: 1 }])).toEqual({ units: [250, 400], charged: 650, normal: 650 }); });
  it('never above the price, never an item above its normal price', () => {
    for (let i = 0; i < 500; i++) {
      const lines = Array.from({ length: 1 + (i % 5) }, (_, k) => ({ u: 50 + ((i * 7919 + k * 104729) % 5000), q: 1 + ((i + k) % 4) }));
      const normal = lines.reduce((s, l) => s + l.u * l.q, 0); const price = Math.max(1, Math.floor(normal * (0.5 + (i % 45) / 100)));
      const a = bundleAlloc(price, lines);
      expect(a.charged).toBeLessThanOrEqual(price); expect(price - a.charged).toBeLessThan(Math.max(...lines.map(l => l.q)));
      expect(sum(a.units, lines)).toBe(a.charged); a.units.forEach((u, k) => { expect(u).toBeLessThanOrEqual(lines[k].u); expect(u).toBeGreaterThanOrEqual(0); });
    }
  });
  it('lira at the till: round unit prices, the exact bundle price', () => {
    const lines = [{ u: 221760, q: 1 }, { u: 274995, q: 2 }];
    const a = bundleAlloc(650000, lines, 1000);
    expect(a.charged).toBe(650000); expect(a.units[1] % 1000).toBe(0);
  });
});

describe('bundleView', () => {
  const P: Record<string, OfferProduct> = {
    a: { id: 'a', name: { en: 'A' }, price_currency: 'lbp', price_usd: 2.49, price_lbp: 221760 },
    b: { id: 'b', name: { en: 'B' }, price_currency: 'lbp', price_usd: 3.09, price_lbp: 274995 },
    c: { id: 'c', name: { en: 'C' }, price_currency: 'usd', price_usd: 1.25, price_lbp: 0 },
  };
  const offer = (o: Partial<Offer>): Offer => ({ id: 'o', shop_id: 's', kind: 'bundle', name: { ar: 'فطور' }, price_currency: 'lbp', price_usd: 0, price_lbp: 450000, is_active: true, is_hot: false,
    items: [{ product_id: 'a', quantity: 1, sort_order: 1 }, { product_id: 'b', quantity: 1, sort_order: 2 }], ...o });
  it('online: dollar cents at the shop rate (450,000 at 90,000 = $5.00)', () => {
    const v = bundleView(offer({}), id => P[id], 90000, 'online');
    expect(v.ok).toBe(true); expect(v.unit).toBe('cents'); expect(v.charged).toBe(500); expect(v.normal).toBe(246 + 306);
  });
  it('till: the exact lira', () => {
    const v = bundleView(offer({}), id => P[id], 90000, 'till');
    expect(v.unit).toBe('lbp'); expect(v.charged).toBe(450000); expect(v.normal).toBe(496755); expect(v.pct).toBe(9);
  });
  it('off when an item is out, in another currency, outside the dates, or switched off', () => {
    expect(bundleView(offer({}), id => (id === 'b' ? { ...P.b, is_available: false } : P[id]), 90000, 'online').why).toBe('item');
    expect(bundleView(offer({ items: [{ product_id: 'a', quantity: 1 }, { product_id: 'c', quantity: 1 }] }), id => P[id], 90000, 'online').why).toBe('currency');
    expect(bundleView(offer({ ends_at: '2020-01-01T00:00:00Z' }), id => P[id], 90000, 'online').why).toBe('ended');
    expect(bundleView(offer({ starts_at: '2999-01-01T00:00:00Z' }), id => P[id], 90000, 'online').why).toBe('not_yet');
    expect(bundleView(offer({ is_active: false }), id => P[id], 90000, 'online').why).toBe('off');
    expect(bundleView(offer({ price_lbp: 600000 }), id => P[id], 90000, 'online').why).toBe('no_saving');
    expect(bundleView(offer({}), id => (id === 'a' ? { ...P.a, available_days: [1] } : P[id]), 90000, 'online', new Date(), 2).why).toBe('item');
  });
});
