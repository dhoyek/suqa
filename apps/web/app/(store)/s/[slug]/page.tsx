import { getLocale } from '@/lib/locale';
import { notFound } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { getShopWithProducts, getShopFeeRange } from '@/lib/public-data';
import { ui } from '@/lib/ui-text';
import { isOpenNow, reopenLabel } from '@/lib/hours';
import { t as tr } from '@suqa/shared';
import ShopMenu from './ShopMenu';
import { waLink, telLink } from '@/lib/whatsapp';
import FavoriteButton from '@/components/FavoriteButton';
import ShareButton from '@/components/ShareButton';

export const dynamic = 'force-dynamic';

export default async function ShopPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await getTenant();
  const res = await getShopWithProducts(tenant.id, slug, tenant.fx_lbp_rate);
  if (!res) notFound();
  const { shop: s, products } = res;
  const L = await getLocale(tenant);
  const open = isOpenNow(s.opening_hours, s.is_open_override, tenant.timezone);
  const reopen = open ? null : reopenLabel(s.opening_hours, s.is_open_override, tenant.timezone, L);
  const fee = await getShopFeeRange(s.id);
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const ar = L === 'ar';
  const wa = waLink(s.whatsapp ?? s.phone, `${ui('waHello', L)} ${tr(s.name, L)} 👋`);
  const tel = telLink(s.phone ?? s.whatsapp);

  return (
    <>
      <header style={{ marginBottom: 12 }}>
        {s.cover_url && <img className="shop-cover" src={s.cover_url} alt="" />}
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          {s.logo_url && <img className="shop-logo" src={s.logo_url} alt="" />}
          <h1 style={{ margin: '4px 0', fontSize: 22, flex: 1 }}>{tr(s.name, L)}</h1>
          <ShareButton path={`/s/${s.slug}`} locale={L === 'ar' ? 'ar' : 'en'} iconOnly className="btn ghost" label={L === 'ar' ? 'مشاركة المتجر' : 'Share this shop'}
            text={L === 'ar' ? `اطلب من ${tr(s.name, L)} عبر ${tenant.brand_name}` : `Order from ${tr(s.name, L)} on ${tenant.brand_name}`} />
          <FavoriteButton shopId={s.id} tenantId={tenant.id} labels={{ add: ui('addFavorite', L), remove: ui('removeFavorite', L) }} />
        </div>
        <div className="muted" style={{ fontSize: 14 }}>{tr(s.description, L)}</div>
        <div className="row" style={{ fontSize: 13, marginTop: 6 }}>
          <span className={`dot ${open ? 'on' : ''}`} /> {open ? ui('openNow', L) : ui('closedNow', L)}
          {reopen && <strong>· {ar ? 'يفتح' : 'Opens'} {reopen}</strong>}
          {s.min_order_usd > 0 && <span className="muted">· {ui('minOrder', L)} ${Number(s.min_order_usd).toFixed(2)}</span>}
          {s.address_text && <span className="muted">· {s.address_text}</span>}
        </div>
        {/* what a customer wants to know before ordering: delivery, how to pay, pickup */}
        <div className="trust-line">
          {fee && <span>🛵 {ar ? 'التوصيل' : 'Delivery'} {fee.min === fee.max ? (fee.min === 0 ? (ar ? 'مجاني' : 'free') : usd(fee.min)) : `${usd(fee.min)} – ${usd(fee.max)}`}{fee.min !== fee.max ? <span className="muted"> {ar ? 'حسب المنطقة' : 'by area'}</span> : null}</span>}
          <span>💵 {ar ? 'الدفع نقداً عند الاستلام' : 'Pay cash on delivery'}</span>
          {s.pickup_enabled !== false && <span>🛍️ {ar ? 'الاستلام من المحل متاح' : 'Pickup available'}</span>}
        </div>
        {(wa || tel) && (
          <div className="row" style={{ marginTop: 10 }}>
            {wa && <a className="btn wa" href={wa} target="_blank" rel="noopener noreferrer">💬 {ui('chatWhatsapp', L)}</a>}
            {tel && <a className="btn" href={tel}>📞 {ui('call', L)}</a>}
          </div>
        )}
      </header>
      <ShopMenu shop={{ id: s.id, slug: s.slug, name: s.name, min_order_usd: Number(s.min_order_usd), whatsapp: s.whatsapp ?? s.phone, pickup_enabled: s.pickup_enabled !== false, section_names: (s as unknown as { section_names?: Record<string, { ar?: string; en?: string }> | null }).section_names ?? null }}
        products={products} locale={L} fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency}
        labels={{ add: ui('add', L), soldOut: ui('soldOut', L), replaceCart: ui('replaceCart', L), cart: ui('cart', L), checkout: ui('checkout', L), items: ui('items', L),
          askOnWhatsapp: ui('askOnWhatsapp', L), waHello: ui('waHello', L), waAskItem: ui('waAskItem', L), waFrom: ui('waFrom', L), searchItems: ui('searchItems', L), noMatches: ui('noMatches', L), all: ui('all', L), categories: ui('categories', L), clearFilter: ui('clearFilter', L), typeToFilter: ui('typeToFilter', L), showMore: ui('showMore', L), ok: ui('okBtn', L) }} />
    </>
  );
}
