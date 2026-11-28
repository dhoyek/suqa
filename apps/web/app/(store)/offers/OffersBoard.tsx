'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { t as tr, type DisplayCurrency, type Locale, type LocalizedText } from '@suqa/shared';
import type { Offer } from '@suqa/pos-core';
import { rateOf, type Rates } from '@/lib/shop-money';
import { offerVMs, type OfferVM } from '@/lib/offer-view';
import type { OfferItemRow } from '@/lib/offers-data';
import { OfferBuy, OfferCard, OfferDetail } from '@/components/offers/OfferParts';
import { useCart } from '@/components/CartProvider';

type ShopCard = { id: string; slug: string; name: LocalizedText; category_id: string | null; min_order_usd: number; open: boolean };
type Row = OfferVM & { shop: ShopCard; fx: number };

export default function OffersBoard({ locale: L, fx, rates, displayCurrency, cats, shops, offers, products, labels }: {
  locale: Locale; fx: number; rates: Rates; displayCurrency: DisplayCurrency; cats: { id: string; name: LocalizedText }[]; shops: ShopCard[]; offers: Offer[]; products: OfferItemRow[];
  labels: { add: string; replaceCart: string; all: string };
}) {
  const ar = L === 'ar';
  const { selectedCount } = useCart();
  const [now, setNow] = useState<Date | null>(null); useEffect(() => setNow(new Date()), []);
  const [cat, setCat] = useState<string | null>(null); const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo<Row[]>(() => {
    if (!now) return [];
    const byId = new Map(products.map(p => [p.id, p])); const out: Row[] = [];
    for (const shop of shops) {
      const mine = offers.filter(o => o.shop_id === shop.id); if (!mine.length) continue;
      const rate = rateOf(rates, shop.id, fx);
      for (const v of offerVMs(mine, id => byId.get(id), rate, now)) if (v.ok) out.push({ ...v, shop, fx: rate });
    }
    // hot first, then what ends soonest, then the newest
    const end = (r: Row) => (r.offer.ends_at ? new Date(r.offer.ends_at).getTime() : Infinity);
    return out.sort((a, b) => Number(b.hot) - Number(a.hot) || end(a) - end(b) || String((b.offer as { created_at?: string }).created_at ?? '').localeCompare(String((a.offer as { created_at?: string }).created_at ?? '')));
  }, [offers, products, shops, rates, fx, now]);
  const usedCats = cats.filter(c => rows.some(r => r.shop.category_id === c.id));
  const shown = cat ? rows.filter(r => r.shop.category_id === cat) : rows;
  const ov = open ? rows.find(r => r.id === open) ?? null : null;
  const refOf = (s: ShopCard) => ({ id: s.id, slug: s.slug, name: s.name, min_order_usd: s.min_order_usd });
  const buy = (r: Row) => <OfferBuy vm={r} shop={refOf(r.shop)} L={L} labels={labels} />;

  if (now && !rows.length) return <div className="card muted">{ar ? 'لا عروض الآن. عُد قريباً.' : 'No offers right now. Check back soon.'}</div>;
  return (
    <div className="stack" style={{ paddingBottom: selectedCount ? 90 : 0 }}>
      {usedCats.length > 1 && (
        <nav className="row chips">
          <button type="button" className={`chip ${cat ? '' : 'active'}`} onClick={() => setCat(null)}>{labels.all}</button>
          {usedCats.map(c => <button type="button" key={c.id} className={`chip ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>{tr(c.name, L)}</button>)}
        </nav>
      )}
      <div className="offers-grid-page">
        {shown.map(r => <OfferCard key={r.id} vm={r} fmt={{ fx: r.fx, displayCurrency, L }} shopName={tr(r.shop.name, L)} onOpen={() => setOpen(r.id)}>{buy(r)}</OfferCard>)}
      </div>
      {ov && <OfferDetail vm={ov} fmt={{ fx: ov.fx, displayCurrency, L }} shopName={tr(ov.shop.name, L)} onClose={() => setOpen(null)}>
        <span className="row" style={{ gap: 8, alignItems: 'center' }}><Link className="btn ghost" href={`/s/${ov.shop.slug}`}>🏪 {ar ? 'المتجر' : 'Shop'}</Link>{buy(ov)}</span>
      </OfferDetail>}
      {selectedCount > 0 && <div className="cart-bar"><Link href="/cart" className="btn primary wide row spread"><span>🧺 {ar ? 'السلة' : 'Basket'}</span><span>{selectedCount} ›</span></Link></div>}
    </div>
  );
}
