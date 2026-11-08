import type { PosDb } from './db';
import { META } from './db';
import { enqueue, newId } from './sale';
import { cashMove } from './shift';
import { lbpToCents } from './money';
import { normPhone } from './customers';
import { num, type Currency, type Product, type Purchase, type PurchaseLine, type Shift, type Supplier, type SupplierPayment } from './types';

/** Suppliers & purchases (M10): receive stock at cost, optional new selling price, returns to supplier, payments. */

export async function upsertSupplier(db: PosDb, shopId: string, input: { id?: string; name: string; phone?: string | null; contact?: string | null; notes?: string | null; active?: boolean }): Promise<Supplier> {
  const name = input.name.trim(); if (!name) throw new Error('bad_name');
  const existing = input.id ? await db.suppliers.get(input.id) : undefined;
  const row: Supplier = { id: existing?.id ?? newId(), shop_id: shopId, name, phone: input.phone?.trim() || null, phone_key: input.phone ? normPhone(input.phone) : null, contact: input.contact ?? existing?.contact ?? null, notes: input.notes ?? existing?.notes ?? null, balance_cents: existing?.balance_cents ?? 0, active: input.active ?? existing?.active ?? true, updated_at: new Date().toISOString() };
  await db.transaction('rw', [db.suppliers, db.outbox], async () => {
    await db.suppliers.put(row);
    await enqueue(db, 'supplier.upsert', { id: row.id, name: row.name, phone: row.phone, contact: row.contact, notes: row.notes, active: row.active });
  });
  return row;
}

export interface PurchaseDraftLine { product: Product; qty: number; unit_cost: number; new_price_usd?: number | null; new_price_lbp?: number | null; expiry?: string | null }

export function purchaseTotals(lines: PurchaseDraftLine[], currency: Currency, rate: number, discount = 0) {
  const subtotal = Math.round(lines.reduce((s, l) => s + l.qty * l.unit_cost, 0) * 100) / 100;
  const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
  const toCents = (v: number) => (currency === 'lbp' ? lbpToCents(Math.round(v), rate) : Math.round(v * 100));
  return { subtotal, total, total_cents: toCents(total), unitCents: (c: number) => toCents(c) };
}

/** Post a purchase (or a return to supplier): stock moves + cost/price on products locally, one op for the server. */
export async function commitPurchase(db: PosDb, input: {
  supplier: Supplier; kind?: 'purchase' | 'return'; lines: PurchaseDraftLine[]; currency: Currency; rate: number; discount?: number;
  invoice_no?: string | null; invoice_date?: string; note?: string | null; user_id: string; approved_by?: string | null;
}): Promise<Purchase> {
  const kind = input.kind ?? 'purchase'; if (!input.lines.length) throw new Error('no_lines');
  const t = purchaseTotals(input.lines, input.currency, input.rate, input.discount ?? 0);
  const now = new Date().toISOString(); const id = newId();
  const deviceId = (await db.meta.get(META.deviceId))?.value as string | undefined;
  const n = (await db.purchases.filter(p => p.kind === kind).count()) + 1;
  const purchase: Purchase = { id, shop_id: input.supplier.shop_id, supplier_id: input.supplier.id, number: `${kind === 'return' ? 'PR' : 'P'}-${String(n).padStart(5, '0')}~`, kind, invoice_no: input.invoice_no ?? null, invoice_date: input.invoice_date ?? now.slice(0, 10), currency: input.currency, rate: input.rate, subtotal: t.subtotal, discount: input.discount ?? 0, total: t.total, total_cents: t.total_cents, note: input.note ?? null, status: 'posted', user_id: input.user_id, approved_by: input.approved_by ?? null, device_id: deviceId ?? null, at: now };
  const lines: PurchaseLine[] = input.lines.map((l, i) => ({ id: newId(), purchase_id: id, shop_id: purchase.shop_id, product_id: l.product.id, name: l.product.name, qty: l.qty, unit_cost: l.unit_cost, unit_cost_cents: t.unitCents(l.unit_cost), line_total_cents: t.unitCents(l.unit_cost * l.qty), new_price_usd: l.new_price_usd ?? null, new_price_lbp: l.new_price_lbp ?? null, expiry: l.expiry ?? null, sort: i + 1 }));
  await db.transaction('rw', [db.purchases, db.purchaseLines, db.products, db.stockMoves, db.suppliers, db.outbox], async () => {
    await db.purchases.put(purchase); await db.purchaseLines.bulkPut(lines);
    for (const l of lines) {
      const p = await db.products.get(l.product_id); if (!p) continue;
      const delta = kind === 'return' ? -Math.abs(l.qty) : l.qty;
      await db.stockMoves.put({ id: newId(), shop_id: p.shop_id, product_id: p.id, qty: delta, kind: kind === 'return' ? 'purchase_return' : 'purchase', ref_id: id, unit_cost_cents: l.unit_cost_cents, note: purchase.number, device_id: deviceId ?? null, user_id: input.user_id, at: now });
      await db.products.put({ ...p, on_hand: p.track_stock ? Math.round((num(p.on_hand) + delta) * 1000) / 1000 : p.on_hand, ...(kind === 'purchase' ? { cost_cents: l.unit_cost_cents, ...(l.new_price_usd != null ? { price_usd: l.new_price_usd } : {}), ...(l.new_price_lbp != null ? { price_lbp: l.new_price_lbp } : {}) } : {}) });
    }
    const s = await db.suppliers.get(input.supplier.id); if (s) await db.suppliers.put({ ...s, balance_cents: num(s.balance_cents) + (kind === 'return' ? -t.total_cents : t.total_cents) });
    await enqueue(db, 'purchase.commit', { id, supplier_id: input.supplier.id, kind, invoice_no: purchase.invoice_no, invoice_date: purchase.invoice_date, currency: purchase.currency, rate: purchase.rate, subtotal: purchase.subtotal, discount: purchase.discount, total: purchase.total, total_cents: purchase.total_cents, note: purchase.note, approved_by: purchase.approved_by, at: now,
      lines: lines.map(l => ({ id: l.id, product_id: l.product_id, qty: l.qty, unit_cost: l.unit_cost, unit_cost_cents: l.unit_cost_cents, line_total_cents: l.line_total_cents, new_price_usd: l.new_price_usd, new_price_lbp: l.new_price_lbp, expiry: l.expiry })) });
  });
  return purchase;
}

export async function voidPurchase(db: PosDb, purchase: Purchase, reason: string, user_id: string, approved_by: string | null): Promise<void> {
  if (purchase.status === 'void') return;
  const lines = await db.purchaseLines.where('purchase_id').equals(purchase.id).toArray();
  const deviceId = (await db.meta.get(META.deviceId))?.value as string | undefined; const now = new Date().toISOString();
  await db.transaction('rw', [db.purchases, db.products, db.stockMoves, db.suppliers, db.outbox], async () => {
    for (const l of lines) {
      const p = await db.products.get(l.product_id); if (!p) continue;
      const delta = purchase.kind === 'return' ? Math.abs(l.qty) : -l.qty;
      await db.stockMoves.put({ id: newId(), shop_id: p.shop_id, product_id: p.id, qty: delta, kind: 'adjust', ref_id: purchase.id, unit_cost_cents: l.unit_cost_cents, note: `void ${purchase.number}`, device_id: deviceId ?? null, user_id, at: now });
      if (p.track_stock) await db.products.put({ ...p, on_hand: Math.round((num(p.on_hand) + delta) * 1000) / 1000 });
    }
    await db.purchases.put({ ...purchase, status: 'void', void_reason: reason });
    const s = await db.suppliers.get(purchase.supplier_id); if (s) await db.suppliers.put({ ...s, balance_cents: num(s.balance_cents) - (purchase.kind === 'return' ? -purchase.total_cents : purchase.total_cents) });
    await enqueue(db, 'purchase.void', { id: purchase.id, reason, approved_by });
  });
}

/** Pay a supplier. Cash out of the drawer also posts a cash.move 'out' on the open shift. */
export async function paySupplier(db: PosDb, input: { supplier: Supplier; purchase_id?: string | null; tender: SupplierPayment['tender']; currency: Currency; amount: number; rate: number; from_drawer: boolean; shift: Shift | null; note?: string | null; user_id: string; approved_by?: string | null }): Promise<SupplierPayment> {
  const amount_cents = input.currency === 'lbp' ? lbpToCents(input.amount, input.rate) : input.amount;
  const deviceId = (await db.meta.get(META.deviceId))?.value as string | undefined; const now = new Date().toISOString();
  const row: SupplierPayment = { id: newId(), shop_id: input.supplier.shop_id, supplier_id: input.supplier.id, purchase_id: input.purchase_id ?? null, tender: input.tender, currency: input.currency, amount: input.amount, amount_cents, rate: input.rate, from_drawer: input.from_drawer && !!input.shift, shift_id: input.from_drawer ? input.shift?.id ?? null : null, note: input.note ?? null, user_id: input.user_id, at: now };
  await db.transaction('rw', [db.supplierPayments, db.suppliers, db.outbox], async () => {
    await db.supplierPayments.put(row);
    const s = await db.suppliers.get(input.supplier.id); if (s) await db.suppliers.put({ ...s, balance_cents: num(s.balance_cents) - amount_cents });
    await enqueue(db, 'supplier.pay', { ...row, device_id: deviceId ?? null, approved_by: input.approved_by ?? null });
  });
  if (row.from_drawer && input.shift && (input.tender === 'cash_usd' || input.tender === 'cash_lbp')) {
    await cashMove(db, input.shift, { kind: 'out', amount: input.amount, currency: input.currency, reason: `${input.supplier.name} · ${input.purchase_id ? 'invoice' : 'payment'}`, user_id: input.user_id });
  }
  return row;
}

/** Statement lines for a supplier: purchases, returns and payments, newest first, with running balance (oldest→newest computed). */
export async function supplierStatement(db: PosDb, supplier: Supplier): Promise<Array<{ at: string; kind: 'purchase' | 'return' | 'payment' | 'void'; ref: string; amount_cents: number; balance_cents: number; row: Purchase | SupplierPayment }>> {
  const ps = await db.purchases.where('supplier_id').equals(supplier.id).toArray();
  const pays = await db.supplierPayments.where('supplier_id').equals(supplier.id).toArray();
  const items = [
    ...ps.map(p => ({ at: p.at, kind: (p.status === 'void' ? 'void' : p.kind) as 'purchase' | 'return' | 'void', ref: p.number, amount_cents: p.status === 'void' ? 0 : p.kind === 'return' ? -p.total_cents : p.total_cents, row: p as Purchase | SupplierPayment })),
    ...pays.map(p => ({ at: p.at, kind: 'payment' as const, ref: p.tender, amount_cents: -p.amount_cents, row: p as Purchase | SupplierPayment })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  let bal = num(supplier.balance_cents) - items.reduce((s, i) => s + i.amount_cents, 0);   // opening = current − everything we hold locally
  const out = items.map(i => { bal += i.amount_cents; return { ...i, balance_cents: bal }; });
  return out.reverse();
}
