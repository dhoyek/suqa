// The shop's offers on the till (script 130). Read from the server when online and kept on the device, so bundles can be
// sold offline; creating and changing them is the owner's, online (offer_save / offer_delete).
import type { SupabaseClient } from '@supabase/supabase-js';
import { addToDraft, bundleNote, bundleView, lbpToCents, lineFromProduct, saleNote, salesByProduct, saleView, sortOffers, type BundleView, type CatalogIndex, type Draft, type DraftLine, type Offer, type Product, type SaleView } from '@suqa/pos-core';

const key = (shopId: string) => `suqa-pos-offers:${shopId}`;
export function cachedOffers(shopId: string): Offer[] { try { const v = JSON.parse(localStorage.getItem(key(shopId)) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
/** null = could not be read (offline, or the offers are not switched on yet): the device's copy stays */
export async function fetchOffers(sb: SupabaseClient, shopId: string): Promise<Offer[] | null> {
  try {
    const { data, error } = await sb.from('offers').select('*, items:offer_items(product_id, quantity, sort_order)').eq('shop_id', shopId).order('sort_order');
    if (error || !data) return null;
    const list = sortOffers(data as unknown as Offer[]);
    try { localStorage.setItem(key(shopId), JSON.stringify(list)); } catch {}
    return list;
  } catch { return null; }
}
/** a bundle as the till sells it: in its own currency (a lira bundle for its exact lira) */
export const tillBundle = (o: Offer, index: CatalogIndex, rate: number, at = new Date()): BundleView<Product> => bundleView<Product>(o, id => index.byId.get(id), rate, 'till', at, at.getDay());
/** the cart lines of `n` bundles: its items at their price inside the bundle, marked with the bundle's name */
export function bundleDraftLines(v: BundleView<Product>, n: number, rate: number): DraftLine[] {
  const note = bundleNote(v.offer);
  return v.lines.map(l => ({ ...lineFromProduct(l.product, l.quantity * n),
    ...(v.unit === 'lbp' ? { price_currency: 'lbp' as const, unit_price_lbp: l.unit, unit_price_cents: lbpToCents(l.unit, rate) } : { price_currency: 'usd' as const, unit_price_cents: l.unit, unit_price_lbp: 0 }),
    notes: note }));
}

// ── price offers (131): an item with a running offer is sold at the offer price, in its own currency ──────────────────
export const tillSale = (o: Offer, index: CatalogIndex, rate: number, at = new Date()): SaleView<Product> => saleView<Product>(o, id => index.byId.get(id), rate, 'till', at, at.getDay());
export const tillSales = (offers: Offer[], index: CatalogIndex, rate: number, at = new Date()): Map<string, SaleView<Product>> => salesByProduct<Product>(offers, id => index.byId.get(id), rate, 'till', at, at.getDay());
/** a cart line of an item at its offer price, marked with the offer's name */
export function saleDraftLine(p: Product, quantity: number, v: SaleView<Product>, rate: number): DraftLine {
  return { ...lineFromProduct(p, quantity),
    ...(v.unit === 'lbp' ? { price_currency: 'lbp' as const, unit_price_lbp: v.price, unit_price_cents: lbpToCents(v.price, rate) } : { price_currency: 'usd' as const, unit_price_cents: v.price, unit_price_lbp: 0 }),
    notes: saleNote(v.offer) };
}
/** add an item to the cart: at its offer price when one is running (same line grows), else as always */
export function addWithSale(d: Draft, p: Product, quantity: number, v: SaleView<Product> | undefined, rate: number): Draft {
  if (!v) return addToDraft(d, p, quantity);
  const line = saleDraftLine(p, quantity, v, rate);
  const i = d.lines.findIndex(l => l.product_id === p.id && !l.voided && !l.discount_cents && l.notes === line.notes && l.price_currency === line.price_currency && l.unit_price_cents === line.unit_price_cents && l.unit_price_lbp === line.unit_price_lbp);
  if (i >= 0) { const lines = d.lines.slice(); lines[i] = { ...lines[i], quantity: Math.round((lines[i].quantity + quantity) * 1000) / 1000 }; return { ...d, lines }; }
  return { ...d, lines: [...d.lines, line] };
}
