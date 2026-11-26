import { describe, expect, it } from 'vitest';
import { toolsFor, type ToolCtx } from './tools';

const SHOP = '11111111-1111-4111-8111-111111111111'; const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tool = (role: ToolCtx['role'], name: string) => toolsFor('seller', role).find(t => t.name === name);
const ctx = (role: ToolCtx['role'], rpc: ToolCtx['sb']['rpc']): ToolCtx => ({ sb: { rpc }, tenantId: 't', mode: 'seller', shopId: SHOP, role });

describe('what to order and stock count in the till', () => {
  it('are for the owner and the stock keeper only', () => {
    for (const n of ['order_suggest', 'draft_count']) {
      expect(tool('owner', n)).toBeTruthy(); expect(tool('stock', n)).toBeTruthy();
      expect(tool('cashier', n)).toBeUndefined(); expect(tool('setup', n)).toBeUndefined();
      expect(toolsFor('shopper', null).some(t => t.name === n)).toBe(false);
    }
  });

  it('draft_count keeps real ids with a sane count (0 allowed), one line per item, and changes nothing', async () => {
    const r = await tool('stock', 'draft_count')!.run({ lines: [{ product_id: A.toUpperCase(), counted: 12 }, { product_id: A, counted: 99 }, { product_id: B, counted: 0 }, { product_id: 'made-up', counted: 3 }, { product_id: B.replace('b', 'c'), counted: -2 }], not_found: ['labne zghire'] }, ctx('stock', async () => ({ data: null, error: null }))) as { draft: unknown; nothing_changed_until_they_confirm: boolean };
    expect(r.draft).toEqual({ lines: [{ product_id: A, counted: 12 }, { product_id: B, counted: 0 }], not_found: ['labne zghire'] });
    expect(r.nothing_changed_until_they_confirm).toBe(true);
    await expect(tool('owner', 'draft_count')!.run({ lines: [] }, ctx('owner', async () => ({ data: null, error: null })))).rejects.toThrow('empty_count');
  });

  it('order_suggest groups by supplier, can keep one supplier, carries quantities only, and says when the function is missing', async () => {
    const rows = [
      { id: A, name: { ar: 'بيبسي' }, unit: null, sold: 28, free: 2, suggest: 12, supplier: 'PEPSI', supplier_id: 's1', min_stock: 0 },
      { id: B, name: { ar: 'لبنة' }, unit: 'kg', sold: 2.1, free: 0.5, suggest: 0.55, supplier: null, supplier_id: null, min_stock: 0 } ];
    let args: Record<string, unknown> = {};
    const rpc: ToolCtx['sb']['rpc'] = async (fn, a) => { args = a; return fn === 'pos_order_suggest' ? { data: { days: 14, cover: 7, rows }, error: null } : { data: null, error: { message: 'unexpected' } }; };
    const all = await tool('owner', 'order_suggest')!.run({ days: 500 }, ctx('owner', rpc)) as { items_total: number; suppliers: { supplier: string; lines: Record<string, unknown>[] }[] };
    expect(args).toEqual({ p_shop: SHOP, p_days: 90, p_cover: 7 });
    expect(all.items_total).toBe(2); expect(all.suppliers.map(s => s.supplier)).toEqual(['PEPSI', '(no supplier set on these items)']);
    expect(all.suppliers[0].lines[0]).toEqual({ name_ar: 'بيبسي', name_en: null, order: 12, unit: null, sold: 28, on_shelf: 2 });
    expect(JSON.stringify(all)).not.toMatch(/cost|price|cents|margin/);
    const one = await tool('stock', 'order_suggest')!.run({ supplier: 'pep' }, ctx('stock', rpc)) as { suppliers: unknown[]; items_total: number };
    expect(one.suppliers).toHaveLength(1); expect(one.items_total).toBe(1);
    const off = await tool('owner', 'order_suggest')!.run({}, ctx('owner', async () => ({ data: null, error: { message: 'Could not find the function suqa.pos_order_suggest in the schema cache' } })));
    expect(off).toHaveProperty('unavailable');
  });
});
