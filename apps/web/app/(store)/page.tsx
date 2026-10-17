import { getTenant } from '@/lib/tenant';
import { getHomeData } from '@/lib/public-data';
import { ui } from '@/lib/ui-text';
import { isOpenNow } from '@/lib/hours';
import ShopGrid from './ShopGrid';

export const dynamic = 'force-dynamic';

// Storefront home: categories + active shops of the current tenant. Filtering happens client-side (ShopGrid).
export default async function Home({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  const tenant = await getTenant();
  const { cats, shops } = await getHomeData(tenant.id);
  const L = tenant.default_locale;
  const cards = shops.map(s => ({
    id: s.id, slug: s.slug, name: s.name, description: s.description, category_id: s.category_id, min_order_usd: Number(s.min_order_usd), logo_url: s.logo_url ?? null,
    open: isOpenNow(s.opening_hours, s.is_open_override, tenant.timezone),
  }));
  return <ShopGrid cats={cats} shops={cards} initial={c ?? null} locale={L}
    labels={{ all: ui('shops', L), minOrder: ui('minOrder', L), empty: ui('noShopsInCategory', L) }} />;
}
