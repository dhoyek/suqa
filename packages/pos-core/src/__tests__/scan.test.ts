import { describe, expect, it } from 'vitest';
import { CatalogIndex } from '../catalog';
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
});
