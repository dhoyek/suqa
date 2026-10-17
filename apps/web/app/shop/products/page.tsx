import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { currentShop } from '@/lib/current-shop';
import { ui } from '@/lib/ui-text';
import { t as tr, type Product } from '@suqa/shared';
import ProductList from './ProductList';

export const dynamic = 'force-dynamic';

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const sp = await searchParams;
  const tenant = await getTenant();
  const shop = await currentShop(sp);
  if (!shop) return null;
  const L = tenant.default_locale;
  const sb = await supabaseServer();
  const { data } = await sb.from('products').select('*').eq('shop_id', shop.id).eq('is_active', true)
    .order('section', { ascending: true, nullsFirst: false }).order('sort_order');

  const labels = {
    available: ui('available', L), unavailable: ui('unavailable', L), addProduct: ui('addProduct', L), editProduct: ui('editProduct', L),
    nameEn: ui('nameEn', L), nameAr: ui('nameAr', L), priceUsd: ui('priceUsd', L), unit: ui('unit', L), section: ui('section', L),
    save: ui('save', L), cancel: ui('cancel', L), remove: ui('remove', L),
    photo: ui('photo', L), changePhoto: ui('changePhoto', L), descAr: ui('descAr', L), descEn: ui('descEn', L),
  };

  return (
    <>
      <div className="row spread" style={{ marginBottom: 10 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{tr(shop.name, L)} — {ui('products', L)}</h1>
      </div>
      <ProductList key={shop.id} shopId={shop.id} tenantId={tenant.id} initial={(data as Product[]) ?? []} locale={L}
        fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency} labels={labels} />
    </>
  );
}
