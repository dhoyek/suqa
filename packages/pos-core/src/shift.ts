import { META, type PosDb } from './db';
import { enqueue, newId } from './sale';
import { num, type CashMove, type Order, type Payment, type Shift } from './types';

// Shifts are per device. Expected cash per currency at close:
//   float + cash sales (cash_usd / cash_lbp tenders) − change given (in that currency) + cash in − cash out
// Everything comes from the local mirror, so closing works offline; the server gets expected/counted/diff with the op.

export async function currentShift(db: PosDb): Promise<Shift | null> {
  const deviceId = (await db.meta.get(META.deviceId))?.value as string | undefined;
  if (!deviceId) return null;
  const open = await db.shifts.where('device_id').equals(deviceId).filter(s => !s.closed_at).reverse().sortBy('opened_at');
  return open[0] ?? null;
}

export async function openShift(db: PosDb, input: { float_usd_cents: number; float_lbp: number; opened_by: string }): Promise<Shift> {
  const deviceId = (await db.meta.get(META.deviceId))?.value as string;
  const shop = (await db.meta.get(META.shop))?.value as { id: string; tenant_id: string };
  const s: Shift = { id: newId(), shop_id: shop.id, device_id: deviceId, opened_by: input.opened_by, opened_at: new Date().toISOString(), float_usd_cents: input.float_usd_cents, float_lbp: input.float_lbp };
  await db.transaction('rw', [db.shifts, db.outbox], async () => {
    await db.shifts.put(s);
    await enqueue(db, 'shift.open', { id: s.id, opened_at: s.opened_at, float_usd_cents: s.float_usd_cents, float_lbp: s.float_lbp });
  });
  return s;
}

export async function cashMove(db: PosDb, shift: Shift, input: { kind: 'in' | 'out'; amount: number; currency: 'usd' | 'lbp'; reason: string; user_id: string }): Promise<CashMove> {
  const m: CashMove = { id: newId(), shift_id: shift.id, kind: input.kind, amount: input.amount, currency: input.currency, reason: input.reason, user_id: input.user_id, at: new Date().toISOString() };
  await db.transaction('rw', [db.cashMoves, db.outbox], async () => {
    await db.cashMoves.put(m);
    await enqueue(db, 'cash.move', { id: m.id, shift_id: m.shift_id, kind: m.kind, amount: m.amount, currency: m.currency, reason: m.reason, at: m.at });
  });
  return m;
}

export interface ShiftSummary {
  shift: Shift; orders: Order[]; payments: Payment[]; moves: CashMove[];
  sales_count: number; total_cents: number; total_lbp: number;
  cash_usd_sales: number; cash_lbp_sales: number; change_usd: number; change_lbp: number;
  in_usd: number; in_lbp: number; out_usd: number; out_lbp: number;
  expected_usd_cents: number; expected_lbp: number;
  by_tender: Record<string, { usd: number; lbp: number; count: number }>;
  by_channel: Record<string, { count: number; cents: number }>;
  unpaid_cents: number;
}

export async function shiftSummary(db: PosDb, shift: Shift): Promise<ShiftSummary> {
  const orders = (await db.orders.where('shift_id').equals(shift.id).toArray()).filter(o => o.status !== 'cancelled' && o.status !== 'rejected');
  const ids = new Set(orders.map(o => o.id));
  const payments = (await db.payments.toArray()).filter(p => ids.has(p.order_id));
  const moves = await db.cashMoves.where('shift_id').equals(shift.id).toArray();
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const cash_usd_sales = sum(payments.filter(p => p.tender === 'cash_usd').map(p => num(p.amount)));
  const cash_lbp_sales = sum(payments.filter(p => p.tender === 'cash_lbp').map(p => num(p.amount)));
  const change_usd = sum(orders.map(o => num(o.change_usd_cents)));
  const change_lbp = sum(orders.map(o => num(o.change_lbp)));
  const in_usd = sum(moves.filter(m => m.kind === 'in' && m.currency === 'usd').map(m => num(m.amount)));
  const in_lbp = sum(moves.filter(m => m.kind === 'in' && m.currency === 'lbp').map(m => num(m.amount)));
  const out_usd = sum(moves.filter(m => m.kind === 'out' && m.currency === 'usd').map(m => num(m.amount)));
  const out_lbp = sum(moves.filter(m => m.kind === 'out' && m.currency === 'lbp').map(m => num(m.amount)));
  const by_tender: ShiftSummary['by_tender'] = {};
  for (const p of payments) { const t = (by_tender[p.tender] ??= { usd: 0, lbp: 0, count: 0 }); t.count++; if (p.currency === 'lbp') t.lbp += num(p.amount); else t.usd += num(p.amount); }
  const by_channel: ShiftSummary['by_channel'] = {};
  for (const o of orders) { const c = (by_channel[o.channel] ??= { count: 0, cents: 0 }); c.count++; c.cents += num(o.total_cents); }
  return {
    shift, orders, payments, moves,
    sales_count: orders.length, total_cents: sum(orders.map(o => num(o.total_cents))), total_lbp: sum(orders.map(o => num(o.total_lbp))),
    cash_usd_sales, cash_lbp_sales, change_usd, change_lbp, in_usd, in_lbp, out_usd, out_lbp,
    expected_usd_cents: num(shift.float_usd_cents) + cash_usd_sales - change_usd + in_usd - out_usd,
    expected_lbp: num(shift.float_lbp) + cash_lbp_sales - change_lbp + in_lbp - out_lbp,
    by_tender, by_channel,
    unpaid_cents: sum(payments.filter(p => p.tender === 'unpaid').map(p => (p.currency === 'lbp' ? 0 : num(p.amount)))),
  };
}

export async function closeShift(db: PosDb, shift: Shift, input: { counted_usd_cents: number; counted_lbp: number; closed_by: string; note?: string }): Promise<Shift> {
  const s = await shiftSummary(db, shift);
  const closed: Shift = { ...shift, closed_by: input.closed_by, closed_at: new Date().toISOString(), counted_usd_cents: input.counted_usd_cents, counted_lbp: input.counted_lbp,
    expected_usd_cents: s.expected_usd_cents, expected_lbp: s.expected_lbp, diff_usd_cents: input.counted_usd_cents - s.expected_usd_cents, diff_lbp: input.counted_lbp - s.expected_lbp, note: input.note ?? null };
  await db.transaction('rw', [db.shifts, db.outbox], async () => {
    await db.shifts.put(closed);
    await enqueue(db, 'shift.close', { id: closed.id, closed_at: closed.closed_at, counted_usd_cents: closed.counted_usd_cents, counted_lbp: closed.counted_lbp,
      expected_usd_cents: closed.expected_usd_cents, expected_lbp: closed.expected_lbp, diff_usd_cents: closed.diff_usd_cents, diff_lbp: closed.diff_lbp, note: closed.note });
  });
  return closed;
}

/** Today (device-local day) from the local mirror — works offline. */
export async function todaySummary(db: PosDb, now = new Date()): Promise<Omit<ShiftSummary, 'shift' | 'moves' | 'in_usd' | 'in_lbp' | 'out_usd' | 'out_lbp' | 'expected_usd_cents' | 'expected_lbp'> & { items_count: number }> {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const orders = (await db.orders.where('placed_at').aboveOrEqual(start.toISOString()).toArray()).filter(o => o.status !== 'cancelled' && o.status !== 'rejected' && !o.parked);
  const ids = new Set(orders.map(o => o.id));
  const payments = (await db.payments.toArray()).filter(p => ids.has(p.order_id));
  const lines = (await db.orderLines.toArray()).filter(l => ids.has(l.order_id) && !l.voided);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const by_tender: ShiftSummary['by_tender'] = {};
  for (const p of payments) { const t = (by_tender[p.tender] ??= { usd: 0, lbp: 0, count: 0 }); t.count++; if (p.currency === 'lbp') t.lbp += num(p.amount); else t.usd += num(p.amount); }
  const by_channel: ShiftSummary['by_channel'] = {};
  for (const o of orders) { const c = (by_channel[o.channel] ??= { count: 0, cents: 0 }); c.count++; c.cents += num(o.total_cents); }
  return {
    orders, payments, sales_count: orders.length, total_cents: sum(orders.map(o => num(o.total_cents))), total_lbp: sum(orders.map(o => num(o.total_lbp))),
    cash_usd_sales: sum(payments.filter(p => p.tender === 'cash_usd').map(p => num(p.amount))), cash_lbp_sales: sum(payments.filter(p => p.tender === 'cash_lbp').map(p => num(p.amount))),
    change_usd: sum(orders.map(o => num(o.change_usd_cents))), change_lbp: sum(orders.map(o => num(o.change_lbp))),
    by_tender, by_channel, unpaid_cents: sum(payments.filter(p => p.tender === 'unpaid' && p.currency !== 'lbp').map(p => num(p.amount))),
    items_count: sum(lines.map(l => num(l.quantity))),
  };
}
