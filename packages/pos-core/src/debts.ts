import type { PosDb } from './db';
import { num, type Currency, type DebtAllocation, type DebtSettlement, type Order, type Payment, type Shift, type Tender } from './types';
import { enqueue, newId } from './sale';
import { cashMove } from './shift';
import { lbpToCents, roundLbp, usdToLbp } from './money';

/** One debt line = one order that was (fully or partly) left unpaid. Amounts in USD cents. */
export interface DebtLine {
  order: Order; number: string; at: string; name: string; phone: string;
  original_cents: number; paid_cents: number; outstanding_cents: number; closed: boolean;
  /** note typed at the till when the sale was put on credit (payment.reference) */
  note?: string;
}
export interface DebtPerson { phone: string; name: string; lines: DebtLine[]; outstanding_cents: number; original_cents: number; last_at: string }

import { normPhone } from './customers';
export { normPhone };

const unpaidCents = (p: Payment, o: Order) => (p.currency === 'lbp' ? Math.round((num(p.amount) * 100) / (num(o.rate_lbp_per_usd) || 1)) : num(p.amount));

/** All debt lines (open and settled) from the mirror, oldest first. */
export async function debtLines(db: PosDb, opts: { openOnly?: boolean; from?: string; to?: string; phones?: string[] } = {}): Promise<DebtLine[]> {
  const unpaid = (await db.payments.where('tender').equals('unpaid').toArray()).filter(p => num(p.amount) > 0);
  if (!unpaid.length) return [];
  const ids = [...new Set(unpaid.map(p => p.order_id))];
  const orders = new Map((await db.orders.bulkGet(ids)).filter((o): o is Order => !!o && o.status !== 'cancelled' && o.status !== 'rejected').map(o => [o.id, o]));
  const allocs = await db.debtAllocations.toArray();
  const paid = new Map<string, number>(); for (const a of allocs) paid.set(a.order_id, (paid.get(a.order_id) ?? 0) + num(a.amount_cents));
  const byOrder = new Map<string, DebtLine>();
  for (const p of unpaid) {
    const o = orders.get(p.order_id); if (!o) continue;
    const l = byOrder.get(o.id) ?? { order: o, number: o.number ?? o.local_number ?? '', at: p.at, name: p.unpaid_name ?? o.customer_name ?? '', phone: normPhone(p.unpaid_phone || o.customer_phone), original_cents: 0, paid_cents: paid.get(o.id) ?? 0, outstanding_cents: 0, closed: false };
    l.original_cents += unpaidCents(p, o); if (p.at < l.at) l.at = p.at; if (!l.name && p.unpaid_name) l.name = p.unpaid_name; if (p.reference && !l.note) l.note = p.reference;
    byOrder.set(o.id, l);
  }
  let lines = [...byOrder.values()].map(l => ({ ...l, outstanding_cents: Math.max(0, l.original_cents - l.paid_cents), closed: l.original_cents - l.paid_cents <= 0 }));
  if (opts.openOnly) lines = lines.filter(l => !l.closed);
  if (opts.from) lines = lines.filter(l => l.at >= opts.from!);
  if (opts.to) lines = lines.filter(l => l.at < opts.to!);
  if (opts.phones?.length) { const set = new Set(opts.phones.map(normPhone)); lines = lines.filter(l => set.has(l.phone)); }
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

export function groupByPerson(lines: DebtLine[]): DebtPerson[] {
  const m = new Map<string, DebtPerson>();
  for (const l of lines) {
    const key = l.phone || `~${l.name}`;
    const p = m.get(key) ?? { phone: l.phone, name: l.name, lines: [], outstanding_cents: 0, original_cents: 0, last_at: l.at };
    p.lines.push(l); p.outstanding_cents += l.outstanding_cents; p.original_cents += l.original_cents; if (l.at > p.last_at) p.last_at = l.at; if (!p.name && l.name) p.name = l.name;
    m.set(key, p);
  }
  return [...m.values()].sort((a, b) => b.outstanding_cents - a.outstanding_cents || b.last_at.localeCompare(a.last_at));
}

/** Oldest-first allocation preview of `amount_cents` over a person's open lines. */
export function allocate(lines: DebtLine[], amount_cents: number): Array<{ line: DebtLine; amount_cents: number }> {
  const out: Array<{ line: DebtLine; amount_cents: number }> = []; let left = amount_cents;
  for (const l of lines.filter(x => !x.closed).sort((a, b) => a.at.localeCompare(b.at))) {
    if (left <= 0) break;
    const take = Math.min(left, l.outstanding_cents); if (take > 0) { out.push({ line: l, amount_cents: take }); left -= take; }
  }
  return out;
}

/** Record a collection: settlement + allocations (oldest first) + cash into the open shift's drawer (its own cash.move op). */
export async function settleDebt(db: PosDb, input: {
  phone: string; name: string; tender: Exclude<Tender, 'unpaid'>; currency: Currency; amount: number;   // amount in `currency` (USD cents / LBP)
  rate: number; lbpStep: number; lines: DebtLine[]; shift: Shift | null; user_id: string; note?: string; reason?: string;   // reason: drawer line label, e.g. 'تحصيل دين · Abou Elie'
}): Promise<{ settlement: DebtSettlement; allocations: DebtAllocation[]; unallocated_cents: number }> {
  const amount_cents = input.currency === 'lbp' ? lbpToCents(input.amount, input.rate) : input.amount;
  const shopId = input.lines[0]?.order.shop_id ?? (input.shift?.shop_id ?? '');
  const now = new Date().toISOString();
  const settlement: DebtSettlement = { id: newId(), shop_id: shopId, phone: normPhone(input.phone), name: input.name, tender: input.tender, currency: input.currency, amount: input.amount, amount_cents, rate: input.rate, note: input.note ?? null, user_id: input.user_id, shift_id: input.shift?.id ?? null, at: now };
  const plan = allocate(input.lines, amount_cents);
  const allocations: DebtAllocation[] = plan.map(p => ({ id: newId(), settlement_id: settlement.id, shop_id: shopId, order_id: p.line.order.id, amount_cents: p.amount_cents }));
  await db.transaction('rw', [db.debtSettlements, db.debtAllocations, db.outbox], async () => {
    await db.debtSettlements.put(settlement); await db.debtAllocations.bulkPut(allocations);
    await enqueue(db, 'debt.settle', { ...settlement, allocations: allocations.map(a => ({ id: a.id, order_id: a.order_id, amount_cents: a.amount_cents })) });
  });
  if (input.shift && (input.tender === 'cash_usd' || input.tender === 'cash_lbp')) {
    await cashMove(db, input.shift, { kind: 'in', amount: input.amount, currency: input.currency, reason: input.reason ?? `debt · ${input.name || settlement.phone}`, user_id: input.user_id });
  }
  return { settlement, allocations, unallocated_cents: amount_cents - allocations.reduce((s, a) => s + a.amount_cents, 0) };
}

/**
 * Undo a collection recorded by mistake: the settlement and its allocations are removed (the orders are owed again) and, for cash on an
 * open shift, the same amount leaves the drawer again. Owner only on the server (a cashier passes approved_by).
 */
export async function unsettleDebt(db: PosDb, s: DebtSettlement, opts: { shift: Shift | null; user_id: string; reason?: string; approved_by?: string | null; label?: string }): Promise<void> {
  await db.transaction('rw', [db.debtSettlements, db.debtAllocations, db.outbox], async () => {
    await db.debtAllocations.where('settlement_id').equals(s.id).delete();
    await db.debtSettlements.delete(s.id);
    await enqueue(db, 'debt.unsettle', { id: s.id, reason: opts.reason ?? null, approved_by: opts.approved_by ?? null });
  });
  if (opts.shift && (s.tender === 'cash_usd' || s.tender === 'cash_lbp')) {
    await cashMove(db, opts.shift, { kind: 'out', amount: num(s.amount), currency: s.currency, reason: opts.label ?? `debt undo · ${s.name || s.phone}`, user_id: opts.user_id });
  }
}

export const debtLbp = (cents: number, rate: number, step: number) => roundLbp(usdToLbp(cents, rate), step);
