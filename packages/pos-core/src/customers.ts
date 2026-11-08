import type { PosDb } from './db';
import { enqueue, newId } from './sale';
import type { CustomerAddress, Order, OrderLine, SavedAddress, ShopCustomer } from './types';

/** Canonical local form so "+961 70 000 000", "0096170000000", "070000000" and "70000000" are the same person (mirrors suqa._phone_key). */
export const normPhone = (p: string | null | undefined) => (p ?? '').replace(/\D/g, '').replace(/^00/, '').replace(/^961/, '').replace(/^0/, '');

/** Display form: +961 70 483 148 for local numbers, the digits otherwise. */
export function fmtPhone(p: string | null | undefined): string {
  const k = normPhone(p); if (!k) return '';
  if (k.length === 8) return `+961 ${k.slice(0, 2)} ${k.slice(2, 5)} ${k.slice(5)}`;
  if (k.length === 7) return `+961 ${k.slice(0, 1)} ${k.slice(1, 4)} ${k.slice(4)}`;
  return '+' + (p ?? '').replace(/\D/g, '').replace(/^00/, '');
}

const norm = (s: string) => s.toLowerCase().replace(/[ً-ْ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim();

/** Name-or-number search, best matches first (prefix on number, word-prefix on name); recent customers when the query is empty. */
export async function searchCustomers(db: PosDb, q: string, limit = 8): Promise<ShopCustomer[]> {
  const all = await db.shopCustomers.toArray();
  const digits = normPhone(q); const text = norm(q);
  if (!digits && !text) return all.filter(c => c.last_order_at && c.active !== false).sort((a, b) => (b.last_order_at ?? '').localeCompare(a.last_order_at ?? '')).slice(0, limit);
  const score = (c: ShopCustomer) => {
    let s = 0;
    if (digits) { if (c.phone_key.startsWith(digits)) s += 3; else if (c.phone_key.includes(digits)) s += 1; }
    if (text) { const n = norm(c.name); if (n.startsWith(text)) s += 3; else if (n.split(/\s+/).some(w => w.startsWith(text))) s += 2; else if (n.includes(text)) s += 1; }
    return s;
  };
  return all.filter(c => c.active !== false).map(c => ({ c, s: score(c) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || (b.c.last_order_at ?? '').localeCompare(a.c.last_order_at ?? '')).slice(0, limit).map(x => x.c);
}

export const findCustomer = async (db: PosDb, phone: string) => db.shopCustomers.where('phone_key').equals(normPhone(phone)).first();

/** Explicit edit from the dialog: saved locally now, pushed as customer.upsert. */
export async function upsertCustomer(db: PosDb, shopId: string, input: { phone: string; name: string; address?: CustomerAddress; notes?: string | null; credit_limit_cents?: number | null; discount_pct?: number | null; active?: boolean; addresses?: SavedAddress[] }): Promise<ShopCustomer> {
  const key = normPhone(input.phone); if (key.length < 6) throw new Error('bad_phone');
  const existing = await db.shopCustomers.where('phone_key').equals(key).first();
  const row: ShopCustomer = {
    id: existing?.id ?? newId(), shop_id: shopId, phone: input.phone.trim(), phone_key: key, name: input.name.trim() || existing?.name || '',
    address: input.address ?? existing?.address ?? {}, notes: input.notes === undefined ? existing?.notes ?? null : input.notes, user_id: existing?.user_id ?? null,
    credit_limit_cents: input.credit_limit_cents === undefined ? existing?.credit_limit_cents ?? null : input.credit_limit_cents, discount_pct: input.discount_pct === undefined ? existing?.discount_pct ?? 0 : input.discount_pct,
    active: input.active ?? existing?.active ?? true, addresses: input.addresses ?? existing?.addresses ?? [], orders_count: existing?.orders_count ?? 0, last_order_at: existing?.last_order_at ?? null, updated_at: new Date().toISOString(),
  };
  await db.transaction('rw', [db.shopCustomers, db.outbox], async () => {
    await db.shopCustomers.put(row);
    await enqueue(db, 'customer.upsert', { phone: row.phone, name: row.name, ...(input.address !== undefined ? { address: row.address } : {}), ...(input.notes !== undefined ? { notes: row.notes } : {}), ...(input.credit_limit_cents !== undefined ? { credit_limit_cents: row.credit_limit_cents } : {}), ...(input.discount_pct !== undefined ? { discount_pct: row.discount_pct } : {}), ...(input.active !== undefined ? { active: row.active } : {}), ...(input.addresses !== undefined ? { addresses: row.addresses } : {}) });
  });
  return row;
}

/** The customer's most recent non-parked order in the mirror, with its lines (for "repeat last order"). */
export async function lastOrderOf(db: PosDb, phone: string): Promise<{ order: Order; lines: OrderLine[] } | null> {
  const key = normPhone(phone); if (!key) return null;
  const orders = (await db.orders.toArray()).filter(o => !o.parked && o.status !== 'cancelled' && o.status !== 'rejected' && normPhone(o.customer_phone) === key).sort((a, b) => b.placed_at.localeCompare(a.placed_at));
  if (!orders.length) return null;
  const lines = (await db.orderLines.where('order_id').equals(orders[0].id).toArray()).filter(l => !l.voided);
  return { order: orders[0], lines };
}

/** Open (not finished) orders of this customer — to warn about a possible duplicate. */
export async function openOrdersOf(db: PosDb, phone: string): Promise<Order[]> {
  const key = normPhone(phone); if (!key) return [];
  return (await db.orders.toArray()).filter(o => !o.parked && !['delivered', 'cancelled', 'rejected'].includes(o.status) && normPhone(o.customer_phone) === key);
}

/** Google-Maps link for a pin, and the reverse: coordinates from a pasted link when they are in the URL. */
export const mapUrlFor = (lat: number, lng: number) => `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
export function coordsFrom(url: string): { lat: number; lng: number } | null {
  const m = url.match(/(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/) ?? url.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/);
  if (!m) return null; const lat = Number(m[1]), lng = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** Merge a duplicate into the kept record: local orders re-pointed to the kept number, the dropped row removed; the server does the same (customer.merge). */
export async function mergeCustomers(db: PosDb, keep: ShopCustomer, drop: ShopCustomer, approved_by?: string | null): Promise<void> {
  if (keep.id === drop.id) throw new Error('same_customer');
  await db.transaction('rw', [db.shopCustomers, db.orders, db.outbox], async () => {
    const moved = (await db.orders.toArray()).filter(o => normPhone(o.customer_phone) === drop.phone_key);
    for (const o of moved) await db.orders.update(o.id, { customer_phone: keep.phone, customer_name: o.customer_name?.trim() ? o.customer_name : keep.name });
    const all = (await db.orders.toArray()).filter(o => !o.parked && normPhone(o.customer_phone) === keep.phone_key);
    await db.shopCustomers.put({ ...keep, name: keep.name || drop.name, address: Object.keys(keep.address ?? {}).length ? keep.address : drop.address, notes: [keep.notes, drop.notes].filter(Boolean).join(' · ') || null,
      credit_limit_cents: keep.credit_limit_cents ?? drop.credit_limit_cents ?? null, discount_pct: Math.max(Number(keep.discount_pct) || 0, Number(drop.discount_pct) || 0), active: true,
      orders_count: all.length, last_order_at: all.reduce<string | null>((m, o) => (!m || o.placed_at > m ? o.placed_at : m), null), updated_at: new Date().toISOString() });
    await db.shopCustomers.delete(drop.id);
    await enqueue(db, 'customer.merge', { keep_id: keep.id, drop_id: drop.id, ...(approved_by ? { approved_by } : {}) });
  });
}

/** True when the customer has orders in the mirror — then deleting is refused (server says has_history too) and "inactive" is the way. */
export async function customerHasHistory(db: PosDb, c: ShopCustomer): Promise<boolean> {
  if (c.orders_count > 0) return true;
  const o = await db.orders.toArray(); return o.some(x => normPhone(x.customer_phone) === c.phone_key);
}

export async function deleteCustomer(db: PosDb, c: ShopCustomer, approved_by?: string | null): Promise<void> {
  if (await customerHasHistory(db, c)) throw new Error('has_history');
  await db.transaction('rw', [db.shopCustomers, db.outbox], async () => {
    await db.shopCustomers.delete(c.id);
    await enqueue(db, 'customer.delete', { id: c.id, ...(approved_by ? { approved_by } : {}) });
  });
}

/** The customer's address book: saved entries, falling back to the single legacy address; most recently used first. */
export function addressBook(c: ShopCustomer | null | undefined): SavedAddress[] {
  if (!c) return [];
  const book = (c.addresses ?? []).filter(a => a.line1 || a.lat != null);
  if (!book.length && c.address && (c.address.line1 || c.address.lat != null)) return [{ id: 'legacy', ...c.address }];
  return [...book].sort((a, b) => (b.last_used_at ?? '').localeCompare(a.last_used_at ?? ''));
}
export const sameAddress = (a: CustomerAddress, b: CustomerAddress) =>
  (a.lat != null && b.lat != null && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs((a.lng ?? 0) - (b.lng ?? 0)) < 1e-4) || (!!a.line1 && (a.line1 ?? '').trim().toLowerCase() === (b.line1 ?? '').trim().toLowerCase());
