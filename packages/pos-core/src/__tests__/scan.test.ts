import { describe, expect, it } from 'vitest';
import { CatalogIndex, scaleConfigs } from '../catalog';
import { draftTotals, lineFromProduct, newDraft } from '../sale';
import type { Product } from '../types';

const P = (id: string, extra: Partial<Product> = {}): Product => ({ id, tenant_id: 't', shop_id: 's', name: { ar: id }, price_usd: 1, price_currency: 'usd', price_lbp: 0, on_hand: 10, reserved: 0, track_stock: true, is_active: true, is_available: true, visible_online: true, updated_at: '', ...extra } as Product);

describe('scanEx: pack and scale barcodes', () => {
  const idx = new CatalogIndex();
  idx.load([P('water', { sku: '00042' }), P('cheese', { price_usd: 8, sku: '7' })], [
    { product_id: 'water', shop_id: 's', barcode: '6191' },
    { product_id: 'water', shop_id: 's', barcode: '6196', pack_qty: 6, pack_price_usd: 5.4 },
  ], [], []);
  it('unit barcode', () => { expect(idx.scanEx('6191')).toMatchObject({ product: { id: 'water' }, qty: 1 }); expect(idx.scanEx('6191')!.pack).toBeUndefined(); });
  it('pack barcode → 6 units at 5.40/6', () => { const h = idx.scanEx('6196')!; expect(h.qty).toBe(6); expect(h.unit_price_cents).toBe(90); expect(h.pack?.qty).toBe(6); });
  it('scale label: prefix 2 + 5-digit code + 5-digit grams + check → kg quantity', () => {
    const h = idx.scanEx('200042012505', { prefix: '2', code_len: 5, value_kind: 'weight', value_divisor: 1000 })!;   // 2 00042 01250 5
    expect(h.product.id).toBe('water'); expect(h.qty).toBe(1.25); expect(h.scale).toBe(true);
  });
  it('scale label with embedded USD price, item matched by zero-padded sku', () => {
    const h = idx.scanEx('200007003450', { prefix: '2', code_len: 5, value_kind: 'price_usd', value_divisor: 100 })!;   // code 00007 → sku 7, 00345 → $3.45
    expect(h.product.id).toBe('cheese'); expect(h.fixed_total_cents).toBe(345);
  });
  it('unknown scale code → null; scale off → null', () => {
    expect(idx.scanEx('209999012505', { prefix: '2', code_len: 5 })).toBeNull();
    expect(idx.scanEx('200042012505', null)).toBeNull();
  });
});

describe('customer discount %', () => {
  it('applies the larger of the % and the manual discount', () => {
    const d = { ...newDraft('walkin'), lines: [lineFromProduct(P('a', { price_usd: 10 }), 2)], discount_cents: 100, discount_pct: 15 };
    expect(draftTotals(d, 89500, 5000)).toMatchObject({ subtotal_cents: 2000, discount_cents: 300, total_cents: 1700 });
    expect(draftTotals({ ...d, discount_pct: 2 }, 89500, 5000).discount_cents).toBe(100);
  });
  it('several scale formats: 27 + 3-digit code + 7-digit LL price, and 26 + 4-digit code + 6-digit price', () => {
    const idx = new CatalogIndex();
    idx.load([{ id: 'a', shop_id: 's', name: { ar: 'لحمة' }, sku: '123', price_usd: 1, price_currency: 'usd', price_lbp: 0, is_active: true, is_available: true, track_stock: true, on_hand: 0, decimal_qty: true } as any,
              { id: 'b', shop_id: 's', name: { ar: 'جبنة' }, sku: '4567', price_usd: 1, price_currency: 'usd', price_lbp: 0, is_active: true, is_available: true, track_stock: true, on_hand: 0, decimal_qty: true } as any], [], [], []);
    const cfg = scaleConfigs({ scale_prefix: '27', scale_code_len: 3, scale_value_kind: 'price_lbp', scale_value_divisor: 1, scale_formats: [{ prefix: '26', code_len: 4, value_kind: 'price_lbp', value_divisor: 1 }] });
    expect(cfg.length).toBe(2);
    const h1 = idx.scanEx('2712301850000' + '7', cfg); expect(h1?.product.id).toBe('a'); expect(h1?.fixed_total_lbp).toBe(1850000);
    const h2 = idx.scanEx('26' + '4567' + '095000' + '3', cfg); expect(h2?.product.id).toBe('b'); expect(h2?.fixed_total_lbp).toBe(95000);
  });
});
