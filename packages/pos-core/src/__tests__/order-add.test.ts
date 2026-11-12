import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { addToDraft, commitSale, newDraft } from '../sale';
import { editOrder } from '../orders';

afterEach(wipeAll);

describe('adding a cart to an open order', () => {
  it('the added line keeps its note, changed price and discount, and the order total follows', async () => {
    const server = new FakeServer();
    const p1 = server.addProduct({ id: 'p1', price_usd: 2, on_hand: 10 });
    const p2 = server.addProduct({ id: 'p2', price_usd: 5, on_hand: 10 });
    const a = await makeDevice(server, 'A');
    const d = { ...addToDraft(newDraft('phone'), p1, 1), customer_phone: '70000000', customer_name: 'x' };
    const r = await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', payments: [], status: 'accepted' });
    expect(r.order.total_cents).toBe(200);

    const o = await editOrder(a.db, r.order, [{ product: p2, new_qty: 2, notes: ' بدون ملح ', unit_price_cents: 450, discount_cents: 100 }]);
    const added = (await a.db.orderLines.where('order_id').equals(o.id).toArray()).find(l => l.product_id === 'p2')!;
    expect(added.notes).toBe('بدون ملح');
    expect(added.unit_price_cents).toBe(450);
    expect(added.discount_cents).toBe(100);
    expect(added.line_total_cents).toBe(800);          // 2 × 4.50 − 1.00
    expect(o.total_cents).toBe(1000);
    const op = (await a.db.outbox.toArray()).find(x => x.kind === 'order.edit')!;
    expect((op.payload as { lines: Record<string, unknown>[] }).lines[0]).toMatchObject({ notes: 'بدون ملح', discount_cents: 100, line_total_cents: 800 });
  });
});
