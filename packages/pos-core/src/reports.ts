import type { PosDb } from './db';
import { num } from './types';
import type { Channel, Localized, Tender } from './types';

/** Shape returned by `suqa.pos_report` (server) and by `localReport` (offline fallback from the mirror). */
export interface Report {
  from: string; to: string; rate: number;
  partial?: boolean;                       // local fallback: the mirror only holds ~7 days of closed orders
  totals: { sales_count: number; total_cents: number; items_count: number; discount_cents: number; courier_fees_cents: number; delivery_fees_cents: number; cost_cents: number; purchases_cents?: number; supplier_paid_cents?: number; suppliers_balance_cents?: number; returns_count: number; returns_cents: number };
  by_day: { day: string; count: number; cents: number }[];
  by_channel: Partial<Record<Channel, { count: number; cents: number }>>;
  by_tender: Partial<Record<Tender, { count: number; usd: number; lbp: number }>>;
  by_item: { product_id: string | null; name: Localized; qty: number; cents: number; cost_cents: number }[];
  by_section: { section: string; qty: number; cents: number }[];
  slow: { product_id: string; name: Localized; on_hand: number; cost_cents: number | null }[];
  stock: { skus: number; units: number; cost_cents: number; retail_cents: number; low: number };
  unpaid: { order_id: string; number: string | null; at: string; name: string | null; phone: string | null; amount: number; currency: string }[];
  shifts: { id: string; opened_at: string; closed_at: string | null; device_id: string; expected_usd_cents: number | null; counted_usd_cents: number | null; diff_usd_cents: number | null; expected_lbp: number | null; counted_lbp: number | null; diff_lbp: number | null }[];
}

export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Same report computed from IndexedDB — used when offline. Covers only what the mirror holds (`partial`). */
export async function localReport(db: PosDb, from: string, to: string): Promise<Report> {
  const start = new Date(from + 'T00:00:00'); const end = new Date(to + 'T00:00:00'); end.setDate(end.getDate() + 1);
  const inRange = (iso: string) => { const t = new Date(iso).getTime(); return t >= start.getTime() && t < end.getTime(); };
  const orders = (await db.orders.where('placed_at').between(start.toISOString(), end.toISOString()).toArray()).filter(o => !o.parked && o.status !== 'cancelled' && o.status !== 'rejected');
  const ids = new Set(orders.map(o => o.id));
  const [lines, payments, products, rates, returns, shifts] = await Promise.all([
    db.orderLines.toArray().then(ls => ls.filter(l => ids.has(l.order_id) && !l.voided)),
    db.payments.toArray().then(ps => ps.filter(p => ids.has(p.order_id))),
    db.products.toArray(), db.rates.orderBy('effective_at').reverse().first(),
    db.returns.toArray().then(rs => rs.filter(r => inRange(String(r.at)))),
    db.shifts.toArray().then(ss => ss.filter(s => inRange(s.opened_at))),
  ]);
  const rate = rates?.lbp_per_usd ?? 89500;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const prod = new Map(products.map(p => [p.id, p]));
  const byDay = new Map<string, { count: number; cents: number }>();
  const byChannel: Report['by_channel'] = {}; const byTender: Report['by_tender'] = {};
  for (const o of orders) {
    const k = dayKey(new Date(o.placed_at)); const d = byDay.get(k) ?? { count: 0, cents: 0 }; d.count++; d.cents += num(o.total_cents); byDay.set(k, d);
    const c = (byChannel[o.channel] ??= { count: 0, cents: 0 }); c.count++; c.cents += num(o.total_cents);
  }
  for (const p of payments) { const t = (byTender[p.tender] ??= { count: 0, usd: 0, lbp: 0 }); t.count++; if (p.currency === 'lbp') t.lbp += num(p.amount); else t.usd += num(p.amount); }
  const byItem = new Map<string, Report['by_item'][number]>();
  const bySection = new Map<string, { qty: number; cents: number }>();
  const sold = new Set<string>();
  for (const l of lines) {
    const k = l.product_id ?? `~${JSON.stringify(l.name)}`; const it = byItem.get(k) ?? { product_id: l.product_id, name: l.name, qty: 0, cents: 0, cost_cents: 0 };
    it.qty += num(l.quantity); it.cents += num(l.line_total_cents); it.cost_cents += Math.round(num(l.cost_cents) * num(l.quantity)); byItem.set(k, it);
    if (l.product_id) sold.add(l.product_id);
    const sec = (l.product_id && prod.get(l.product_id)?.section) || ''; const s = bySection.get(sec) ?? { qty: 0, cents: 0 }; s.qty += num(l.quantity); s.cents += num(l.line_total_cents); bySection.set(sec, s);
  }
  const tracked = products.filter(p => p.is_active && p.track_stock);
  return {
    from, to, rate, partial: true,
    totals: {
      sales_count: orders.length, total_cents: sum(orders.map(o => num(o.total_cents))), items_count: sum(lines.map(l => num(l.quantity))),
      discount_cents: sum(orders.map(o => num(o.discount_cents))), courier_fees_cents: sum(orders.map(o => num(o.courier_fee_cents))), delivery_fees_cents: sum(orders.map(o => Math.round(num(o.delivery_fee_usd) * 100))), cost_cents: sum(lines.map(l => Math.round(num(l.cost_cents) * num(l.quantity)))),
      returns_count: returns.length, returns_cents: sum(returns.map(r => num(r.refund_usd_cents as number) + Math.round((num(r.refund_lbp as number) / rate) * 100))),
    },
    by_day: [...byDay].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    by_channel: byChannel, by_tender: byTender,
    by_item: [...byItem.values()].sort((a, b) => b.cents - a.cents).slice(0, 100),
    by_section: [...bySection].map(([section, v]) => ({ section, ...v })).sort((a, b) => b.cents - a.cents),
    slow: tracked.filter(p => num(p.on_hand) > 0 && !sold.has(p.id)).sort((a, b) => num(b.on_hand) - num(a.on_hand)).slice(0, 100).map(p => ({ product_id: p.id, name: p.name, on_hand: num(p.on_hand), cost_cents: p.cost_cents ?? null })),
    stock: {
      skus: tracked.length, units: sum(tracked.map(p => num(p.on_hand))),
      cost_cents: sum(tracked.map(p => Math.round(num(p.cost_cents) * num(p.on_hand)))),
      retail_cents: sum(tracked.map(p => Math.round((p.price_currency === 'usd' ? num(p.price_usd) * 100 : (num(p.price_lbp) / rate) * 100) * num(p.on_hand)))),
      low: tracked.filter(p => num(p.on_hand) <= num(p.min_stock)).length,
    },
    unpaid: payments.filter(p => p.tender === 'unpaid').map(p => { const o = orders.find(x => x.id === p.order_id); return { order_id: p.order_id, number: o?.number ?? o?.local_number ?? null, at: p.at, name: p.unpaid_name ?? null, phone: p.unpaid_phone ?? null, amount: num(p.amount), currency: p.currency }; }).sort((a, b) => b.at.localeCompare(a.at)),
    shifts: shifts.sort((a, b) => b.opened_at.localeCompare(a.opened_at)).map(s => ({ id: s.id, opened_at: s.opened_at, closed_at: s.closed_at ?? null, device_id: s.device_id, expected_usd_cents: s.expected_usd_cents ?? null, counted_usd_cents: s.counted_usd_cents ?? null, diff_usd_cents: s.diff_usd_cents ?? null, expected_lbp: s.expected_lbp ?? null, counted_lbp: s.counted_lbp ?? null, diff_lbp: s.diff_lbp ?? null })),
  };
}
