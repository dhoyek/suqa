import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../sync/fake-server';
import { makeDevice, wipeAll, RATE } from './helpers';
import { addToDraft, commitSale, newDraft } from '../sale';
import { setOrderStatus } from '../orders';
import { openShift, shiftSummary } from '../shift';
import { driverPayFor, driverPayRule, payDriver, setOrderDriverPay, upsertDriver } from '../drivers';
import { META, setMeta, getMeta } from '../db';
import type { Shop } from '../types';

afterEach(wipeAll);

describe('driver pay', () => {
  it('the shop default applies to every driver and a driver can have his own rule', () => {
    const shop = { driver_pay_mode: 'per_delivery' as const, driver_pay_cents: 150 };
    expect(driverPayRule(shop, {})).toEqual({ mode: 'per_delivery', cents: 150, own: false });
    expect(driverPayFor(shop, { pay_mode: null }, { delivery_fee_usd: 2 })).toBe(150);
    expect(driverPayFor(shop, { pay_mode: 'none' }, { delivery_fee_usd: 2 })).toBe(0);                       // on the payroll
    expect(driverPayFor(shop, { pay_mode: 'delivery_fee' }, { delivery_fee_usd: 2 })).toBe(200);             // takes the delivery fee
    expect(driverPayFor(shop, { pay_mode: 'per_delivery', pay_cents: 300 }, { delivery_fee_usd: 2 })).toBe(300);
    expect(driverPayFor({}, {}, { delivery_fee_usd: 2 })).toBe(0);                                             // nothing set → nothing per order
  });

  it('a delivery earns the driver once: fixed at delivery, settled by one payout, cash leaves the drawer once', async () => {
    const server = new FakeServer(); const p = server.addProduct({ id: 'p1', price_usd: 10, on_hand: 10 });
    const a = await makeDevice(server, 'A');
    const shop = (await getMeta<Shop>(a.db, META.shop))!;
    await setMeta(a.db, META.shop, { ...shop, driver_pay_mode: 'per_delivery', driver_pay_cents: 150 });
    const sh = await openShift(a.db, { float_usd_cents: 10000, float_lbp: 0, opened_by: 'u1' });
    const drv = await upsertDriver(a.db, server.shop.id, { name: 'Joe', phone: '70 111 222' });
    const d = { ...addToDraft(newDraft('phone'), p, 1), customer_phone: '70000000', customer_name: 'x', fulfillment: 'delivery' as const };
    const r = await commitSale(a.db, { draft: d, rate: RATE, lbpStep: 5000, changeIn: 'usd', payments: [{ tender: 'cash_usd', amount: 1000, currency: 'usd' }], status: 'accepted', shift_id: sh.id });

    const out = await setOrderStatus(a.db, r.order, 'out_for_delivery', { driver_id: drv.id, courier_name: drv.name });
    expect(out.courier_fee_cents ?? 0).toBe(0);                                  // nothing earned before delivery
    const done = await setOrderStatus(a.db, out, 'delivered');
    expect(done.courier_fee_cents).toBe(150);
    expect(done.driver_paid_at ?? null).toBeNull();

    await setOrderDriverPay(a.db, done.id, 200);                                 // owner adjusts this one delivery
    const row = (await a.db.orders.get(done.id))!;
    const pay = await payDriver(a.db, { driver: drv, orders: [row], currency: 'usd', amount: 200, rate: RATE, from_drawer: true, shift: sh, user_id: 'u1' });
    expect(pay?.amount_cents).toBe(200);
    const paid = (await a.db.orders.get(done.id))!;
    expect(paid.driver_paid_at).toBeTruthy(); expect(paid.driver_payout_id).toBe(pay!.id);
    await expect(setOrderDriverPay(a.db, done.id, 500)).rejects.toThrow('already_settled');

    const sum = await shiftSummary(a.db, sh);
    expect(sum.expected_usd_cents).toBe(10000 + 1000 - 200);                     // sale in once, driver pay out once
    const kinds = (await a.db.outbox.toArray()).map(o => o.kind);
    expect(kinds.filter(k => k === 'driver.payout').length).toBe(1);
  });
});
