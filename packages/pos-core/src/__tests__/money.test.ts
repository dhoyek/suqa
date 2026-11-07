import { describe, expect, it } from 'vitest';
import { lbpToCents, lineTotalCents, roundLbp, settle, totals, usdToLbp, fmtBoth } from '../money';
import { normalize, CatalogIndex } from '../catalog';
import { hashPin, verifyPin, offlineUnlockAllowed, isValidPin } from '../auth/pin';
import type { Product } from '../types';

const RATE = 89500;

describe('money (integer USD cents / LBP pounds)', () => {
  it('converts both ways with rounding', () => {
    expect(usdToLbp(100, RATE)).toBe(89500);
    expect(usdToLbp(125, RATE)).toBe(111875);
    expect(lbpToCents(89500, RATE)).toBe(100);
    expect(lbpToCents(100000, RATE)).toBe(112);           // 111.73 → 112
  });
  it('rounds LBP to notes', () => {
    expect(roundLbp(111875, 5000)).toBe(110000);
    expect(roundLbp(112500, 5000)).toBe(115000);
    expect(roundLbp(111875, 5000, 'down')).toBe(110000);
    expect(roundLbp(111875, 1000, 'up')).toBe(112000);
    expect(roundLbp(111875, 0)).toBe(111875);
  });
  it('line totals in either currency, weighed quantities, line discount', () => {
    expect(lineTotalCents({ price_currency: 'usd', unit_price_cents: 350, unit_price_lbp: 0, quantity: 3 }, RATE)).toBe(1050);
    expect(lineTotalCents({ price_currency: 'usd', unit_price_cents: 800, unit_price_lbp: 0, quantity: 0.25 }, RATE)).toBe(200);
    expect(lineTotalCents({ price_currency: 'lbp', unit_price_cents: 0, unit_price_lbp: 50000, quantity: 2 }, RATE)).toBe(112);
    expect(lineTotalCents({ price_currency: 'usd', unit_price_cents: 1000, unit_price_lbp: 0, quantity: 1, discount_cents: 150 }, RATE)).toBe(850);
  });
  it('order totals with discount and both currencies', () => {
    const t = totals([{ price_currency: 'usd', unit_price_cents: 350, unit_price_lbp: 0, quantity: 2 }, { price_currency: 'lbp', unit_price_cents: 0, unit_price_lbp: 89500, quantity: 1 }], 100, RATE, 5000);
    expect(t.subtotal_cents).toBe(800); expect(t.discount_cents).toBe(100); expect(t.total_cents).toBe(700);
    expect(t.total_lbp).toBe(626500); expect(t.total_lbp_rounded).toBe(625000);
  });
  it('split tender: cash USD + cash LBP, change in LBP rounded down to notes', () => {
    const s = settle(1050, [{ tender: 'cash_usd', amount: 1000, currency: 'usd' }, { tender: 'cash_lbp', amount: 100000, currency: 'lbp' }], RATE, 5000, 'lbp');
    expect(s.paid_cents).toBe(1112); expect(s.remaining_cents).toBe(0); expect(s.change_cents).toBe(62);
    expect(s.change_lbp).toBe(55000);                      // 55,490 → 55,000 (step 5,000)
    expect(s.change_usd_cents).toBe(0);
  });
  it('change in USD, card + wallet, and unpaid remainder', () => {
    expect(settle(1050, [{ tender: 'cash_usd', amount: 2000, currency: 'usd' }], RATE, 5000, 'usd').change_usd_cents).toBe(950);
    const s = settle(1050, [{ tender: 'card', amount: 500, currency: 'usd' }, { tender: 'wallet', amount: 300, currency: 'usd' }], RATE, 5000, 'usd');
    expect(s.remaining_cents).toBe(250);
    const u = settle(1050, [{ tender: 'card', amount: 500, currency: 'usd' }, { tender: 'unpaid', amount: 550, currency: 'usd' }], RATE, 5000, 'usd');
    expect(u.remaining_cents).toBe(0); expect(u.unpaid_cents).toBe(550); expect(u.paid_cents).toBe(500);
  });
  it('formats with Western digits', () => { expect(fmtBoth(1050, RATE, 'en')).toBe('$10.50 · 939,750 LBP'); });
});

describe('catalog index', () => {
  const p = (id: string, ar: string, en: string, extra: Partial<Product> = {}): Product => ({ id, tenant_id: 't', shop_id: 's', name: { ar, en }, price_usd: 1, price_currency: 'usd', price_lbp: 0, unit_kind: 'piece', decimal_qty: false, vat: false, track_stock: false, min_stock: 0, visible_online: true, is_available: true, is_active: true, on_hand: 0, reserved: 0, needs_review: false, updated_at: '', ...extra });
  it('normalises Arabic variants and digits', () => {
    expect(normalize('لَبْنَة')).toBe('لبنه'); expect(normalize('أرز')).toBe('ارز'); expect(normalize('٢٥٠')).toBe('250'); expect(normalize('  Coca   Cola ')).toBe('coca cola');
  });
  it('scans by barcode / sku and searches by any word in either language', () => {
    const idx = new CatalogIndex();
    idx.load([p('1', 'لبنة بلدية', 'Labneh baladi', { sku: 'LB-500' }), p('2', 'خبز عربي', 'Arabic bread'), p('3', 'كوكا كولا', 'Coca Cola 1.5L', { is_active: false })],
      [{ product_id: '1', shop_id: 's', barcode: '6291234567890' }], [], []);
    expect(idx.scan('6291234567890')?.id).toBe('1'); expect(idx.scan('٦٢٩١٢٣٤٥٦٧٨٩٠')?.id).toBe('1'); expect(idx.scan('lb-500')?.id).toBe('1'); expect(idx.scan('000')).toBeNull();
    expect(idx.search('لبنه').map(x => x.id)).toEqual(['1']); expect(idx.search('bread').map(x => x.id)).toEqual(['2']);
    expect(idx.search('baladi labneh').map(x => x.id)).toEqual(['1']); expect(idx.search('cola')).toHaveLength(0);   // inactive hidden
    expect(idx.search('')).toHaveLength(2);
  });
});

describe('PIN', () => {
  it('hashes with a random salt and verifies; wrong PIN fails', async () => {
    const { hash, salt } = await hashPin('1234');
    expect(await verifyPin('1234', hash, salt)).toBe(true); expect(await verifyPin('1235', hash, salt)).toBe(false);
    expect((await hashPin('1234')).salt).not.toBe(salt);
    expect(isValidPin('12a4')).toBe(false); expect(isValidPin('0042')).toBe(true);
  });
  it('offline unlock window', () => {
    const now = Date.parse('2026-11-07T00:00:00Z');
    expect(offlineUnlockAllowed('2026-10-20T00:00:00Z', 30, now)).toBe(true);
    expect(offlineUnlockAllowed('2026-09-20T00:00:00Z', 30, now)).toBe(false);
    expect(offlineUnlockAllowed(null, 30, now)).toBe(false);
  });
});
