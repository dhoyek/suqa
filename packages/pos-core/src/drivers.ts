import type { PosDb } from './db';
import { normPhone } from './customers';
import { enqueue, newId } from './sale';
import type { Currency, Driver, DriverPayMode, Order, Shift, Shop } from './types';
import { getMeta, META } from './db';
import { cashMove } from './shift';
import { num } from './types';

/** Drivers the shop can send out right now: active and available, most recently used first. */
export async function availableDrivers(db: PosDb): Promise<Driver[]> {
  return (await db.drivers.toArray()).filter(d => d.active && d.available).sort((a, b) => (b.last_used_at ?? '').localeCompare(a.last_used_at ?? '') || a.name.localeCompare(b.name));
}

export async function upsertDriver(db: PosDb, shopId: string, input: { id?: string; name: string; phone: string; vehicle?: string | null; active?: boolean; available?: boolean; notes?: string | null }): Promise<Driver> {
  const key = normPhone(input.phone); if (key.length < 6) throw new Error('bad_phone');
  if (!input.name.trim()) throw new Error('bad_name');
  const existing = input.id ? await db.drivers.get(input.id) : await db.drivers.where('phone_key').equals(key).first();
  const row: Driver = { id: existing?.id ?? newId(), shop_id: shopId, name: input.name.trim(), phone: input.phone.trim(), phone_key: key, vehicle: input.vehicle ?? existing?.vehicle ?? null,
    active: input.active ?? existing?.active ?? true, available: input.available ?? existing?.available ?? true, notes: input.notes ?? existing?.notes ?? null, user_id: existing?.user_id ?? null,
    last_used_at: existing?.last_used_at ?? null, updated_at: new Date().toISOString() };
  await db.transaction('rw', [db.drivers, db.outbox], async () => {
    await db.drivers.put(row);
    await enqueue(db, 'driver.upsert', { id: row.id, name: row.name, phone: row.phone, vehicle: row.vehicle, notes: row.notes, ...(input.active !== undefined ? { active: row.active } : {}), ...(input.available !== undefined ? { available: row.available } : {}) });
  });
  return row;
}

/** International digits for wa.me / tel: links. */
export const waDigits = (p: string) => { const k = (p ?? '').replace(/\D/g, '').replace(/^00/, ''); return k.startsWith('961') ? k : '961' + k.replace(/^0/, ''); };

/** Remove a driver from the shop. Deleted outright if never assigned to an order (server decides; the feed then drops the
 *  row), otherwise kept inactive so old orders still show who delivered them. Locally we mark inactive at once. */
export async function deleteDriver(db: PosDb, id: string, opts: { approved_by?: string } = {}): Promise<void> {
  const d = await db.drivers.get(id); if (!d) return;
  const used = await db.orders.filter(o => (o as { driver_id?: string | null }).driver_id === id).count().catch(() => 0);
  if (used) await db.drivers.update(id, { active: false, available: false, updated_at: new Date().toISOString() });
  else await db.drivers.delete(id);
  await enqueue(db, 'driver.delete', { id, ...(opts.approved_by ? { approved_by: opts.approved_by } : {}) });
}

// ---- driver pay (schema 60) ------------------------------------------------------------------------------------------
/** The rule in force for a driver: his own when he has one, otherwise the shop default. */
export function driverPayRule(shop: Pick<Shop, 'driver_pay_mode' | 'driver_pay_cents'> | null | undefined, driver: Pick<Driver, 'pay_mode' | 'pay_cents'> | null | undefined): { mode: DriverPayMode; cents: number; own: boolean } {
  if (driver?.pay_mode) return { mode: driver.pay_mode, cents: driver.pay_mode === 'per_delivery' ? num(driver.pay_cents) : 0, own: true };
  const mode = shop?.driver_pay_mode ?? 'none';
  return { mode, cents: mode === 'per_delivery' ? num(shop?.driver_pay_cents) : 0, own: false };
}
/** What one delivery earns the driver, USD cents (same arithmetic as suqa.driver_pay_for). */
export function driverPayFor(shop: Pick<Shop, 'driver_pay_mode' | 'driver_pay_cents'> | null | undefined, driver: Pick<Driver, 'pay_mode' | 'pay_cents'> | null | undefined, order: Pick<Order, 'delivery_fee_usd'>): number {
  const r = driverPayRule(shop, driver);
  return r.mode === 'per_delivery' ? r.cents : r.mode === 'delivery_fee' ? Math.max(0, Math.round(num(order.delivery_fee_usd) * 100)) : 0;
}
/** For an order of this device's shop (reads the shop row and the driver from the local database). 0 when it has no shop driver. */
export async function driverPayOf(db: PosDb, order: Pick<Order, 'driver_id' | 'delivery_fee_usd'>): Promise<number> {
  if (!order.driver_id) return 0;
  const [shop, driver] = await Promise.all([getMeta<Shop>(db, META.shop), db.drivers.get(order.driver_id)]);
  return driver ? driverPayFor(shop, driver, order) : 0;
}

/** Owner changes what one delivery earns (only while it is not settled). The order may be too old to be on this till: the op still goes out. */
export async function setOrderDriverPay(db: PosDb, orderId: string, cents: number): Promise<void> {
  const row = await db.orders.get(orderId);
  if (row?.driver_paid_at) throw new Error('already_settled');
  const v = Math.max(0, Math.round(cents));
  await db.transaction('rw', [db.orders, db.outbox], async () => {
    if (row) await db.orders.put({ ...row, courier_fee_cents: v, updated_at: new Date().toISOString() });
    await enqueue(db, 'order.driver_pay', { id: orderId, cents: v });
  });
}

/**
 * Settle with a driver: his pay for these deliveries is recorded once (each delivery can be in one payout only — the server
 * computes the amount from the orders). The customers' money is NOT touched here: it is the orders' own payments.
 * from_drawer → the matching cash-out on the open shift, so expected cash stays right.
 */
export async function payDriver(db: PosDb, input: { driver: Pick<Driver, 'id' | 'name'>; orders: Array<Pick<Order, 'id' | 'courier_fee_cents'>>; currency: Currency; amount: number; rate: number; from_drawer: boolean; shift: Shift | null; note?: string | null; user_id: string; label?: string }): Promise<{ id: string; amount_cents: number } | null> {
  if (!input.orders.length) return null;
  const id = newId(); const at = new Date().toISOString(); const fromDrawer = input.from_drawer && !!input.shift && input.amount > 0;
  const amount_cents = input.orders.reduce((s, o) => s + num(o.courier_fee_cents), 0);
  await db.transaction('rw', [db.orders, db.outbox], async () => {
    for (const o of input.orders) { const row = await db.orders.get(o.id); if (row && !row.driver_paid_at) await db.orders.put({ ...row, driver_paid_at: at, driver_payout_id: id }); }
    await enqueue(db, 'driver.payout', { id, driver_id: input.driver.id, order_ids: input.orders.map(o => o.id), currency: input.currency, amount: input.amount, rate: input.rate, from_drawer: fromDrawer, shift_id: fromDrawer ? input.shift!.id : null, note: input.note ?? null, at });
  });
  if (fromDrawer) await cashMove(db, input.shift!, { kind: 'out', amount: input.amount, currency: input.currency, reason: input.label ?? `driver · ${input.driver.name}`, user_id: input.user_id });
  return { id, amount_cents };
}
