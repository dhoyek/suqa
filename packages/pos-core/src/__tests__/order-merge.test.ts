import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { addToDraft, commitSale, newDraft } from '../sale';
import { mergeBlock, mergeOrders } from '../orders';

afterEach(wipeAll);

const order = async (a: Awaited<ReturnType<typeof makeDevice>>, p: Parameters<typeof addToDraft>[1], qty: number, phone: string, fee: number, fulfillment: 'delivery' | 'pickup' = 'delivery') => {
  const d = { ...addToDraft(newDraft('phone'), p, qty), customer_phone: phone, customer_name: 'x', fulfillment };
  return (await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', payments: [], status: 'accepted', delivery_fee_cents: fee })).order;
};

describe('merging two open orders of one customer', () => {
  it('moves the lines, charges delivery once, closes the other as merged, in one op', async () => {
    const server = new FakeServer();
    const p1 = server.addProduct({ id: 'p1', price_usd: 2, on_hand: 10 });
    const p2 = server.addProduct({ id: 'p2', price_usd: 5, on_hand: 10 });
    const a = await makeDevice(server, 'A');
    const o1 = await order(a, p1, 1, '70 483 148', 300);
    const o2 = await order(a, p2, 2, '+96170483148', 300);          // same person, typed differently
    expect(o1.total_cents).toBe(500); expect(o2.total_cents).toBe(1300);

    const m = await mergeOrders(a.db, o1, o2);
    expect(m.id).toBe(o1.id);
    expect(m.subtotal_cents).toBe(1200);
    expect(m.total_cents).toBe(1500);                                 // 2 + 10 + ONE delivery fee of 3
    const lines = await a.db.orderLines.where('order_id').equals(o1.id).toArray();
    expect(lines.map(l => l.product_id).sort()).toEqual(['p1', 'p2']);
    const src = (await a.db.orders.get(o2.id))!;
    expect(src.status).toBe('cancelled');
    expect(src.cancel_reason).toContain(o1.number ?? o1.local_number ?? '');
    expect(src.notify_customer).toBe(false);
    const ops = (await a.db.outbox.toArray()).filter(x => x.kind === 'order.merge');
    expect(ops).toHaveLength(1);
    const pl = ops[0].payload as { id: string; from: string; map: Record<string, string> };
    expect(pl.id).toBe(o1.id); expect(pl.from).toBe(o2.id);
    expect(Object.values(pl.map)).toEqual(lines.filter(l => l.product_id === 'p2').map(l => l.id));
  });

  it('refuses another customer, another fulfilment, a paid order and a closed one', async () => {
    const server = new FakeServer();
    const p1 = server.addProduct({ id: 'p1', price_usd: 2, on_hand: 10 });
    const a = await makeDevice(server, 'A');
    const o1 = await order(a, p1, 1, '70483148', 300);
    const other = await order(a, p1, 1, '03123456', 300);
    const pickup = await order(a, p1, 1, '70483148', 0, 'pickup');
    const same = await order(a, p1, 1, '70483148', 300);
    expect(mergeBlock(o1, other, 0)).toBe('different_customer');
    expect(mergeBlock(o1, pickup, 0)).toBe('different_fulfillment');
    expect(mergeBlock(o1, same, 1)).toBe('source_has_payments');
    expect(mergeBlock(o1, { ...same, status: 'out_for_delivery' }, 0)).toBe('order_closed');
    expect(mergeBlock(o1, o1, 0)).toBe('same_order');
    expect(mergeBlock(o1, same, 0)).toBeNull();
    await expect(mergeOrders(a.db, o1, other)).rejects.toThrow('different_customer');
  });
});
