import { notFound } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { ui } from '@/lib/ui-text';
import { isOpenNow } from '@/lib/hours';
import { t as tr, type Shop, type Product } from '@suqa/shared';
import ShopMenu from './ShopMenu';
import { waLink, telLink } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';

export default async function ShopPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const { data: shop } = await sb.from('shops').select('*').eq('tenant_id', tenant.id).eq('slug', slug).eq('status', 'active').maybeSingle();
  if (!shop) notFound();
  const s = shop as Shop;
  const { data: products } = await sb.from('products').select('*').eq('shop_id', s.id).eq('is_active', true)
    .order('section', { ascending: true, nullsFirst: false }).order('sort_order');
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
        products={(products as Product[]) ?? []} locale={L} fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency}
        labels={{ add: ui('add', L), soldOut: ui('soldOut', L), replaceCart: ui('replaceCart', L), cart: ui('cart', L), checkout: ui('checkout', L), items: ui('items', L),
          askOnWhatsapp: ui('askOnWhatsapp', L), waHello: ui('waHello', L), waAskItem: ui('waAskItem', L), waFrom: ui('waFrom', L) }} />
    </>
  );
}
