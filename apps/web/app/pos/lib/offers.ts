// The shop's offers on the till (script 130). Read from the server when online and kept on the device, so bundles can be
// sold offline; creating and changing them is the owner's, online (offer_save / offer_delete).
import type { SupabaseClient } from '@supabase/supabase-js';
import { bundleNote, bundleView, lbpToCents, lineFromProduct, sortOffers, type BundleView, type CatalogIndex, type DraftLine, type Offer, type Product } from '@suqa/pos-core';

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
