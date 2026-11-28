// Offers (script 130) — step 1: bundles. A bundle is a named set of the shop's items sold together for one price.
// The same arithmetic as the database (suqa._bundle_lines): the till and the shop page must show what the server charges.
import type { Localized } from './types';

export interface OfferItem { offer_id?: string; product_id: string; quantity: number | string; sort_order?: number | null }
export interface Offer {
  id: string; shop_id: string; kind: 'bundle' | 'discount' | 'bxgy'; name: Localized; description?: Localized | null; image_url?: string | null;
  price_currency: 'usd' | 'lbp'; price_usd: number | string; price_lbp: number | string;
  is_active: boolean; is_hot: boolean; starts_at?: string | null; ends_at?: string | null; max_per_order?: number | null; sort_order?: number | null;
  items: OfferItem[];
}
/** what a bundle needs to know about an item */
export interface OfferProduct { id: string; name: Localized; unit?: string | null; image_url?: string | null; price_currency?: 'usd' | 'lbp' | null; price_usd: number | string; price_lbp?: number | string | null; is_active?: boolean; is_available?: boolean; available_days?: number[] | null }

const n = (v: unknown) => Number(v) || 0;

/**
 * The unit price of each line inside a bundle. `price` and the lines' normal unit prices `u` are whole numbers in the same
 * smallest unit (dollar cents, or lira); `q` are whole quantities.
 *   unit_i = floor(u_i × price / Σ u×q); what is left of the price goes onto the lines it divides into — smallest quantity
 *   first, never lifting an item above its normal price. Charged = Σ unit×q: the price, or a hair under it when no line can
 *   take the remainder. `step` (the till's lira lines: 1,000) keeps the unit prices round when a line can absorb the rest.
 */
export function bundleAlloc(price: number, lines: Array<{ u: number; q: number }>, step = 1): { units: number[]; charged: number; normal: number } {
  const normal = lines.reduce((s, l) => s + l.u * l.q, 0);
  if (!(price > 0) || !(normal > 0) || price >= normal) return { units: lines.map(l => l.u), charged: normal, normal };
  const run = (st: number) => {
    const units = lines.map(l => Math.floor(Math.floor((l.u * price) / normal) / st) * st);
    let rem = price - units.reduce((s, u, i) => s + u * lines[i].q, 0);
    const order = lines.map((_, i) => i).sort((a, b) => lines[a].q - lines[b].q || a - b);
    for (const i of order) { if (rem <= 0) break; const k = Math.min(Math.floor(rem / lines[i].q), lines[i].u - units[i]); if (k > 0) { units[i] += k; rem -= k * lines[i].q; } }
    return { units, rem };
  };
  let r = run(step > 1 ? step : 1);
  if (step > 1 && r.rem > 0) r = run(1);                 // round unit prices only when nothing is lost by it
  return { units: r.units, charged: price - r.rem, normal };
}

export interface BundleLine<P extends OfferProduct = OfferProduct> { product: P; quantity: number; /** price of one inside the bundle */ unit: number; /** its normal price */ normal: number }
export interface BundleView<P extends OfferProduct = OfferProduct> {
  offer: Offer; ok: boolean; /** why it cannot be sold now */ why?: 'off' | 'not_yet' | 'ended' | 'item' | 'currency' | 'no_saving' | 'empty';
  /** 'cents' (the shop page and online orders) or the bundle's own currency (the till) */ unit: 'cents' | 'lbp';
  lines: BundleLine<P>[]; normal: number; charged: number; saving: number; pct: number;
}
/**
 * A bundle as it is shown and sold. mode 'online' = dollar cents at the shop's rate `fx` (what the server charges for an online
 * order); mode 'till' = the bundle's own currency (lira for a lira bundle), so a lira bundle sells for its exact lira at the till.
 * `day` (0 = Sunday) checks items sold on some weekdays only.
 */
export function bundleView<P extends OfferProduct>(offer: Offer, byId: (id: string) => P | undefined, fx: number, mode: 'online' | 'till', now = new Date(), day?: number): BundleView<P> {
  const lbp = mode === 'till' && offer.price_currency === 'lbp';
  const unitOf = (p: P) => lbp ? Math.round(n(p.price_lbp)) : p.price_currency === 'lbp' && n(p.price_lbp) > 0 && fx > 0 ? Math.round((Math.round((n(p.price_lbp) / fx) * 100) / 100) * 100) : Math.round(n(p.price_usd) * 100);
  const price = lbp ? Math.round(n(offer.price_lbp)) : offer.price_currency === 'lbp' ? (fx > 0 ? Math.round((n(offer.price_lbp) * 100) / fx) : 0) : Math.round(n(offer.price_usd) * 100);
  const items = [...(offer.items ?? [])].sort((a, b) => n(a.sort_order) - n(b.sort_order) || (String(a.product_id) < String(b.product_id) ? -1 : 1));
  const found = items.map(it => ({ it, p: byId(it.product_id) }));
  let why: BundleView['why'];
  if (!offer.is_active) why = 'off';
  else if (offer.starts_at && new Date(offer.starts_at) > now) why = 'not_yet';
  else if (offer.ends_at && new Date(offer.ends_at) <= now) why = 'ended';
  else if (!items.length) why = 'empty';
  else if (found.some(f => !f.p || f.p.is_active === false || f.p.is_available === false || (day != null && f.p.available_days != null && !f.p.available_days.includes(day)))) why = 'item';
  else if (found.some(f => (f.p!.price_currency ?? 'usd') !== offer.price_currency)) why = 'currency';
  const known = found.filter(f => f.p) as Array<{ it: OfferItem; p: P }>;
  const a = bundleAlloc(price, known.map(f => ({ u: unitOf(f.p), q: Math.round(n(f.it.quantity)) })), lbp ? 1000 : 1);
  if (!why && !(a.charged < a.normal)) why = 'no_saving';
  const lines = known.map((f, i) => ({ product: f.p, quantity: Math.round(n(f.it.quantity)), unit: a.units[i], normal: unitOf(f.p) }));
  const saving = Math.max(0, a.normal - a.charged);
  return { offer, ok: !why, why, unit: lbp ? 'lbp' : 'cents', lines, normal: a.normal, charged: why === 'currency' || why === 'no_saving' ? price : a.charged, saving, pct: a.normal > 0 ? Math.round((saving * 100) / a.normal) : 0 };
}
/** the note a bundle's lines carry on an order ("🎁 name") — how the till, the board and the receipt tell them apart */
export const bundleNote = (o: Pick<Offer, 'name'>) => `🎁 ${o.name?.ar || o.name?.en || ''}`.slice(0, 200);
/** offers in the order they are shown: hot first, then the shop's own order */
export const sortOffers = <T extends Pick<Offer, 'is_hot' | 'sort_order'>>(list: T[]): T[] => [...list].sort((a, b) => Number(b.is_hot) - Number(a.is_hot) || n(a.sort_order) - n(b.sort_order));

// ── a price offer on one item (kind 'discount', script 131) ────────────────────────────────────────────────────────────
export interface SaleView<P extends OfferProduct = OfferProduct> {
  offer: Offer; product: P | undefined; ok: boolean; why?: BundleView['why'];
  /** 'cents' online; the item's own currency at the till */ unit: 'cents' | 'lbp';
  /** the item's normal price and its offer price, for one */ normal: number; price: number; saving: number; pct: number;
  /** the offer's lira as the shop typed it, for a lira offer (shown as it is) */ lbp: number | null; normalLbp: number | null;
}
/** A price offer as it is shown and charged — the same rule as the database's `_sale_offer`. */
export function saleView<P extends OfferProduct>(offer: Offer, byId: (id: string) => P | undefined, fx: number, mode: 'online' | 'till', now = new Date(), day?: number): SaleView<P> {
  const p = byId(offer.items?.[0]?.product_id ?? '');
  const lira = offer.price_currency === 'lbp'; const native = mode === 'till' && lira;
  const usdCents = (lbp: number) => (fx > 0 ? Math.round((Math.round((lbp / fx) * 100) / 100) * 100) : 0);
  const normal = !p ? 0 : native ? Math.round(n(p.price_lbp)) : p.price_currency === 'lbp' && n(p.price_lbp) > 0 ? usdCents(n(p.price_lbp)) : Math.round(n(p.price_usd) * 100);
  const price = native ? Math.round(n(offer.price_lbp)) : lira ? usdCents(n(offer.price_lbp)) : Math.round(n(offer.price_usd) * 100);
  let why: BundleView['why'];
  if (!offer.is_active) why = 'off';
  else if (offer.starts_at && new Date(offer.starts_at) > now) why = 'not_yet';
  else if (offer.ends_at && new Date(offer.ends_at) <= now) why = 'ended';
  else if (!p) why = 'empty';
  else if (p.is_active === false || p.is_available === false || (day != null && p.available_days != null && !p.available_days.includes(day))) why = 'item';
  else if ((p.price_currency ?? 'usd') !== offer.price_currency) why = 'currency';
  else if (lira ? !(n(offer.price_lbp) > 0 && n(offer.price_lbp) < n(p.price_lbp)) : !(n(offer.price_usd) > 0 && n(offer.price_usd) < n(p.price_usd))) why = 'no_saving';
  const saving = Math.max(0, normal - price);
  return { offer, product: p, ok: !why, why, unit: native ? 'lbp' : 'cents', normal, price, saving, pct: normal > 0 ? Math.round((saving * 100) / normal) : 0,
    lbp: lira ? Math.round(n(offer.price_lbp)) : null, normalLbp: p && p.price_currency === 'lbp' && n(p.price_lbp) > 0 ? Math.round(n(p.price_lbp)) : null };
}
/** the running price offer of each item (the cheapest when an item has several) */
export function salesByProduct<P extends OfferProduct>(offers: Offer[], byId: (id: string) => P | undefined, fx: number, mode: 'online' | 'till', now = new Date(), day?: number): Map<string, SaleView<P>> {
  const out = new Map<string, SaleView<P>>();
  for (const o of offers) {
    if (o.kind !== 'discount') continue;
    const v = saleView(o, byId, fx, mode, now, day); if (!v.ok || !v.product) continue;
    const cur = out.get(v.product.id); if (!cur || v.price < cur.price) out.set(v.product.id, v);
  }
  return out;
}
/** the note a line sold at an offer price carries ("🏷 name") */
export const saleNote = (o: Pick<Offer, 'name'>) => `🏷 ${o.name?.ar || o.name?.en || ''}`.slice(0, 200);
