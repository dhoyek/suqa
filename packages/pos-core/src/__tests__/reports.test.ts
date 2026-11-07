import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { addToDraft, commitSale, newDraft } from '../sale';
import { dayKey, localReport } from '../reports';

afterEach(wipeAll);

describe('local period report (offline fallback)', () => {
  it('totals, by item/section, slow movers and stock value from the mirror', async () => {
    const server = new FakeServer();
    const p1 = server.addProduct({ id: 'p1', price_usd: 10, on_hand: 50, cost_cents: 600, section: 'A', track_stock: true, min_stock: 5 });
    const p2 = server.addProduct({ id: 'p2', price_usd: 4, on_hand: 3, cost_cents: 100, section: 'B', track_stock: true, min_stock: 5 });
    const a = await makeDevice(server, 'A');
    let d = addToDraft(newDraft('walkin'), p1, 2);
    await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', shift_id: null, payments: [{ tender: 'cash_usd', amount: 2000, currency: 'usd' }] });
    d = addToDraft(newDraft('whatsapp'), p1, 1);
    await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', shift_id: null, payments: [{ tender: 'unpaid', amount: 1000, currency: 'usd', unpaid_name: 'Abou Elie', unpaid_phone: '70000000' }] });
    const today = dayKey(new Date());
    const r = await localReport(a.db, today, today);
    expect(r.partial).toBe(true);
    expect(r.totals.sales_count).toBe(2); expect(r.totals.total_cents).toBe(3000); expect(r.totals.items_count).toBe(3); expect(r.totals.cost_cents).toBe(1800);
    expect(r.by_day).toEqual([{ day: today, count: 2, cents: 3000 }]);
    expect(r.by_channel.walkin?.cents).toBe(2000); expect(r.by_channel.whatsapp?.count).toBe(1);
    expect(r.by_item[0]).toMatchObject({ product_id: 'p1', qty: 3, cents: 3000, cost_cents: 1800 });
    expect(r.by_section).toEqual([{ section: 'A', qty: 3, cents: 3000 }]);
    expect(r.slow.map(s => s.product_id)).toEqual(['p2']);
    expect(r.stock).toMatchObject({ skus: 2, units: 50, low: 1 });                     // 47 + 3 on hand after the sales
    expect(r.unpaid).toHaveLength(1); expect(r.unpaid[0].name).toBe('Abou Elie');
    // yesterday: empty
    const y = new Date(); y.setDate(y.getDate() - 1);
    expect((await localReport(a.db, dayKey(y), dayKey(y))).totals.sales_count).toBe(0);
  });
});
