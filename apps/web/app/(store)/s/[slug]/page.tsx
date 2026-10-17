import { notFound } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { getShopWithProducts } from '@/lib/public-data';
import { ui } from '@/lib/ui-text';
import { isOpenNow } from '@/lib/hours';
import { t as tr } from '@suqa/shared';
import ShopMenu from './ShopMenu';
import { waLink, telLink } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';

export default async function ShopPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await getTenant();
  const res = await getShopWithProducts(tenant.id, slug);
  if (!res) notFound();
  const { shop: s, products } = res;
  const L = tenant.default_locale;
  const open = isOpenNow(s.opening_hours, s.is_open_override, tenant.timezone);
  const wa = waLink(s.whatsapp ?? s.phone, `${ui('waHello', L)} ${tr(s.name, L)} 👋`);
  const tel = telLink(s.phone ?? s.whatsapp);

  return (
    <>
      <header style={{ marginBottom: 12 }}>
        {s.cover_url && <img className="shop-cover" src={s.cover_url} alt="" />}
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          {s.logo_url && <img className="shop-logo" src={s.logo_url} alt="" />}
          <h1 style={{ margin: '4px 0', fontSize: 22 }}>{tr(s.name, L)}</h1>
        </div>
        <div className="muted" style={{ fontSize: 14 }}>{tr(s.description, L)}</div>
        <div className="row" style={{ fontSize: 13, marginTop: 6 }}>
          <span className={`dot ${open ? 'on' : ''}`} /> {open ? ui('openNow', L) : ui('closedNow', L)}
          {s.min_order_usd > 0 && <span className="muted">· {ui('minOrder', L)} ${Number(s.min_order_usd).toFixed(2)}</span>}
          {s.address_text && <span className="muted">· {s.address_text}</span>}
        </div>
        {(wa || tel) && (
          <div className="row" style={{ marginTop: 10 }}>
            {wa && <a className="btn wa" href={wa} target="_blank" rel="noopener noreferrer">💬 {ui('chatWhatsapp', L)}</a>}
            {tel && <a className="btn" href={tel}>📞 {ui('call', L)}</a>}
          </div>
        )}
      </header>
      <ShopMenu shop={{ id: s.id, slug: s.slug, name: s.name, min_order_usd: Number(s.min_order_usd), whatsapp: s.whatsapp ?? s.phone }}
        products={products} locale={L} fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency}
        labels={{ add: ui('add', L), soldOut: ui('soldOut', L), replaceCart: ui('replaceCart', L), cart: ui('cart', L), checkout: ui('checkout', L), items: ui('items', L),
          askOnWhatsapp: ui('askOnWhatsapp', L), waHello: ui('waHello', L), waAskItem: ui('waAskItem', L), waFrom: ui('waFrom', L) }} />
    </>
  );
}
