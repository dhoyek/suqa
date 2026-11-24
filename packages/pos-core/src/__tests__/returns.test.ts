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

import { backBlock, backTargets, setOrderStatus, stepBackOrder } from '../orders';

describe('an order moved back after a wrong tap (109)', () => {
  it('targets: every earlier stage; "new" only online; never "on the way" for a pickup; nothing for a counter sale or a cancelled order', () => {
    const o = (status: string, channel = 'whatsapp', fulfillment = 'delivery') => ({ status, channel, fulfillment, parked: false }) as never;
    expect(backTargets(o('ready'))).toEqual(['accepted', 'preparing']);
    expect(backTargets(o('delivered'))).toEqual(['accepted', 'preparing', 'ready', 'out_for_delivery']);
    expect(backTargets(o('delivered', 'whatsapp', 'pickup'))).toEqual(['accepted', 'preparing', 'ready']);
    expect(backTargets(o('accepted', 'online'))).toEqual(['pending']);
    expect(backTargets(o('accepted'))).toEqual([]);
    expect(backTargets(o('cancelled'))).toEqual([]); expect(backTargets(o('pending', 'online'))).toEqual([]);
    expect(backTargets(o('delivered', 'walkin'))).toEqual([]);
  });
  it('goes back on the till and on the server; a delivered order with money on it is refused until the payment is gone', async () => {
    const server = new FakeServer();
    const p = server.addProduct({ id: 'p1', price_usd: 10, on_hand: 50 });
    const a = await makeDevice(server, 'A');
    const r = await commitSale(a.db, { draft: addToDraft(newDraft('whatsapp'), p, 1), rate: RATE, lbpStep: 5000, changeIn: 'usd', status: 'accepted', payments: [] });
    let o = await setOrderStatus(a.db, r.order, 'ready');
    o = await stepBackOrder(a.db, o, 'preparing', 'u1');
    expect(o.status).toBe('preparing');
    await expect(stepBackOrder(a.db, o, 'ready', 'u1')).rejects.toThrow('not_a_step_back');
    await a.engine.sync();
    expect(server.orders.get(o.id)!.status).toBe('preparing');
    expect((await a.db.orders.get(o.id))!.status).toBe('preparing');
    // delivered with nothing paid: reopened, its closing times cleared
    o = await setOrderStatus(a.db, (await a.db.orders.get(o.id))!, 'delivered');
    expect(await backBlock(a.db, o)).toBeNull();
    o = await stepBackOrder(a.db, o, 'ready', 'u1');
    expect(o.status).toBe('ready'); expect(o.delivered_at ?? null).toBeNull(); expect(o.closed_at ?? null).toBeNull();
    // delivered and paid: refused; with the payment reversed: allowed
    o = await setOrderStatus(a.db, o, 'delivered');
    await a.db.payments.put({ id: 'pay1', order_id: o.id, tender: 'cash_usd', amount: 1000, currency: 'usd', at: new Date().toISOString() } as never);
    expect(await backBlock(a.db, o)).toBe('has_payments');
    await expect(stepBackOrder(a.db, o, 'ready', 'u1')).rejects.toThrow('has_payments');
    expect((await a.db.orders.get(o.id))!.status).toBe('delivered');
    await a.db.payments.put({ id: 'pay2', order_id: o.id, tender: 'cash_usd', amount: -1000, currency: 'usd', at: new Date().toISOString() } as never);
    expect(await backBlock(a.db, o)).toBeNull();
  });
});

import { intlPhone } from '../customers';
import { upsertDriver } from '../drivers';
describe('a phone typed without a country code gets +961', () => {
  it('prefixes local numbers, keeps coded ones', () => {
    expect(intlPhone('03 123 456')).toBe('+9613123456');
    expect(intlPhone('3123456')).toBe('+9613123456');
    expect(intlPhone('70 123 456')).toBe('+96170123456');
    expect(intlPhone('070123456')).toBe('+96170123456');
    expect(intlPhone('+961 70 123 456')).toBe('+96170123456');
    expect(intlPhone('0096170123456')).toBe('+96170123456');
    expect(intlPhone('96170123456')).toBe('+96170123456');
    expect(intlPhone('9613123456')).toBe('+9613123456');
    expect(intlPhone('+961 03 123 456')).toBe('+9613123456');
    expect(intlPhone('961 03 123 456')).toBe('+9613123456');
    expect(intlPhone('+33 6 12 34 56 78')).toBe('+33612345678');
    expect(intlPhone('0033612345678')).toBe('+33612345678');
    expect(intlPhone('')).toBe(''); expect(intlPhone(null)).toBe('');
  });
  it('a driver saved from the till is stored with the country code, and is still the same driver', async () => {
    const server = new FakeServer(); const a = await makeDevice(server, 'A');
    const d1 = await upsertDriver(a.db, 's1', { name: 'Driver', phone: '03 123 456' });
    expect(d1.phone).toBe('+9613123456');
    const d2 = await upsertDriver(a.db, 's1', { name: 'Driver', phone: '+961 3 123 456' });
    expect(d2.id).toBe(d1.id); expect(await a.db.drivers.count()).toBe(1);
  });
});
