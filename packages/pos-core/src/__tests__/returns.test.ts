import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { addToDraft, commitSale, newDraft } from '../sale';
import { cashierSalesDays, commitReturn, returnDays, returnTooOld, returnedQty } from '../orders';

afterEach(wipeAll);

describe('returns from a past sale (107)', () => {
  it('what is already back is known on the till at once, per line, and adds up over several returns', async () => {
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 10, on_hand: 50 });
    const a = await makeDevice(server, 'A');
    const r = await commitSale(a.db, { draft: addToDraft(newDraft('walkin'), p, 3), rate: RATE, lbpStep: 5000, changeIn: 'usd', payments: [{ tender: 'cash_usd', amount: 3000, currency: 'usd' }] });
    const order = (await a.db.orders.get(r.order.id))!; const line = (await a.db.orderLines.where('order_id').equals(order.id).first())!;
    expect(await returnedQty(a.db, order.id)).toEqual({});
    const one = { order_item_id: line.id, product_id: 'p1', qty: 1, destination: 'stock' as const, amount_cents: 1000 };
    const how = { refund_currency: 'usd' as const, refund_usd_cents: 1000, refund_lbp: 0, reason: '', approved_by: null, user_id: 'u1' };
    await commitReturn(a.db, order, [one], how);
    expect(await returnedQty(a.db, order.id)).toEqual({ [line.id]: 1 });
    await commitReturn(a.db, order, [one], how);
    expect(await returnedQty(a.db, order.id)).toEqual({ [line.id]: 2 });
    expect(await returnedQty(a.db, 'another-order')).toEqual({});
  });
  it('the windows: 7 days until the shop says otherwise, counted from the handover', () => {
    expect(returnDays({})).toBe(7); expect(cashierSalesDays({})).toBe(7);
    expect(returnDays({ return_days: 14 })).toBe(14); expect(cashierSalesDays({ cashier_sales_days: 0 })).toBe(7); expect(returnDays({ return_days: 9999 })).toBe(365);
    const now = Date.parse('2026-11-24T12:00:00Z'); const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();
    expect(returnTooOld({}, { placed_at: ago(6.9), delivered_at: null }, now)).toBe(false);
    expect(returnTooOld({}, { placed_at: ago(7.1), delivered_at: null }, now)).toBe(true);
    expect(returnTooOld({}, { placed_at: ago(10), delivered_at: ago(2) }, now)).toBe(false);
    expect(returnTooOld({ return_days: 30 }, { placed_at: ago(20), delivered_at: null }, now)).toBe(false);
  });
});
