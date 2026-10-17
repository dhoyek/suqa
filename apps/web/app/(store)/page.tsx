import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { ui } from '@/lib/ui-text';
import { isOpenNow } from '@/lib/hours';
import type { Shop, Category } from '@suqa/shared';
import ShopGrid from './ShopGrid';

export const dynamic = 'force-dynamic';

// Storefront home: categories + active shops of the current tenant. Filtering happens client-side (ShopGrid).
export default async function Home({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const [{ data: cats }, { data: shops }] = await Promise.all([
    sb.from('categories').select('id,name').eq('tenant_id', tenant.id).order('sort_order'),
    sb.from('shops').select('id,slug,name,description,category_id,min_order_usd,opening_hours,is_open_override,logo_url').eq('tenant_id', tenant.id).eq('status', 'active').order('sort_order'),
  ]);
  const L = tenant.default_locale;
  const cards = ((shops as Shop[] | null) ?? []).map(s => ({
    id: s.id, slug: s.slug, name: s.name, description: s.description, category_id: s.category_id, min_order_usd: Number(s.min_order_usd), logo_url: s.logo_url ?? null,
    open: isOpenNow(s.opening_hours, s.is_open_override, tenant.timezone),
  }));
  return <ShopGrid cats={(cats as Category[] | null) ?? []} shops={cards} initial={c ?? null} locale={L}
    labels={{ all: ui('shops', L), minOrder: ui('minOrder', L), empty: ui('noShopsInCategory', L) }} />;
}
