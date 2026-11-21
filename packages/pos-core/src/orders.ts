import { META, type PosDb } from './db';
import { enqueue, newId } from './sale';
import { settle, type Settlement } from './money';
import { driverPayOf } from './drivers';
import { num, type Currency, type Order, type OrderLine, type OrderStatus, type Payment, type Product } from './types';

// Order inbox actions (PLAN §M5). Each one writes the local mirror first (so the board updates instantly, offline too) and queues an op.

export const NEXT: Record<OrderStatus, OrderStatus[]> = {
  pending: ['accepted', 'rejected', 'cancelled'], accepted: ['preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'], preparing: ['ready', 'out_for_delivery', 'delivered', 'cancelled'],
  ready: ['out_for_delivery', 'delivered', 'cancelled'], out_for_delivery: ['delivered', 'cancelled'], delivered: [], rejected: [], cancelled: [],
};

export async function setOrderStatus(db: PosDb, order: Order, status: OrderStatus, extra: { reject_reason?: string; cancel_reason?: string; eta_minutes?: number | null; notify_customer?: boolean; shop_notes?: string; driver_id?: string | null; courier_name?: string | null } = {}): Promise<Order> {
  const now = new Date().toISOString();
  const updated: Order = { ...order, status, reject_reason: extra.reject_reason ?? order.reject_reason, cancel_reason: extra.cancel_reason ?? order.cancel_reason, eta_minutes: extra.eta_minutes ?? order.eta_minutes,
    notify_customer: extra.notify_customer ?? order.notify_customer, shop_notes: extra.shop_notes ?? order.shop_notes, driver_id: 'driver_id' in extra ? extra.driver_id ?? null : order.driver_id, courier_name: 'driver_id' in extra ? extra.courier_name ?? null : order.courier_name, accepted_at: status === 'accepted' ? now : order.accepted_at,
    delivered_at: status === 'delivered' ? now : order.delivered_at, closed_at: ['delivered', 'rejected', 'cancelled'].includes(status) ? now : order.closed_at, updated_at: now };
  // delivered by a shop driver with no fee entered yet → what the delivery earns him, from the pay rule (the server does the same)
  if (status === 'delivered' && order.status !== 'delivered' && updated.driver_id && !num(updated.courier_fee_cents) && !updated.driver_paid_at) updated.courier_fee_cents = await driverPayOf(db, updated);
  await db.transaction('rw', [db.orders, db.outbox], async () => {
    await db.orders.put(updated);
    const { courier_name: _cn, ...rest } = extra; void _cn;
    await enqueue(db, 'order.status', { id: order.id, status, ...rest });
  });
  return updated;
}

/** Line a driver up for a delivery that is still in the shop (null = the shop delivers itself). The status does not move;
 *  the server messages the driver so he can come for it, and "out for delivery" later needs no second choice. */
export async function assignDriver(db: PosDb, order: Order, driver: { id: string; name: string } | null): Promise<Order> {
  // a different driver starts clean: the confirmations belonged to the one before
  const changed = (driver?.id ?? null) !== (order.driver_id ?? null);
  const updated: Order = { ...order, driver_id: driver?.id ?? null, courier_name: driver?.name ?? null,
    ...(changed ? { driver_ack_at: null, driver_picked_at: null, driver_delivered_at: null } : {}), updated_at: new Date().toISOString() };
  await db.transaction('rw', [db.orders, db.outbox], async () => {
    await db.orders.put(updated);
    await enqueue(db, 'order.status', { id: order.id, status: order.status, driver_id: driver?.id ?? null });
  });
  return updated;
}

/** For an added line (`product`), the optional fields carry what the cart line had: its note, a changed price and a line discount. */
export interface LineEdit { id?: string; qty?: number; voided?: boolean; void_reason?: string; product?: Product; new_qty?: number; notes?: string | null; unit_price_cents?: number; unit_price_lbp?: number; discount_cents?: number }
/** Edit lines of an open order: qty change, void, or add (substitute). Recomputes totals locally; the server does the same and notifies the customer. */
export async function editOrder(db: PosDb, order: Order, edits: LineEdit[], note?: string, notify = true): Promise<Order> {
  const lines = await db.orderLines.where('order_id').equals(order.id).toArray();
  const rate = num(order.rate_lbp_per_usd) || 89500;
  const payloadLines: Record<string, unknown>[] = [];
  const newLines: OrderLine[] = [];
  for (const e of edits) {
    if (e.id) {
      const l = lines.find(x => x.id === e.id); if (!l) continue;
      if (e.voided) { l.voided = true; l.void_reason = e.void_reason ?? null; payloadLines.push({ id: l.id, voided: true, void_reason: e.void_reason ?? null }); }
      else if (e.qty != null && e.qty !== num(l.quantity)) { l.quantity = e.qty; l.line_total_cents = Math.round(num(l.unit_price_cents) * e.qty) - num(l.discount_cents); payloadLines.push({ id: l.id, qty: e.qty }); }
    } else if (e.product) {
      const p = e.product; const qty = e.new_qty ?? 1;
      const unit_cents = e.unit_price_cents ?? Math.round(num(p.price_usd) * 100); const unit_lbp = e.unit_price_lbp ?? num(p.price_lbp);
      const disc = Math.max(0, Math.min(Math.round(e.discount_cents ?? 0), Math.round(unit_cents * qty)));
      const nl: OrderLine = { id: newId(), order_id: order.id, product_id: p.id, name: p.name, unit: p.unit ?? null, quantity: qty, price_currency: p.price_currency ?? 'usd', unit_price_cents: unit_cents, unit_price_lbp: unit_lbp, discount_cents: disc, line_total_cents: Math.round(unit_cents * qty) - disc, notes: e.notes?.trim() || null, voided: false };
      newLines.push(nl);
      payloadLines.push({ new_id: nl.id, product_id: p.id, name: p.name, unit: nl.unit, qty, price_currency: nl.price_currency, unit_price_cents: unit_cents, unit_price_lbp: nl.unit_price_lbp, discount_cents: disc, line_total_cents: nl.line_total_cents, notes: nl.notes });
    }
  }
  const all = [...lines, ...newLines];
  const subtotal = all.filter(l => !l.voided).reduce((s, l) => s + num(l.line_total_cents), 0);
  const discount = Math.min(num(order.discount_cents), subtotal);
  const fee = Math.round(num(order.delivery_fee_usd) * 100);
  const total = subtotal - discount + fee;
  const updated: Order = { ...order, subtotal_cents: subtotal, discount_cents: discount, total_cents: total, total_usd: total / 100, total_lbp: Math.round((total * rate) / 100), shop_notes: note || order.shop_notes, updated_at: new Date().toISOString() };
  await db.transaction('rw', [db.orders, db.orderLines, db.outbox], async () => {
    await db.orderLines.bulkPut(all); await db.orders.put(updated);
    await enqueue(db, 'order.edit', { id: order.id, lines: payloadLines, note: note ?? null, notify });
  });
  return updated;
}

/** Take payment at handover (pickup counter / COD) and close the order. */
export async function payOrder(db: PosDb, order: Order, payments: Array<Omit<Payment, 'id' | 'order_id' | 'at'>>, rate: number, lbpStep: number, changeIn: Currency, shiftId: string | null, status: OrderStatus = 'delivered', extra: { courier_fee_cents?: number; courier_name?: string | null } = {}): Promise<{ order: Order; settlement: Settlement }> {
  const now = new Date().toISOString();
  const pays: Payment[] = payments.map(p => ({ ...p, id: newId(), order_id: order.id, at: now }));
  const s = settle(num(order.total_cents), pays, rate, lbpStep, changeIn);
  const updated: Order = { ...order, status, paid_usd_cents: s.paid_usd_cents, paid_lbp: s.paid_lbp, change_usd_cents: s.change_usd_cents, change_lbp: s.change_lbp, shift_id: shiftId ?? order.shift_id ?? null,
    courier_fee_cents: extra.courier_fee_cents ?? order.courier_fee_cents ?? 0, courier_name: extra.courier_name ?? order.courier_name ?? null,
    delivered_at: status === 'delivered' ? now : order.delivered_at, closed_at: status === 'delivered' ? now : order.closed_at, updated_at: now };
  if (status === 'delivered' && order.status !== 'delivered' && updated.driver_id && !num(updated.courier_fee_cents) && !updated.driver_paid_at) updated.courier_fee_cents = await driverPayOf(db, updated);
  await db.transaction('rw', [db.orders, db.payments, db.outbox], async () => {
    await db.payments.bulkPut(pays); await db.orders.put(updated);
    await enqueue(db, 'order.pay', { id: order.id, status, shift_id: shiftId, payments: pays.map(p => ({ id: p.id, tender: p.tender, amount: p.amount, currency: p.currency, reference: p.reference ?? null, unpaid_name: p.unpaid_name ?? null, unpaid_phone: p.unpaid_phone ?? null, at: p.at })),
      paid_usd_cents: s.paid_usd_cents, paid_lbp: s.paid_lbp, change_usd_cents: s.change_usd_cents, change_lbp: s.change_lbp, courier_fee_cents: updated.courier_fee_cents, courier_name: updated.courier_name });
  });
  return { order: updated, settlement: s };
}

export interface ReturnLineInput { order_item_id: string; product_id: string | null; qty: number; destination: 'stock' | 'damaged'; amount_cents: number }
/** Full/partial return against a delivered order. Refund in one currency; stock back (or damaged); the shift's expected cash drops. */
export async function commitReturn(db: PosDb, order: Order, lines: ReturnLineInput[], input: { refund_currency: Currency; refund_usd_cents: number; refund_lbp: number; reason: string; approved_by: string | null; user_id: string; shift_id?: string | null }): Promise<string> {
  const id = newId(); const now = new Date().toISOString();
  const deviceId = (await db.meta.get(META.deviceId))?.value as string | undefined;
  await db.transaction('rw', [db.payments, db.stockMoves, db.products, db.outbox], async () => {
    if (input.refund_usd_cents > 0) await db.payments.put({ id: newId(), order_id: order.id, tender: 'cash_usd', amount: -input.refund_usd_cents, currency: 'usd', note: `refund ${id}`, at: now, shift_id: input.shift_id ?? null });
    if (input.refund_lbp > 0) await db.payments.put({ id: newId(), order_id: order.id, tender: 'cash_lbp', amount: -input.refund_lbp, currency: 'lbp', note: `refund ${id}`, at: now, shift_id: input.shift_id ?? null });
    for (const l of lines) {
      if (!l.product_id) continue;
      const p = await db.products.get(l.product_id); if (!p?.track_stock) continue;
      await db.stockMoves.put({ id: newId(), shop_id: order.shop_id, product_id: l.product_id, qty: l.qty, kind: 'return', ref_order_id: order.id, ref_id: id, device_id: deviceId ?? null, user_id: input.user_id, at: now });
      if (l.destination === 'damaged') await db.stockMoves.put({ id: newId(), shop_id: order.shop_id, product_id: l.product_id, qty: -l.qty, kind: 'damaged', ref_order_id: order.id, ref_id: id, device_id: deviceId ?? null, user_id: input.user_id, at: now, note: 'return' });
      else await db.products.put({ ...p, on_hand: num(p.on_hand) + l.qty });
    }
    await enqueue(db, 'return.commit', { id, order_id: order.id, lines: lines.map(l => ({ id: newId(), ...l })), refund_usd_cents: input.refund_usd_cents, refund_lbp: input.refund_lbp, refund_tender: input.refund_currency === 'lbp' ? 'cash_lbp' : 'cash_usd', reason: input.reason, approved_by: input.approved_by, shift_id: input.shift_id ?? null });
  });
  return id;
}

/** Owner (or cashier with owner PIN): remove a cancelled / rejected order from the records. Items and payments go with it locally and on the server. */
export async function deleteOrder(db: PosDb, order: Order, approved_by: string | null): Promise<void> {
  if (order.status !== 'cancelled' && order.status !== 'rejected') throw new Error('cancel_first');
  await db.transaction('rw', [db.orders, db.orderLines, db.payments, db.outbox], async () => {
    await db.orderLines.where('order_id').equals(order.id).delete(); await db.payments.where('order_id').equals(order.id).delete(); await db.orders.delete(order.id);
    await enqueue(db, 'order.delete', { id: order.id, approved_by });
  });
}

/** Statuses in which two orders can still be merged: nothing has left the shop and (online) stock is still only reserved. */
export const MERGEABLE: OrderStatus[] = ['pending', 'accepted', 'preparing'];
const phoneKey = (p: string | null | undefined) => (p ?? '').replace(/\D/g, '').replace(/^00/, '').replace(/^961/, '').replace(/^0/, '');
/** Why `source` cannot be merged into `target` (null = it can). The server checks the same things. */
export function mergeBlock(target: Order, source: Order, sourcePayments: number): 'same_order' | 'order_closed' | 'different_customer' | 'different_fulfillment' | 'source_has_payments' | null {
  if (target.id === source.id) return 'same_order';
  if (!MERGEABLE.includes(target.status) || !MERGEABLE.includes(source.status) || target.parked || source.parked) return 'order_closed';
  const a = phoneKey(target.customer_phone), b = phoneKey(source.customer_phone);
  if (!((a && a === b) || (target.customer_id && target.customer_id === source.customer_id))) return 'different_customer';
  if ((target.fulfillment ?? 'pickup') !== (source.fulfillment ?? 'pickup')) return 'different_fulfillment';
  if (sourcePayments > 0) return 'source_has_payments';
  return null;
}
/**
 * Merge two open orders of the same customer: `source`'s lines are added to `target` (which keeps its number), the delivery fee is
 * charged once (the higher of the two), order discounts add up, and `source` is closed as cancelled with "merged into <number>" —
 * never deleted, so its history and the customer's tracking link still explain what happened. One op, applied atomically on the server.
 */
export async function mergeOrders(db: PosDb, target: Order, source: Order): Promise<Order> {
  const [tLines, sLines, sPays] = await Promise.all([db.orderLines.where('order_id').equals(target.id).toArray(), db.orderLines.where('order_id').equals(source.id).toArray(), db.payments.where('order_id').equals(source.id).count()]);
  const block = mergeBlock(target, source, sPays); if (block) throw new Error(block);
  const rate = num(target.rate_lbp_per_usd) || 89500; const now = new Date().toISOString();
  const map: Record<string, string> = {};
  const moved: OrderLine[] = sLines.filter(l => !l.voided).map(l => { const id = newId(); map[l.id] = id; return { ...l, id, order_id: target.id }; });
  const subtotal = [...tLines, ...moved].filter(l => !l.voided).reduce((x, l) => x + num(l.line_total_cents), 0);
  const discount = Math.min(num(target.discount_cents) + num(source.discount_cents), subtotal);
  const feeUsd = Math.max(num(target.delivery_fee_usd), num(source.delivery_fee_usd)); const fee = Math.round(feeUsd * 100);
  const total = subtotal - discount + fee;
  const tNo = target.number ?? target.local_number ?? '', sNo = source.number ?? source.local_number ?? '';
  const notes = [target.shop_notes, source.shop_notes, source.customer_notes].map(x => (x ?? '').trim()).filter(Boolean).join(' · ') || null;
  const updated: Order = { ...target, subtotal_cents: subtotal, discount_cents: discount, delivery_fee_usd: feeUsd, total_cents: total, total_usd: total / 100, total_lbp: Math.round((total * rate) / 100), shop_notes: notes, updated_at: now };
  const closed: Order = { ...source, status: 'cancelled', cancel_reason: `دُمج مع الطلب ${tNo}`, notify_customer: false, closed_at: now, updated_at: now };
  await db.transaction('rw', [db.orders, db.orderLines, db.outbox], async () => {
    await db.orderLines.bulkPut(moved); await db.orders.bulkPut([updated, closed]);
    await enqueue(db, 'order.merge', { id: target.id, from: source.id, map, target_number: tNo, source_number: sNo });
  });
  return updated;
}

/** Move the time an order is wanted for (null = as soon as possible). */
export async function setOrderNeeded(db: PosDb, order: Order, needed_at: string | null): Promise<Order> {
  const updated: Order = { ...order, needed_at, updated_at: new Date().toISOString() };
  await db.transaction('rw', [db.orders, db.outbox], async () => { await db.orders.put(updated); await enqueue(db, 'order.needed', { id: order.id, needed_at }); });
  return updated;
}

export interface OrderInfoPatch { customer_name: string; customer_phone: string; fulfillment: 'delivery' | 'pickup'; address: Record<string, unknown>; delivery_fee_cents: number; notes: string | null; needed_at: string | null }
/** Why the information of this order cannot be edited (null = it can). Delivered orders can — with the amount locked. */
export function infoEditBlock(order: Order): 'order_closed' | 'not_an_order' | null {
  if (order.status === 'rejected' || order.status === 'cancelled') return 'order_closed';
  if (order.channel === 'walkin' || order.parked) return 'not_an_order';
  return null;
}
/**
 * Correct who / how / where an existing order is for (the customer box, opened on an order). The lines are not touched.
 * Before delivery the fee follows the choice (pickup = no fee, no driver) and the total is recomputed; once delivered the money was
 * already counted (payments, shift cash, driver pay), so the amount and the driver stay as they are and only the information changes.
 * One op; the server applies the same rules.
 */
export async function editOrderInfo(db: PosDb, order: Order, patch: OrderInfoPatch, notify = true): Promise<Order> {
  const block = infoEditBlock(order); if (block) throw new Error(block);
  const closed = order.status === 'delivered';
  const pickup = patch.fulfillment === 'pickup';
  if (!closed && pickup && order.driver_id && (order.driver_paid_at || order.driver_payout_id)) throw new Error('driver_paid');
  const rate = num(order.rate_lbp_per_usd) || 89500;
  const fee = closed ? Math.round(num(order.delivery_fee_usd) * 100) : pickup ? 0 : Math.max(0, Math.round(patch.delivery_fee_cents || 0));
  const lines = await db.orderLines.where('order_id').equals(order.id).toArray();
  const subtotal = lines.filter(l => !l.voided).reduce((s, l) => s + num(l.line_total_cents), 0);
  const discount = Math.min(num(order.discount_cents), subtotal);
  const total = subtotal - discount + fee;
  const dropDriver = !closed && pickup && !!order.driver_id;
  const updated: Order = { ...order, customer_name: patch.customer_name.trim(), customer_phone: patch.customer_phone.trim() || order.customer_phone, fulfillment: patch.fulfillment,
    address: pickup ? {} : patch.address, customer_notes: patch.notes?.trim() || null, needed_at: patch.needed_at,
    // totals move only when the fee moved (a name or address fix must not re-round the LBP total)
    ...(closed || fee === Math.round(num(order.delivery_fee_usd) * 100) ? {} : { delivery_fee_usd: fee / 100, subtotal_cents: subtotal, discount_cents: discount, total_cents: total, total_usd: total / 100, total_lbp: Math.round((total * rate) / 100) }),
    ...(dropDriver ? { driver_id: null, courier_name: null, courier_fee_cents: 0, driver_ack_at: null, driver_picked_at: null, driver_delivered_at: null } : {}),
    updated_at: new Date().toISOString() };
  await db.transaction('rw', [db.orders, db.outbox], async () => {
    await db.orders.put(updated);
    await enqueue(db, 'order.info', { id: order.id, customer_name: updated.customer_name, customer_phone: updated.customer_phone, fulfillment: updated.fulfillment, address: updated.address,
      delivery_fee_cents: fee, notes: updated.customer_notes ?? null, needed_at: updated.needed_at ?? null, notify });
  });
  return updated;
}
