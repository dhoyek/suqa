import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { addToDraft, commitSale, newDraft, newId } from '../sale';
import { payDriver, setOrderDriverCash } from '../drivers';
import { openShift, shiftSummary } from '../shift';

afterEach(wipeAll);

/** An order the driver closed from his page, as the till receives it from the server: delivered, with a 'driver' payment. */
const driverClosed = async (a: Awaited<ReturnType<typeof makeDevice>>, p: Parameters<typeof addToDraft>[1], pay = 100) => {
  const d = { ...addToDraft(newDraft('whatsapp'), p, 2), customer_phone: '70111222', customer_name: 'x', fulfillment: 'delivery' as const };
  const o = (await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', payments: [], status: 'accepted', delivery_fee_cents: 200 })).order;
  const closed = { ...o, status: 'delivered' as const, driver_id: 'd1', courier_fee_cents: pay, paid_usd_cents: o.total_cents, shift_id: null };
  await a.db.orders.put(closed);
  await a.db.payments.put({ id: newId(), order_id: o.id, tender: 'driver', amount: o.total_cents, currency: 'usd', at: new Date().toISOString() });
  return closed;
};

describe('cash collected by the driver', () => {
  it('is not drawer cash until the settlement, which moves the drawer once by the net', async () => {
    const server = new FakeServer(); const p = server.addProduct({ id: 'p1', price_usd: 3, on_hand: 10 });
    const a = await makeDevice(server, 'A');
    const shift = await openShift(a.db, { float_usd_cents: 1000, float_lbp: 0, opened_by: 'u1' });
    const o1 = await driverClosed(a, p), o2 = await driverClosed(a, p);          // 2 × $8.00 with him, $1.00 pay each
    let s = await shiftSummary(a.db, shift);
    expect(s.expected_usd_cents).toBe(1000);                                       // nothing of it is in the drawer

    const r = await payDriver(a.db, { driver: { id: 'd1', name: 'Tony' }, orders: [o1, o2], cash_orders: [{ id: o1.id, usd_cents: 800, lbp: 0 }, { id: o2.id, usd_cents: 300, lbp: 450000 }],
      currency: 'usd', amount: 200, rate: RATE, from_drawer: true, shift, user_id: 'u1' });
    expect(r).toMatchObject({ amount_cents: 200, cash_cents: 1100, cash_lbp: 450000 });
    s = await shiftSummary(a.db, shift);
    expect(s.expected_usd_cents).toBe(1900);                                       // + 11.00 in − 2.00 pay: one dollar movement
    expect(s.expected_lbp).toBe(450000);                                            // the lira as he held it
    expect(s.moves.filter(m => m.kind === 'in')).toHaveLength(2); expect(s.moves.filter(m => m.kind === 'out')).toHaveLength(0);
    const pays = await a.db.payments.where('tender').equals('driver').toArray();
    expect(pays.every(x => x.settled_at && x.reference === r!.id)).toBe(true);
    const op = (await a.db.outbox.toArray()).find(x => x.kind === 'driver.payout')!;
    expect(op.payload).toMatchObject({ order_ids: [o1.id, o2.id], cash_order_ids: [o1.id, o2.id], amount: 200 });
  });

  it('the owner corrects an amount: local payment and order follow, one op', async () => {
    const server = new FakeServer(); const p = server.addProduct({ id: 'p1', price_usd: 3, on_hand: 10 });
    const a = await makeDevice(server, 'A');
    const o = await driverClosed(a, p);
    await setOrderDriverCash(a.db, o.id, 500, 0);
    expect((await a.db.payments.where('order_id').equals(o.id).toArray())[0].amount).toBe(500);
    expect((await a.db.orders.get(o.id))!.paid_usd_cents).toBe(500);
    expect((await a.db.outbox.toArray()).filter(x => x.kind === 'order.driver_cash')).toHaveLength(1);
  });
});
