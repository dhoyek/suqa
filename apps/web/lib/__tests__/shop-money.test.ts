import { describe, expect, it } from 'vitest';
import { formatMoneySum, rateOf } from '../shop-money';
import { waSummary } from '../yorgo/whatsapp';

describe('a shop\'s own lira rate on the customer side (103)', () => {
  it('the shop\'s rate when it has one, the association\'s otherwise', () => {
    expect(rateOf({ a: 89000 }, 'a', 90000)).toBe(89000);
    expect(rateOf({ a: 89000 }, 'b', 90000)).toBe(90000);
    expect(rateOf(null, 'a', '90000')).toBe(90000);
    expect(rateOf({ a: 0 }, 'a', 90000)).toBe(90000);
  });
  it('a total across shops: dollars added up, lira = each shop at its own rate', () => {
    // $10 at 89,000 = 890,000 and $10 at 90,000 = 900,000 → 1,790,000 (not $20 at one rate)
    expect(formatMoneySum([{ usd: 10, rate: 89000 }, { usd: 10, rate: 90000 }], 'both', 'en')).toBe('$20.00 · 1,790,000 LBP');
    expect(formatMoneySum([{ usd: 10, rate: 90000 }], 'both', 'ar')).toBe('$10.00 · 900,000 ل.ل.');
    expect(formatMoneySum([], 'both', 'en')).toBe('$0.00 · 0 LBP');
    expect(formatMoneySum([{ usd: 1.25, rate: 89000 }], 'lbp', 'en')).toBe('111,000 LBP');
  });
  it('the WhatsApp basket line uses each shop\'s rate', () => {
    const shop = (id: string) => ({ id, slug: id, name: { ar: id, en: id }, whatsapp: null, min_order_usd: 0, pickup_enabled: true });
    const line = (id: string, usd: number) => ({ product_id: id, name: { ar: 'x', en: 'x' }, unit: null, price_usd: usd, days: null, shop: shop(id), quantity: 1 });
    const d = { lines: [line('a', 10), line('b', 10)], choices: [], not_found: [] };
    expect(waSummary(d as never, 'en', 90000, { a: 89000 })).toContain('$20.00 (1,790,000 L.L.)');
    expect(waSummary(d as never, 'en', 90000)).toContain('$20.00 (1,800,000 L.L.)');
  });
});
