import { describe, expect, it } from 'vitest';
import { allowsDecimal, isMeasureUnit } from './units';
import { CatalogIndex } from './catalog';
import type { Product } from './types';

describe('items sold by measure take decimal quantities', () => {
  it('a bare measure is one; a pack size or a counting unit is not', () => {
    for (const u of ['kg', 'KG', ' kg ', 'g', 'l', 'L', 'ml', 'كغ', 'ليتر', 'kg.']) expect(isMeasureUnit(u)).toBe(true);
    for (const u of ['400 g', '½ kg', '1 kg', '1 L', 'tray', 'dozen', 'bag', 'pack', 'piece', '', null, undefined]) expect(isMeasureUnit(u)).toBe(false);
  });
  it('the item setting still counts, and the unit kind too', () => {
    expect(allowsDecimal({ decimal_qty: true, unit: null, unit_kind: 'piece' })).toBe(true);
    expect(allowsDecimal({ decimal_qty: false, unit: 'kg', unit_kind: 'piece' })).toBe(true);      // typed "kg" by hand, box not ticked
    expect(allowsDecimal({ decimal_qty: false, unit: null, unit_kind: 'l' })).toBe(true);
    expect(allowsDecimal({ decimal_qty: false, unit: 'tray', unit_kind: 'piece' })).toBe(false);
    expect(allowsDecimal({ decimal_qty: false, unit: '400 g', unit_kind: 'piece' })).toBe(false);
    expect(allowsDecimal(null)).toBe(false);
  });
  it('the till\'s catalogue hands such an item out as a decimal item', () => {
    const idx = new CatalogIndex(); const base = { tenant_id: 't', shop_id: 's', name: { en: 'x' }, price_usd: 1, price_currency: 'usd', price_lbp: 0, is_active: true, vat: false, track_stock: false } as unknown as Product;
    idx.load([{ ...base, id: 'a', unit: 'kg', unit_kind: 'piece', decimal_qty: false }, { ...base, id: 'b', unit: 'tray', unit_kind: 'piece', decimal_qty: false }], [], [], []);
    expect(idx.byId.get('a')!.decimal_qty).toBe(true); expect(idx.byId.get('b')!.decimal_qty).toBe(false);
    idx.upsertProduct({ ...base, id: 'c', unit: 'l', unit_kind: 'l', decimal_qty: false });
    expect(idx.byId.get('c')!.decimal_qty).toBe(true);
  });
});
