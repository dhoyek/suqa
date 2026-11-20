import { usdPrice } from '@/lib/price';
import { unstable_cache } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import type { Category, Product, Shop } from '@suqa/shared';

// Public storefront reads. Everyone sees the same data, so cache it server-side for a few seconds instead of
// hitting the database on every visit. Uses the anon key (no cookies) — RLS still applies (active shops/products only).
const anon = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { db: { schema: 'suqa' }, auth: { persistSession: false } });

export const getHomeData = unstable_cache(async (tenantId: string) => {
  const sb = anon();
  const cols = 'id,slug,name,description,category_id,min_order_usd,opening_hours,is_open_override,logo_url';
  const list = (c: string) => sb.from('shops').select(c).eq('tenant_id', tenantId).eq('status', 'active').order('sort_order');
  const [{ data: cats }, first] = await Promise.all([
    sb.from('categories').select('id,name').eq('tenant_id', tenantId).order('sort_order'),
    list(`${cols},known_as,known_as_en`),
  ]);
  // known_as arrives with schema 69 and known_as_en with 72: a database that does not have them yet still lists its shops
  let shops = first.data;
  if (first.error) { const second = await list(`${cols},known_as`); shops = second.error ? (await list(cols)).data : second.data; }
  return { cats: (cats as Category[] | null) ?? [], shops: (shops as Shop[] | null) ?? [] };
}, ['home-data'], { revalidate: 60, tags: ['home'] });

// The public key may read these item columns only (schema 71): cost, margin and supplier are the shop's own business.
const PRODUCT_COLS = 'id,tenant_id,shop_id,name,description,price_usd,price_currency,price_lbp,unit,unit_kind,decimal_qty,image_url,is_available,is_active,sort_order,section,sku,vat,track_stock,visible_online,on_hand,reserved,available_days,aliases,created_at,updated_at';

/** Shop + its active products in one round-trip. Cached briefly; a merchant's availability toggle shows within ~15 s. */
type Db = ReturnType<typeof anon>;
/** One shop and what its customers see of it. `anyStatus`: also a shop not active yet (the owner's / admin's preview). */
async function loadShop(sb: Db, tenantId: string, slug: string, fx: number | string | null | undefined, anyStatus = false) {
  let q = sb.from('shops').select('*').eq('tenant_id', tenantId).eq('slug', slug);
  if (!anyStatus) q = q.eq('status', 'active');
  const { data } = await q.maybeSingle();
  if (!data) return null;
  const shop = data as Shop & { hide_online_when_zero?: boolean };
  // The database API answers at most 1,000 rows per request: a shop with more items (Dekanet Jadde has 1,159) lost the rest —
  // they were neither shown nor found by the search. Read them page by page.
  type Row = Product & { visible_online?: boolean; track_stock?: boolean; on_hand?: number | string; reserved?: number | string };
  const products: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await sb.from('products').select(PRODUCT_COLS).eq('shop_id', shop.id).eq('is_active', true)
      .order('section', { ascending: true, nullsFirst: false }).order('sort_order').order('id').range(from, from + 999);
    if (error) throw error;
    products.push(...((page ?? []) as unknown as Row[]));
    if (!page || page.length < 1000) break;
  }
  // POS stock (21_pos): tracked items show live availability (on hand − reserved); the shop may hide items at zero.
  // a lira-priced item is shown and charged at its own lira price (lib/price.ts)
  const list = (products ?? []).filter(p => p.visible_online !== false).map(p => ({ ...p, price_usd: usdPrice(p, fx) })).map(p => {
    if (!p.track_stock) return { ...p, available: null as number | null };
    const available = Math.max(0, Number(p.on_hand ?? 0) - Number(p.reserved ?? 0));
    return { ...p, available, is_available: p.is_available && available > 0 };
  }).filter(p => !(shop.hide_online_when_zero && p.available === 0));
  return { shop: shop as Shop, products: list };
}

export const getShopWithProducts = unstable_cache(async (tenantId: string, slug: string, fx?: number | string | null) => loadShop(anon(), tenantId, slug, fx),
  ['shop-page'], { revalidate: 15, tags: ['shop'] });

/** Preview of a shop that is not active (pending / suspended…): only for the association's admins and the shop's own staff.
 *  Read with the service key (the public key cannot see an inactive shop), never cached, and only after the caller is checked. */
export async function getShopPreview(admin: Db, tenantId: string, slug: string, fx: number | string | null | undefined, userId: string) {
  const res = await loadShop(admin, tenantId, slug, fx, true);
  if (!res) return null;
  const [{ data: tm }, { data: sm }] = await Promise.all([
    admin.from('tenant_members').select('user_id').eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle(),
    admin.from('shop_members').select('user_id').eq('shop_id', res.shop.id).eq('user_id', userId).maybeSingle(),
  ]);
  return tm || sm ? res : null;
}

/** Lowest and highest delivery fee among the zones a shop serves (its own fee for a zone replaces the zone's). null = no zones. */
export const getShopFeeRange = unstable_cache(async (shopId: string): Promise<{ min: number; max: number } | null> => {
  const { data } = await anon().from('shop_delivery_zones').select('fee_usd, zone:delivery_zones(fee_usd, is_active)').eq('shop_id', shopId);
  const fees = ((data as unknown as { fee_usd: number | string | null; zone: { fee_usd: number | string; is_active: boolean } | null }[] | null) ?? [])
    .filter(r => r.zone?.is_active !== false).map(r => Number(r.fee_usd ?? r.zone?.fee_usd ?? 0)).filter(n => Number.isFinite(n));
  return fees.length ? { min: Math.min(...fees), max: Math.max(...fees) } : null;
}, ['shop-fee-range'], { revalidate: 300 });

/** The shared item categories (87): key → names and order. Empty when the table is not there yet. */
export const getItemCategories = unstable_cache(async (tenantId: string): Promise<{ key: string; name: { ar?: string; en?: string }; sort_order: number }[]> => {
  const { data, error } = await anon().from('item_categories').select('key,name,sort_order').eq('tenant_id', tenantId).order('sort_order').order('key');
  return error ? [] : ((data as { key: string; name: { ar?: string; en?: string }; sort_order: number }[] | null) ?? []);
}, ['item-categories'], { revalidate: 60, tags: ['item-categories'] });
