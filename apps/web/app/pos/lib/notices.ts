import type { Order } from '@suqa/pos-core';

/**
 * The till's own list of what came in (the 🔔 in the top bar). Built on the device from the orders it already syncs — no table:
 * a new order waiting, a driver's confirmation / pick-up / delivery, a pickup customer on his way. Kept per shop in localStorage
 * (last 60), so it is this device's list. Things older than two days are never added.
 */
export type NoticeKind = 'new' | 'ack' | 'picked' | 'delivered' | 'coming';
export type Notice = { key: string; kind: NoticeKind; order_id: string; number: string; who: string; at: string; read: boolean };
type Store = { known: string[]; items: Notice[] };

const KEY = (shop: string) => `suqa-pos-notices:${shop}`;
const MAX = 60, FRESH_MS = 48 * 3600_000;

export function loadNotices(shop: string): Store | null {
  try { const v = JSON.parse(localStorage.getItem(KEY(shop)) || 'null') as Store | null; return v && Array.isArray(v.known) && Array.isArray(v.items) ? v : null; } catch { return null; }
}
function save(shop: string, s: Store) { try { localStorage.setItem(KEY(shop), JSON.stringify({ known: s.known.slice(-600), items: s.items.slice(0, MAX) })); } catch { /* storage full or blocked: the list just does not persist */ } }

/** What the orders on the till say happened, as notice candidates. */
export function noticesOf(orders: Order[]): Omit<Notice, 'read'>[] {
  const out: Omit<Notice, 'read'>[] = [];
  for (const o of orders) {
    if (o.channel === 'walkin' || o.parked) continue;
    const number = o.number ?? o.local_number ?? ''; const drv = o.courier_name ?? '';
    const add = (kind: NoticeKind, at: string | null | undefined, who: string) => { if (at) out.push({ key: `${kind}:${o.id}`, kind, order_id: o.id, number, who, at }); };
    if (o.status === 'pending') add('new', o.placed_at, o.customer_name ?? '');
    add('ack', o.driver_ack_at, drv); add('picked', o.driver_picked_at, drv); add('delivered', o.driver_delivered_at, drv);
    add('coming', o.customer_coming_at, o.customer_name ?? '');
  }
  return out;
}

/** Merge what the orders say into the stored list. The first run on a device only remembers what already happened (nothing shown as new). */
export function syncNotices(shop: string, orders: Order[], now = Date.now()): { store: Store; fresh: Notice[] } {
  const cand = noticesOf(orders); const prev = loadNotices(shop);
  if (!prev) { const store: Store = { known: cand.map(c => c.key), items: [] }; save(shop, store); return { store, fresh: [] }; }
  const known = new Set(prev.known);
  const fresh = cand.filter(c => !known.has(c.key) && now - new Date(c.at).getTime() < FRESH_MS).map(c => ({ ...c, read: false }));
  const newKeys = cand.filter(c => !known.has(c.key)).map(c => c.key);
  if (!newKeys.length) return { store: prev, fresh: [] };
  const store: Store = { known: [...prev.known, ...newKeys], items: [...fresh, ...prev.items].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, MAX) };
  save(shop, store); return { store, fresh };
}

export function markNoticesRead(shop: string): Store | null {
  const s = loadNotices(shop); if (!s) return null;
  const store = { ...s, items: s.items.map(i => ({ ...i, read: true })) }; save(shop, store); return store;
}
