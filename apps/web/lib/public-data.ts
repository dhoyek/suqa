import { unstable_cache } from 'next/cache';
import { createClient } from '@supabase/supabase-js';
import type { Category, Product, Shop } from '@suqa/shared';

// Public storefront reads. Everyone sees the same data, so cache it server-side for a few seconds instead of
// hitting the database on every visit. Uses the anon key (no cookies) — RLS still applies (active shops/products only).
const anon = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { db: { schema: 'suqa' }, auth: { persistSession: false } });

export const getHomeData = unstable_cache(async (tenantId: string) => {
  const sb = anon();
  const [{ data: cats }, { data: shops }] = await Promise.all([
    sb.from('categories').select('id,name').eq('tenant_id', tenantId).order('sort_order'),
    sb.from('shops').select('id,slug,name,description,category_id,min_order_usd,opening_hours,is_open_override,logo_url').eq('tenant_id', tenantId).eq('status', 'active').order('sort_order'),
  ]);
  return { cats: (cats as Category[] | null) ?? [], shops: (shops as Shop[] | null) ?? [] };
}, ['home-data'], { revalidate: 60, tags: ['home'] });

/** Shop + its active products in one round-trip. Cached briefly; a merchant's availability toggle shows within ~15 s. */
export const getShopWithProducts = unstable_cache(async (tenantId: string, slug: string) => {
  const sb = anon();
  const { data } = await sb.from('shops').select('*, products(*)').eq('tenant_id', tenantId).eq('slug', slug).eq('status', 'active')
    .eq('products.is_active', true).order('section', { referencedTable: 'products', ascending: true, nullsFirst: false }).order('sort_order', { referencedTable: 'products' }).maybeSingle();
  if (!data) return null;
  const { products, ...shop } = data as Shop & { products: Product[] };
  return { shop: shop as Shop, products: products ?? [] };
}, ['shop-page'], { revalidate: 15, tags: ['shop'] });
