import { describe, expect, it } from 'vitest';
import { dueLbp, lbpToCents, settle, totals } from '../money';

const lbp = (price: number, quantity = 1, extra: object = {}) => ({ price_currency: 'lbp' as const, unit_price_cents: 0, unit_price_lbp: price, quantity, ...extra });
const usd = (cents: number, quantity = 1) => ({ price_currency: 'usd' as const, unit_price_cents: cents, unit_price_lbp: 0, quantity });
const RATE = 89000;

describe('lira-priced items keep their lira total', () => {
  it('one item: the lira total is the price itself, not a figure rebuilt from cents', () => {
    const t = totals([lbp(221760)], 0, RATE, 1);
    expect(t.total_lbp).toBe(221760); expect(t.total_lbp_rounded).toBe(221760); expect(t.total_cents).toBe(249);
  });
  it('many items: the exact sum of the lira prices, and paying it in lira closes the sale', () => {
    const lines = [lbp(221760), lbp(274995, 2), lbp(138465, 3), lbp(45450), lbp(67890, 0.5), lbp(13350, 7)];
    const sum = 221760 + 549990 + 415395 + 45450 + 33945 + 93450;
    const t = totals(lines, 0, RATE, 1);
    expect(t.total_lbp).toBe(sum); expect(t.total_cents).toBe(lbpToCents(sum, RATE));
    expect(settle(t.total_cents, [{ tender: 'cash_lbp', currency: 'lbp', amount: dueLbp(t.total_cents, t.total_lbp, RATE, 1) }], RATE, 1, 'lbp').remaining_cents).toBe(0);
    expect(dueLbp(t.total_cents, t.total_lbp, RATE, 1)).toBe(sum);
  });
  it('a note step rounds the total only, never each item', () => {
    const t = totals([lbp(221760), lbp(221760), lbp(221760)], 0, RATE, 5000);
    expect(t.total_lbp).toBe(665280); expect(t.total_lbp_rounded).toBe(665000);          // per item it would have been 3 × 220,000 = 660,000
    expect(dueLbp(t.total_cents, t.total_lbp, RATE, 5000)).toBe(670000);                  // asked for: next note up, as before
  });
  it('a dollar cart is unchanged', () => {
    const t = totals([usd(249), usd(1000, 2)], 100, 89500, 5000);
    expect(t).toMatchObject({ subtotal_cents: 2249, discount_cents: 100, total_cents: 2149, total_lbp: Math.round(2149 * 895), total_lbp_rounded: 1925000 });
  });
  it('mixed cart with a discount: lira part exact, the rest converted', () => {
    const t = totals([lbp(221760), usd(500)], 100, RATE, 1);
    expect(t.total_cents).toBe(249 + 500 - 100); expect(t.total_lbp).toBe(221760 + 400 * 890);
  });
  it('voided lines and line discounts', () => {
    const t = totals([lbp(221760, 1, { voided: true }), lbp(100000, 1, { discount_cents: 12 }), lbp(50000, 1, { discount_cents: 9999 })], 0, RATE, 1);
    expect(t.subtotal_cents).toBe(112 - 12 + 0); expect(t.total_lbp).toBe(100000 - 12 * 890);
  });
  it('never asks for lira that leaves the order a cent short', () => {
    for (let i = 0; i < 400; i++) {
      const lines = Array.from({ length: 1 + (i % 9) }, (_, k) => lbp(1000 + ((i * 7919 + k * 104729) % 900000), 1 + (k % 3)));
      const t = totals(lines, i % 5 === 0 ? 37 : 0, RATE, 1);
      const pay = dueLbp(t.total_cents, t.total_lbp, RATE, 1);
      expect(settle(t.total_cents, [{ tender: 'cash_lbp', currency: 'lbp', amount: pay }], RATE, 1, 'lbp').remaining_cents).toBe(0);
      expect(Math.abs(pay - t.total_lbp)).toBeLessThan(900);
    }
  });
});

import { orderLineCents, orderRetotal } from '../money';
describe('re-total of a saved order (mirror of script 128)', () => {
  const l = (lbpPrice: number, quantity: number, cents: number, extra: object = {}) => ({ price_currency: 'lbp' as const, unit_price_lbp: lbpPrice, quantity, discount_cents: 0, line_total_cents: cents, ...extra });
  const lines = [l(221760, 1, 249), l(274995, 2, 618), l(138465, 3, 467)];
  it('lira lines keep the exact lira sum', () => {
    expect(orderRetotal(lines, 0, 0, RATE)).toEqual({ subtotal_cents: 1334, discount_cents: 0, total_cents: 1334, total_lbp: 1187145 });
  });
  it('fee and discount are converted, the lira part stays', () => {
    expect(orderRetotal(lines, 100, 200, RATE)).toMatchObject({ total_cents: 1434, total_lbp: 1187145 + 89000 });
  });
  it('mixed with a dollar line, a voided line', () => {
    const usdLine = { price_currency: 'usd' as const, unit_price_lbp: 0, quantity: 2, discount_cents: 0, line_total_cents: 1000 };
    expect(orderRetotal([...lines, usdLine], 0, 0, RATE)).toMatchObject({ total_cents: 2334, total_lbp: 1187145 + 890000 });
    expect(orderRetotal([{ ...lines[0], voided: true }, lines[1], lines[2], usdLine], 0, 0, RATE).total_lbp).toBe(549990 + 415395 + 890000);
  });
  it('a lira line whose stored cents came from another dollar price still counts by its lira', () => {
    expect(orderRetotal([l(274995, 2, 900), l(138465, 3, 467)], 0, 0, RATE)).toEqual({ subtotal_cents: 1085, discount_cents: 0, total_cents: 1085, total_lbp: 549990 + 415395 });
    expect(orderLineCents({ price_currency: 'lbp', unit_price_lbp: 740880, unit_price_cents: 823, discount_cents: 0 }, 2, 89500)).toBe(1656);
    expect(orderLineCents({ price_currency: 'usd', unit_price_lbp: 0, unit_price_cents: 823, discount_cents: 10 }, 2, 89500)).toBe(1636);
  });
  it('dollar-only order: as before', () => {
    expect(orderRetotal([{ price_currency: 'usd', unit_price_lbp: 0, quantity: 2, discount_cents: 0, line_total_cents: 1000 }], 0, 150, 89500)).toEqual({ subtotal_cents: 1000, discount_cents: 0, total_cents: 1150, total_lbp: 1029250 });
  });
});
