import { META, type PosDb } from './db';
import { enqueue, newId } from './sale';
import { settle, type Settlement } from './money';
import { num, type Currency, type Order, type OrderLine, type OrderStatus, type Payment, type Product } from './types';

// Order inbox actions (PLAN §M5). Each one writes the local mirror first (so the board updates instantly, offline too) and queues an op.

export const NEXT: Record<OrderStatus, OrderStatus[]> = {
  pending: ['accepted', 'rejected', 'cancelled'], accepted: ['preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'], preparing: ['ready', 'out_for_delivery', 'delivered', 'cancelled'],
  ready: ['out_for_delivery', 'delivered', 'cancelled'], out_for_delivery: ['delivered', 'cancelled'], delivered: [], rejected: [], cancelled: [],
};

export async function setOrderStatus(db: PosDb, order: Order, status: OrderStatus, extra: { reject_reason?: string; cancel_reason?: string; eta_minutes?: number | null; notify_customer?: boolean; shop_notes?: string } = {}): Promise<Order> {
  const now = new Date().toISOString();
  const updated: Order = { ...order, status, reject_reason: extra.reject_reason ?? order.reject_reason, cancel_reason: extra.cancel_reason ?? order.cancel_reason, eta_minutes: extra.eta_minutes ?? order.eta_minutes,
    notify_customer: extra.notify_customer ?? order.notify_customer, shop_notes: extra.shop_notes ?? order.shop_notes, accepted_at: status === 'accepted' ? now : order.accepted_at,
    delivered_at: status === 'delivered' ? now : order.delivered_at, closed_at: ['delivered', 'rejected', 'cancelled'].includes(status) ? now : order.closed_at, updated_at: now };
  await db.transaction('rw', [db.orders, db.outbox], async () => {
    await db.orders.put(updated);
    await enqueue(db, 'order.status', { id: order.id, status, ...extra });
  });
  return updated;
}

export interface LineEdit { id?: string; qty?: number; voided?: boolean; void_reason?: string; product?: Product; new_qty?: number }
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
      const p = e.product; const qty = e.new_qty ?? 1; const unit_cents = Math.round(num(p.price_usd) * 100);
      const nl: OrderLine = { id: newId(), order_id: order.id, product_id: p.id, name: p.name, unit: p.unit ?? null, quantity: qty, price_currency: p.price_currency ?? 'usd', unit_price_cents: unit_cents, unit_price_lbp: num(p.price_lbp), discount_cents: 0, line_total_cents: Math.round(unit_cents * qty), voided: false };
      newLines.push(nl);
      payloadLines.push({ new_id: nl.id, product_id: p.id, name: p.name, unit: nl.unit, qty, price_currency: nl.price_currency, unit_price_cents: unit_cents, unit_price_lbp: nl.unit_price_lbp, line_total_cents: nl.line_total_cents });
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
    if (input.refund_usd_cents > 0) await db.payments.put({ id: newId(), order_id: order.id, tender: 'cash_usd', amount: -input.refund_usd_cents, currency: 'usd', note: `refund ${id}`, at: now });
    if (input.refund_lbp > 0) await db.payments.put({ id: newId(), order_id: order.id, tender: 'cash_lbp', amount: -input.refund_lbp, currency: 'lbp', note: `refund ${id}`, at: now });
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
