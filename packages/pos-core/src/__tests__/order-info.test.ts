import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { addToDraft, commitSale, newDraft } from '../sale';
import { editOrderInfo, infoEditBlock, payOrder, setOrderStatus, assignDriver, type OrderInfoPatch } from '../orders';

afterEach(wipeAll);

const setup = async (fee = 200) => {
  const server = new FakeServer();
  const p = server.addProduct({ id: 'p1', price_usd: 3, on_hand: 10 });
  const a = await makeDevice(server, 'A');
  const d = { ...addToDraft(newDraft('whatsapp'), p, 2), customer_phone: '70111222', customer_name: 'Rima', fulfillment: 'delivery' as const, address: { line1: 'Old street' } };
  const o = (await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', payments: [], status: 'accepted', delivery_fee_cents: fee })).order;
  return { a, o };
};
const info = (x: Partial<OrderInfoPatch> = {}): OrderInfoPatch => ({ customer_name: 'Rima', customer_phone: '70111222', fulfillment: 'delivery', address: { line1: 'Old street' }, delivery_fee_cents: 200, notes: null, needed_at: null, ...x });

describe('editing the information of an existing order', () => {
  it('delivery → pickup drops the fee and the address, total follows, one op', async () => {
    const { a, o } = await setup();
    expect(o.total_cents).toBe(800);
    const u = await editOrderInfo(a.db, o, info({ fulfillment: 'pickup', customer_name: 'Rima K', notes: 'ring twice' }));
    expect(u.fulfillment).toBe('pickup'); expect(u.total_cents).toBe(600); expect(Number(u.delivery_fee_usd)).toBe(0); expect(u.address).toEqual({});
    expect(u.total_lbp).toBe(Math.round((600 * RATE) / 100)); expect(u.customer_name).toBe('Rima K'); expect(u.customer_notes).toBe('ring twice');
    expect((await a.db.orders.get(o.id))!.total_cents).toBe(600);
    const ops = (await a.db.outbox.toArray()).filter(x => x.kind === 'order.info');
    expect(ops).toHaveLength(1);
    expect(ops[0].payload).toMatchObject({ id: o.id, fulfillment: 'pickup', delivery_fee_cents: 0, address: {}, notify: true });
  });

  it('pickup → delivery adds the fee typed in the box; lines and discount untouched', async () => {
    const { a, o } = await setup(0);
    const p = await editOrderInfo(a.db, o, info({ fulfillment: 'pickup' }));
    const u = await editOrderInfo(a.db, p, info({ fulfillment: 'delivery', address: { line1: 'New street' }, delivery_fee_cents: 150 }), false);
    expect(u.total_cents).toBe(750); expect(u.subtotal_cents).toBe(600); expect(u.address).toEqual({ line1: 'New street' });
    expect((await a.db.orderLines.where('order_id').equals(o.id).count())).toBe(1);
  });

  it('a pickup takes the lined-up driver off the order', async () => {
    const { a, o } = await setup();
    const withDriver = await assignDriver(a.db, o, { id: 'd1', name: 'Tony' });
    const u = await editOrderInfo(a.db, withDriver, info({ fulfillment: 'pickup' }));
    expect(u.driver_id).toBeNull(); expect(u.courier_name).toBeNull();
  });

  it('a delivered, paid order: information changes, the money does not', async () => {
    const { a, o } = await setup();
    const paid = (await payOrder(a.db, o, [{ tender: 'cash_usd', amount: 800, currency: 'usd' }], RATE, 5000, 'usd', null)).order;
    expect(paid.status).toBe('delivered');
    const u = await editOrderInfo(a.db, paid, info({ fulfillment: 'pickup', customer_name: 'Rima K.', customer_phone: '70111333', delivery_fee_cents: 0 }));
    expect(u.fulfillment).toBe('pickup'); expect(u.customer_phone).toBe('70111333');
    expect(u.total_cents).toBe(800); expect(Number(u.delivery_fee_usd)).toBe(2); expect(u.paid_usd_cents).toBe(800); expect(u.status).toBe('delivered');
    const pays = await a.db.payments.where('order_id').equals(o.id).toArray();
    expect(pays.reduce((s, x) => s + x.amount, 0)).toBe(800);
  });

  it('not for cancelled orders or walk-in sales', async () => {
    const { a, o } = await setup();
    const c = await setOrderStatus(a.db, o, 'cancelled', { cancel_reason: 'x' });
    expect(infoEditBlock(c)).toBe('order_closed');
    await expect(editOrderInfo(a.db, c, info())).rejects.toThrow('order_closed');
    expect(infoEditBlock({ ...o, channel: 'walkin' })).toBe('not_an_order');
    expect(infoEditBlock({ ...o, status: 'delivered' })).toBeNull();
  });
});
