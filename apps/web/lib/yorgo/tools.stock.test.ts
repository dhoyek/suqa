import { describe, expect, it } from 'vitest';
import { toolsFor, type ToolCtx } from './tools';

const SHOP = '11111111-1111-4111-8111-111111111111';
function ctx(role: ToolCtx['role'], over: Partial<{ rpc: ToolCtx['sb']['rpc']; rows: unknown[] }> = {}): ToolCtx {
  const calls: unknown[] = [];
  const from = (t: string) => { const q: Record<string, unknown> = { t, filters: [] as unknown[] };
    const api = { select: (c: string) => { q.cols = c; return api; }, eq: (k: string, v: unknown) => { (q.filters as unknown[]).push([k, v]); return api; }, in: (k: string, v: unknown) => { (q.filters as unknown[]).push([k, v]); calls.push(q); return Promise.resolve({ data: over.rows ?? [], error: null }); } };
    return api; };
  const rpc: ToolCtx['sb']['rpc'] = over.rpc ?? (async (fn) => fn === 'match_items'
    ? { data: [{ phrase_no: 1, product_id: 'p1', score: 0.91 }, { phrase_no: 1, product_id: 'p2', score: 0.5 }, { phrase_no: 1, product_id: 'other-shop', score: 0.4 }], error: null }
    : { data: null, error: { message: 'unexpected ' + fn } });
  return Object.assign({ sb: { rpc, from }, tenantId: 't', mode: 'seller' as const, shopId: SHOP, role }, { calls }) as ToolCtx;
}
const tool = (role: ToolCtx['role'], name: string) => toolsFor('seller', role).find(t => t.name === name);

describe('stock tools in the till', () => {
  it('are for the owner, the stock keeper and the cashier — not the association, not a customer', () => {
    for (const r of ['owner', 'stock', 'cashier'] as const) { expect(tool(r, 'stock_of')).toBeTruthy(); expect(tool(r, 'stock_watch')).toBeTruthy(); }
    expect(tool('setup', 'stock_of')).toBeUndefined(); expect(tool('setup', 'stock_watch')).toBeUndefined();
    expect(toolsFor('shopper', null).some(t => t.name.startsWith('stock_'))).toBe(false);
  });

  it('stock_of answers with quantities of the shop\'s own items only: free = on hand minus held; untracked has no number; no money fields', async () => {
    const c = ctx('cashier', { rows: [
      { id: 'p1', name: { ar: 'بيبسي', en: 'Pepsi' }, unit: null, on_hand: '34.000', reserved: '4.000', track_stock: true },
      { id: 'p2', name: { ar: 'خبز' }, unit: 'kg', on_hand: 0, reserved: 0, track_stock: false } ] });
    const r = await tool('cashier', 'stock_of')!.run({ phrases: ['pepsi'] }, c) as { phrase: string; items: Record<string, unknown>[] }[];
    expect(r[0].items).toEqual([
      { name_ar: 'بيبسي', name_en: 'Pepsi', unit: null, tracked: true, on_hand: 34, held_for_orders: 4, free: 30, score: 0.91 },
      { name_ar: 'خبز', name_en: null, unit: 'kg', tracked: false, score: 0.5 } ]);              // the item of another shop is not there: it was not read
    const q = (c as unknown as { calls: { cols: string; filters: unknown[] }[] }).calls[0];
    expect(q.cols).toBe('id,name,unit,on_hand,reserved,track_stock,is_active'); expect(q.filters[0]).toEqual(['shop_id', SHOP]);
    expect(JSON.stringify(r)).not.toMatch(/cost|price|supplier|margin/);
  });

  it('stock_watch returns only the lists asked for, trimmed, and keeps "stale" for owner and stock keeper', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: 'x' + i, name: { ar: 'صنف ' + i }, unit: null, on_hand: 0 }));
    const rpc: ToolCtx['sb']['rpc'] = async (fn, args) => fn === 'pos_stock_watch'
      ? { data: { expiry_days: (args as { p_expiry_days: number }).p_expiry_days, counts: { out: 40, low: 1, expiring: 2 }, out: many, low: [{ id: 'l', name: { ar: 'لبنة' }, unit: 'kg', on_hand: 1.5, min_stock: 5 }], expiring: [] }, error: null }
      : fn === 'pos_report_stale' ? { data: { days: 60, count: 1, rows: [{ name: { ar: 'قديم' }, last_sold_at: null, on_hand: 3, track_stock: true, visible_online: true, listed_empty: false }] }, error: null }
      : { data: null, error: { message: 'unexpected' } };
    const r = await tool('owner', 'stock_watch')!.run({ lists: ['out', 'low', 'stale'], expiry_days: 9999 }, ctx('owner', { rpc })) as Record<string, { total: number; shown: number; items: unknown[] }>;
    expect(Object.keys(r).sort()).toEqual(['low', 'out', 'stale']);
    expect(r.out).toMatchObject({ total: 40, shown: 25 }); expect(r.out.items).toHaveLength(25);
    expect(r.low.items[0]).toEqual({ name_ar: 'لبنة', name_en: null, unit: 'kg', on_hand: 1.5, minimum: 5 });
    expect(r.stale).toMatchObject({ not_sold_for_days: 60, total: 1 }); expect(r.stale.items[0]).toEqual({ name_ar: 'قديم', name_en: null, last_sold: 'never', on_hand: 3 });
    const c = await tool('cashier', 'stock_watch')!.run({ lists: ['stale'] }, ctx('cashier', { rpc })) as Record<string, unknown>;
    expect(c.stale).toEqual({ not_for_this_role: true });
  });

  it('stock_watch says so when the database part is not applied yet, instead of failing', async () => {
    const rpc: ToolCtx['sb']['rpc'] = async () => ({ data: null, error: { message: 'Could not find the function suqa.pos_stock_watch in the schema cache' } });
    expect(await tool('stock', 'stock_watch')!.run({ lists: ['low'] }, ctx('stock', { rpc }))).toEqual({ unavailable: 'The stock lists are not switched on for this shop yet.' });
  });
});
