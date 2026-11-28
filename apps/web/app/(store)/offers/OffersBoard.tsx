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
import FilterIcon from '@/components/FilterIcon';

type ShopCard = { id: string; slug: string; name: LocalizedText; category_id: string | null; min_order_usd: number; open: boolean };
type Row = OfferVM & { shop: ShopCard; fx: number };

export default function OffersBoard({ locale: L, fx, rates, displayCurrency, cats, shops, offers, products, labels }: {
  locale: Locale; fx: number; rates: Rates; displayCurrency: DisplayCurrency; cats: { id: string; name: LocalizedText }[]; shops: ShopCard[]; offers: Offer[]; products: OfferItemRow[];
  labels: { add: string; replaceCart: string; all: string; shops: string; clearFilter: string; typeToFilter: string; ok: string };
}) {
  const ar = L === 'ar';
  const { selectedCount } = useCart();
  const [now, setNow] = useState<Date | null>(null); useEffect(() => setNow(new Date()), []);
  const [cat, setCat] = useState<string | null>(null); const [open, setOpen] = useState<string | null>(null);
  // filter by shop(s): the same sheet as the categories filter inside a shop — type to narrow the list, tick several
  const [sel, setSel] = useState<Set<string>>(new Set()); const [sheet, setSheet] = useState(false); const [shopQ, setShopQ] = useState('');
  const toggleShop = (id: string) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
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
  const inCat = cat ? rows.filter(r => r.shop.category_id === cat) : rows;
  const shown = sel.size ? inCat.filter(r => sel.has(r.shop.id)) : inCat;
  // the shops that have offers (with how many), for the sheet
  const offerShops = useMemo(() => { const m = new Map<string, { shop: ShopCard; n: number }>(); for (const r of rows) { const e = m.get(r.shop.id); if (e) e.n++; else m.set(r.shop.id, { shop: r.shop, n: 1 }); } return [...m.values()].sort((a, b) => tr(a.shop.name, L).localeCompare(tr(b.shop.name, L), L)); }, [rows, L]);
  const fold = (x: string) => x.toLowerCase().normalize('NFKD').replace(/[\u064B-\u0652\u0300-\u036f]/g, '');
  const shopMatches = offerShops.filter(e => !shopQ.trim() || fold(`${e.shop.name?.ar ?? ''} ${e.shop.name?.en ?? ''}`).includes(fold(shopQ.trim())));
  const ov = open ? rows.find(r => r.id === open) ?? null : null;
  const refOf = (s: ShopCard) => ({ id: s.id, slug: s.slug, name: s.name, min_order_usd: s.min_order_usd });
  const buy = (r: Row) => <OfferBuy vm={r} shop={refOf(r.shop)} L={L} labels={labels} />;

  if (now && !rows.length) return <div className="stack"><div className="row offers-head"><h1>🎁 {ar ? 'العروض' : 'Offers'}</h1></div><div className="card muted">{ar ? 'لا عروض الآن. عُد قريباً.' : 'No offers right now. Check back soon.'}</div></div>;
  return (
    <div className="stack" style={{ paddingBottom: selectedCount ? 90 : 0 }}>
      {/* one line: back, the title, and the shop filter at the other end */}
      <div className="row offers-head">
        <h1>🎁 {ar ? 'العروض' : 'Offers'}</h1>
        {offerShops.length > 1 && <button type="button" className={`btn offers-filter ${sel.size ? 'primary' : ''}`} onClick={() => setSheet(true)}><FilterIcon size={16} /> {labels.shops}{sel.size ? ` (${sel.size})` : ''}</button>}
      </div>
      {/* one line, swiped sideways: the chosen shops (tap to remove), then the shop categories */}
      {(sel.size > 0 || usedCats.length > 1) && (
        <nav className="row chips offers-chips">
          {[...sel].map(id => { const e = offerShops.find(x => x.shop.id === id); return e ? <button type="button" key={id} className="chip active" onClick={() => toggleShop(id)}>🏪 {tr(e.shop.name, L)} ✕</button> : null; })}
          {usedCats.length > 1 && <>
            <button type="button" className={`chip ${cat ? '' : 'active'}`} onClick={() => setCat(null)}>{labels.all}</button>
            {usedCats.map(c => <button type="button" key={c.id} className={`chip ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>{tr(c.name, L)}</button>)}
          </>}
        </nav>
      )}
      {!shown.length && <p className="muted">{ar ? 'لا عروض بهذا الاختيار.' : 'No offers for this choice.'}</p>}
      <div className="offers-grid-page">
        {shown.map(r => <OfferCard key={r.id} vm={r} fmt={{ fx: r.fx, displayCurrency, L }} shopName={tr(r.shop.name, L)} onOpen={() => setOpen(r.id)}>{buy(r)}</OfferCard>)}
      </div>
      {sheet && (
        <div className="dlg-backdrop" onClick={e => { if (e.target === e.currentTarget) setSheet(false); }}>
          <div className="dlg card" role="dialog" aria-label={labels.shops}>
            <div className="row spread" style={{ alignItems: 'center' }}><strong>{labels.shops}{sel.size ? ` (${sel.size})` : ''}</strong><button type="button" className="btn ghost" onClick={() => setSheet(false)} aria-label="✕">✕</button></div>
            <input className="input" placeholder={labels.typeToFilter} value={shopQ} onChange={e => setShopQ(e.target.value)} />
            <div className="cat-list">
              {shopMatches.map(e => <label key={e.shop.id} className={`cat-row ${sel.has(e.shop.id) ? 'active' : ''}`}><input type="checkbox" checked={sel.has(e.shop.id)} onChange={() => toggleShop(e.shop.id)} /> <span>{tr(e.shop.name, L)} <span className="muted">({e.n})</span></span></label>)}
            </div>
            <div className="row spread"><button type="button" className="btn" onClick={() => setSel(new Set())}>✕ {labels.clearFilter}</button><button type="button" className="btn primary" onClick={() => setSheet(false)}>{labels.ok}</button></div>
          </div>
        </div>
      )}
      {ov && <OfferDetail vm={ov} fmt={{ fx: ov.fx, displayCurrency, L }} shopName={tr(ov.shop.name, L)} onClose={() => setOpen(null)}>
        <span className="row" style={{ gap: 8, alignItems: 'center' }}><Link className="btn ghost" href={`/s/${ov.shop.slug}`}>🏪 {ar ? 'المتجر' : 'Shop'}</Link>{buy(ov)}</span>
      </OfferDetail>}
      {selectedCount > 0 && <div className="cart-bar"><Link href="/cart" className="btn primary wide row spread"><span>🧺 {ar ? 'السلة' : 'Basket'}</span><span>{selectedCount} ›</span></Link></div>}
    </div>
  );
}
