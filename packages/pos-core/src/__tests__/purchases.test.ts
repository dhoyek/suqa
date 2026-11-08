import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { openShift, shiftSummary } from '../shift';
import { commitPurchase, paySupplier, purchaseTotals, supplierStatement, upsertSupplier, voidPurchase } from '../purchases';

afterEach(wipeAll);

describe('suppliers & purchases', () => {
  it('receives stock at cost, sets price, tracks balance, pays from the drawer, voids', async () => {
    const server = new FakeServer(); const p = server.addProduct({ id: 'p1', price_usd: 2, on_hand: 5, track_stock: true, cost_cents: 100 });
    const a = await makeDevice(server, 'A');
    const sh = await openShift(a.db, { float_usd_cents: 10000, float_lbp: 0, opened_by: 'u1' });
    const sup = await upsertSupplier(a.db, server.shop.id, { name: 'Sanabel Trading', phone: '03 111 222' });
    const prod = (await a.db.products.get('p1'))!;
    const t = purchaseTotals([{ product: prod, qty: 10, unit_cost: 1.5 }], 'usd', RATE, 1);
    expect(t).toMatchObject({ subtotal: 15, total: 14, total_cents: 1400 });
    const pur = await commitPurchase(a.db, { supplier: sup, lines: [{ product: prod, qty: 10, unit_cost: 1.5, new_price_usd: 2.5 }], currency: 'usd', rate: RATE, discount: 1, invoice_no: 'INV-1', user_id: 'u1' });
    const after = (await a.db.products.get('p1'))!;
    expect(Number(after.on_hand)).toBe(15); expect(after.cost_cents).toBe(150); expect(Number(after.price_usd)).toBe(2.5);
    expect((await a.db.suppliers.get(sup.id))!.balance_cents).toBe(1400);
    // LBP purchase
    const pur2 = await commitPurchase(a.db, { supplier: sup, lines: [{ product: prod, qty: 2, unit_cost: 89500 }], currency: 'lbp', rate: RATE, user_id: 'u1' });
    expect(pur2.total_cents).toBe(200); expect((await a.db.suppliers.get(sup.id))!.balance_cents).toBe(1600);
    await paySupplier(a.db, { supplier: sup, tender: 'cash_usd', currency: 'usd', amount: 1000, rate: RATE, from_drawer: true, shift: sh, user_id: 'u1' });
    expect((await a.db.suppliers.get(sup.id))!.balance_cents).toBe(600);
    expect((await shiftSummary(a.db, sh)).out_usd).toBe(1000);
    await voidPurchase(a.db, pur, 'wrong invoice', 'u1', null);
    expect(Number((await a.db.products.get('p1'))!.on_hand)).toBe(7); expect((await a.db.suppliers.get(sup.id))!.balance_cents).toBe(-800);
    const st = await supplierStatement(a.db, (await a.db.suppliers.get(sup.id))!);
    expect(st.map(x => x.kind)).toEqual(['payment', 'purchase', 'void']); expect(st[0].balance_cents).toBe(-800);
    await a.engine.sync(); expect(a.engine.status.rejected).toBe(0); expect(a.engine.status.pending).toBe(0);
  });
});
