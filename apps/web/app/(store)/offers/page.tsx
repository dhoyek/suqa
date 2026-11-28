import { getLocale } from '@/lib/locale';
import { getTenant } from '@/lib/tenant';
import { getHomeData, getShopRates } from '@/lib/public-data';
import { getTenantOffers } from '@/lib/offers-data';
import { isOpenNow } from '@/lib/hours';
import { ui } from '@/lib/ui-text';
import OffersBoard from './OffersBoard';

export const dynamic = 'force-dynamic';

// Every shop's offers on one page: bundles and price offers, by shop category. Ordering still happens per shop (the basket is per shop).
export default async function OffersPage() {
  const tenant = await getTenant();
  const L = await getLocale(tenant);
  const [{ cats, shops }, { offers, products }, rates] = await Promise.all([getHomeData(tenant.id), getTenantOffers(tenant.id), getShopRates(tenant.id)]);
  const ar = L === 'ar';
  const cards = shops.map(s => ({ id: s.id, slug: s.slug, name: s.name, category_id: s.category_id, min_order_usd: Number(s.min_order_usd ?? 0), open: isOpenNow(s.opening_hours, s.is_open_override, tenant.timezone) }));
  return (
    <>
      <OffersBoard locale={L} fx={Number(tenant.fx_lbp_rate)} rates={rates} displayCurrency={tenant.display_currency} cats={cats.map(c => ({ id: c.id, name: c.name }))} shops={cards} offers={offers} products={products}
        labels={{ add: ui('add', L), replaceCart: ui('replaceCart', L), all: ui('all', L), shops: ar ? 'فلترة حسب المتجر' : 'Filter by shop', clearFilter: ui('clearFilter', L), typeToFilter: ui('typeToFilter', L), ok: ui('okBtn', L) }} />
    </>
  );
}
