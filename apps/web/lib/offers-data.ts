// Every shop's offers, for the all-shops Offers page and the home page's button (130 / 131). Public key, cached briefly.
import { unstable_cache } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import { sortOffers, type Offer, type OfferProduct } from '@suqa/pos-core';
import { getHomeData, getShopRates } from '@/lib/public-data';
import { rateOf } from '@/lib/shop-money';
import { offerVMs } from '@/lib/offer-view';

const anon = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { db: { schema: 'suqa' }, auth: { persistSession: false } });
export type OfferItemRow = OfferProduct & { shop_id: string; unit?: string | null; unit_kind?: string | null; decimal_qty?: boolean };

/** Active offers of the association's active shops, with the items they are made of. Empty where the offers tables do not exist yet. */
export const getTenantOffers = unstable_cache(async (tenantId: string): Promise<{ offers: Offer[]; products: OfferItemRow[] }> => {
  const sb = anon();
  try {
    const { data, error } = await sb.from('offers').select('*, items:offer_items(product_id, quantity, sort_order)').eq('tenant_id', tenantId).eq('is_active', true).order('sort_order').limit(300);
    if (error || !data?.length) return { offers: [], products: [] };
    const offers = sortOffers(data as unknown as Offer[]);
    const ids = [...new Set(offers.flatMap(o => o.items.map(i => i.product_id)))];
    const products: OfferItemRow[] = [];
    for (let i = 0; i < ids.length; i += 150) {
      const { data: rows } = await sb.from('products').select('id,shop_id,name,unit,unit_kind,decimal_qty,image_url,price_currency,price_usd,price_lbp,is_active,is_available,available_days,visible_online,track_stock,on_hand,reserved').in('id', ids.slice(i, i + 150));
      for (const r of (rows ?? []) as unknown as (OfferItemRow & { visible_online?: boolean; track_stock?: boolean; on_hand?: number | string; reserved?: number | string })[]) {
        // as on the shop page: an item hidden online is not there; a tracked item with nothing free is not available
        if (r.visible_online === false) continue;
        const free = r.track_stock ? Math.max(0, Number(r.on_hand ?? 0) - Number(r.reserved ?? 0)) : null;
        products.push({ ...r, is_available: r.is_available !== false && (free == null || free > 0) });
      }
    }
    return { offers, products };
  } catch { return { offers: [], products: [] }; }
}, ['tenant-offers'], { revalidate: 30, tags: ['shop'] });

/** how many offers a visitor would see right now (the number on the home page's button) */
export async function countTenantOffers(tenantId: string, fx: number | string | null | undefined): Promise<number> {
  const [{ offers, products }, rates, home] = await Promise.all([getTenantOffers(tenantId), getShopRates(tenantId), getHomeData(tenantId)]);
  if (!offers.length) return 0;
  const byId = new Map(products.map(p => [p.id, p])); const active = new Set(home.shops.map(s => s.id)); const now = new Date(); let n = 0;
  for (const shopId of new Set(offers.map(o => o.shop_id))) {
    if (!active.has(shopId)) continue;
    n += offerVMs(offers.filter(o => o.shop_id === shopId), id => byId.get(id), rateOf(rates, shopId, fx), now).filter(v => v.ok).length;
  }
  return n;
}
