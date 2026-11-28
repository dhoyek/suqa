'use client';
import { allowsDecimal, foldForSearch, searchItems, type SearchFold } from '@/lib/item-match';
import FilterIcon from '@/components/FilterIcon';
import { useConfirm } from '@/components/ConfirmProvider';
import { weekdaysLabel } from '@/lib/weekdays';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useCart } from '@/components/CartProvider';
import type { Offer, OfferProduct } from '@suqa/pos-core';
import { offerVMs } from '@/lib/offer-view';
import { OfferBuy, OfferCard, OfferDetail } from '@/components/offers/OfferParts';
import { formatMoney, t as tr, type DisplayCurrency, type Locale, type LocalizedText, type Product } from '@suqa/shared';
import { waLink } from '@/lib/whatsapp';
import { noteSearch } from '@/lib/search-note';

type Labels = Record<'add' | 'soldOut' | 'replaceCart' | 'cart' | 'checkout' | 'items' | 'askOnWhatsapp' | 'waHello' | 'waAskItem' | 'waFrom' | 'searchItems' | 'details' | 'noMatches' | 'all' | 'categories' | 'clearFilter' | 'typeToFilter' | 'showMore' | 'ok', string>;

export default function ShopMenu({ shop, products, offers = [], locale: L, fx, displayCurrency, labels }: {
  shop: { id: string; slug: string; name: LocalizedText; min_order_usd: number; whatsapp: string | null; pickup_enabled?: boolean; section_names?: Record<string, { ar?: string; en?: string }> | null }; products: Product[]; offers?: Offer[];
  locale: Locale; fx: number; displayCurrency: DisplayCurrency; labels: Labels;
}) {
  const { add, setQty, qtyOf: qtyIn, selectedCount, selectedSubtotal, shopOf, setSelected } = useCart();
  const ask = useConfirm();
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const money = (v: number) => formatMoney(v, fx, displayCurrency, L);
  // an item priced in lira shows that lira as the shop set it (260,001 — not 260,000); only totals are rounded
  const liraOf = (p: Product) => { const x = p as { price_currency?: string | null; price_lbp?: number | string | null }; return x.price_currency === 'lbp' && Number(x.price_lbp) > 0 ? Number(x.price_lbp) : null; };
  const price = (p: Product) => formatMoney(Number(p.price_usd), fx, displayCurrency, L, liraOf(p));
  // …and with a running price offer: the old price crossed out, the offer price, a small tag
  const priceEl = (p: Product) => { const v = sales.get(p.id); return v ? <><s className="muted" style={{ fontWeight: 400, marginInlineEnd: 6 }}>{price(p)}</s><span className="sale-price">{formatMoney(v.charged / 100, fx, displayCurrency, L, v.lbp)}</span> <span className="sale-tag">−{v.pct}%</span></> : <>{price(p)}</>; };
  const sections = Array.from(new Set(products.map(p => p.section ?? '')));
  const qtyOf = (id: string) => qtyIn(shop.id, id);
  // a section's display name in the visitor's language (schema 74); the section key itself when the shop gave it no name
  const secName = (x: string) => { const n = shop.section_names?.[x]; return (L === 'ar' ? n?.ar || n?.en : n?.en || n?.ar) || x; };
  const secText = (x: string) => { const n = shop.section_names?.[x]; return `${x} ${n?.ar ?? ''} ${n?.en ?? ''}`; };
  // Category chips + substring search (any position, both languages, case-insensitive)
  const [secs, setSecs] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState(false); const [secQ, setSecQ] = useState('');
  const [limit, setLimit] = useState(60);
  const [q, setQ] = useState('');
  const fromHome = useRef('');                                     // words carried over from the home page: already counted there
  const [pin, setPin] = useState<string | null>(null);              // the item that was tapped on the home page (?i=): shown first, whatever the words find
  useEffect(() => { const sp = new URLSearchParams(window.location.search); const v = sp.get('q'); if (v) { fromHome.current = v.trim(); setQ(v); } const i = sp.get('i'); if (i) setPin(i); }, []);   // arriving from the home page's item search
  const toggleSec = (x: string) => setSecs(prev => { const n = new Set(prev); if (n.has(x)) n.delete(x); else n.add(x); return n; });
  const norm = (v: string) => v.toLowerCase().replace(/[\u064B-\u0652]/g, '').replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  // every item folded once. Names and other names ("man2ouche", "mayy" …) are also compared by sound; the description and the
  // section's names only as typed — a category that merely sounds like the word ("Pantry" for "panten") is not a match
  const folded = useMemo(() => new Map<string, SearchFold>(products.map(p => [p.id, foldForSearch(
    [p.name?.ar, p.name?.en, ...((p as { aliases?: string[] | null }).aliases ?? [])], [p.description?.ar, p.description?.en, secText(p.section ?? '')], p.section ?? null)])),
    [products]);   // eslint-disable-line react-hooks/exhaustive-deps
  // as typed first, then the same word in the other alphabet (Arabizi), a typo only when nothing else matched (searchItems)
  const visible = useMemo(() => {
    const found = searchItems(secs.size ? products.filter(p => secs.has(p.section ?? '')) : products, p => folded.get(p.id)!, q);
    // arriving from a tapped item: that item first, while the words are still the ones that were searched
    const first = pin && q.trim() === fromHome.current && !secs.size ? products.find(p => p.id === pin) : undefined;
    return first ? [first, ...found.filter(p => p.id !== first.id)] : found;
  }, [products, secs, q, folded, pin]);
  // what was searched in this shop, for the association's Demand page (99): once the person has stopped typing for 2 s
  const hitCount = visible.length;
  useEffect(() => {
    const phrase = q.trim(); if (phrase.length < 2 || phrase === fromHome.current) return;
    const timer = setTimeout(() => noteSearch(null, shop.id, phrase, hitCount > 0), 2000);
    return () => clearTimeout(timer);
  }, [q, hitCount, shop.id]);
  useEffect(() => setLimit(60), [q, secs]);                       // a new search/filter starts from the top again
  const shown = visible.slice(0, limit);
  // while searching, the categories follow the results (best match first); otherwise the shop's own order
  const visibleSections = q.trim() ? Array.from(new Set(shown.map(p => p.section ?? ''))) : sections.filter(s => shown.some(p => (p.section ?? '') === s));
  const secMatches = sections.filter(Boolean).filter(x => !secQ.trim() || norm(secText(x)).includes(norm(secQ.trim()))).sort((a, b) => secName(a).localeCompare(secName(b), L));
  // Prefilled WhatsApp message with the item's details and a link back to the shop page.
  const askLink = (p: Product) => waLink(shop.whatsapp, [
    `${labels.waHello} ${tr(shop.name, L)} 👋`, labels.waAskItem,
    `• ${tr(p.name, L)}${p.unit ? ` (${p.unit})` : ''} — ${price(p)}`,
    tr(p.description, L) || null,
    origin ? `${labels.waFrom} ${origin}/s/${shop.slug}` : null,
  ].filter(Boolean).join('\n'));

  // the buy controls of an item (add, or − qty +): the same in the list and in the item's details
  const buy = (p: Product) => { const q = qtyOf(p.id); const dec = allowsDecimal(p as { decimal_qty?: boolean; unit?: string | null; unit_kind?: string | null }); const step = dec ? 0.5 : 1; return (<>
      {!p.is_available ? <span className="badge cancelled">{labels.soldOut}</span>
                    : q === 0 ? <button className="btn primary add-btn" onClick={() => add({ id: shop.id, slug: shop.slug, name: shop.name, whatsapp: shop.whatsapp, min_order_usd: shop.min_order_usd, pickup_enabled: shop.pickup_enabled !== false }, { product_id: p.id, name: p.name, unit: p.unit, ...(dec ? { dec: true } : {}), ...(sales.get(p.id) ? { price_usd: sales.get(p.id)!.charged / 100, ...(sales.get(p.id)!.lbp ? { lbp: sales.get(p.id)!.lbp! } : {}) } : { price_usd: Number(p.price_usd), ...(liraOf(p) ? { lbp: liraOf(p)! } : {}) }), days: (p as { available_days?: number[] | null }).available_days ?? null }, () => ask(labels.replaceCart))} aria-label={labels.add}><span aria-hidden>+</span><span className="add-label"> {labels.add}</span></button>
                    : <div className="stepper">
                        <button className="btn" onClick={() => setQty(shop.id, p.id, Math.round((q - step) * 100) / 100)} aria-label="−">−</button>
                        <span className="qty">{q}{dec && p.unit ? <small> {p.unit}</small> : null}</span>
                        <button className="btn" onClick={() => setQty(shop.id, p.id, Math.round((q + step) * 100) / 100)} aria-label="+">+</button>
                      </div>}
  </>); };
  // the shop's offers (130 / 131): bundles and price offers, as the server will charge them (dollar cents at the shop's rate)
  const byId = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const [today, setToday] = useState<Date | null>(null); useEffect(() => setToday(new Date()), []);     // the visitor's clock, after the page is on screen
  const vms = useMemo(() => (today ? offerVMs(offers, id => byId.get(id) as unknown as OfferProduct | undefined, fx, today) : []), [offers, byId, fx, today]);
  // an item with a running price offer: its offer price everywhere on the page (row, details, basket)
  const sales = useMemo(() => new Map(vms.filter(v => v.kind === 'discount' && v.ok && v.product).map(v => [v.product!.id, v])), [vms]);
  const ar = L === 'ar';
  const shopRef = { id: shop.id, slug: shop.slug, name: shop.name, whatsapp: shop.whatsapp, min_order_usd: shop.min_order_usd, pickup_enabled: shop.pickup_enabled !== false };
  const fmt = { fx, displayCurrency, L };
  const [detail, setDetail] = useState<string | null>(null);      // the item whose picture and details are open
  const [offerOpen, setOfferOpen] = useState<string | null>(null);  // the offer whose pictures and details are open
  const ov = offerOpen ? vms.find(v => v.id === offerOpen) ?? null : null;
  const dp = detail ? products.find(x => x.id === detail) ?? null : null;
  useEffect(() => { if (!detail) return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetail(null); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [detail]);
  return (
    <>
      <div className="stack" style={{ paddingBottom: selectedCount ? 90 : 0 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input className="input search" type="search" placeholder={labels.searchItems} value={q} onChange={e => setQ(e.target.value)} aria-label={labels.searchItems} style={{ flex: 1 }} />
          {sections.filter(Boolean).length > 1 && <button type="button" className={`btn ${secs.size ? 'primary' : ''}`} onClick={() => setSheet(true)} aria-label={labels.categories}><FilterIcon />{secs.size ? ` ${secs.size}` : ''}</button>}
        </div>
        {secs.size > 0 && (
          <nav className="row chips">
            {[...secs].map(x => <button type="button" key={x} className="chip active" onClick={() => toggleSec(x)}>{secName(x)} ✕</button>)}
            <button type="button" className="chip" onClick={() => setSecs(new Set())}>{labels.clearFilter}</button>
          </nav>
        )}
        {vms.length > 0 && !q.trim() && secs.size === 0 && (
          <section className="offers-strip" aria-label={ar ? 'العروض' : 'Offers'}>
            <h2 className="offers-title">🎁 {ar ? 'العروض' : 'Offers'}</h2>
            <div className="offers-row">
              {vms.map(v => <OfferCard key={v.id} vm={v} fmt={fmt} onOpen={() => setOfferOpen(v.id)}><OfferBuy vm={v} shop={shopRef} L={L} labels={{ add: labels.add, replaceCart: labels.replaceCart }} /></OfferCard>)}
            </div>
          </section>
        )}
        {ov && <OfferDetail vm={ov} fmt={fmt} onClose={() => setOfferOpen(null)}><OfferBuy vm={ov} shop={shopRef} L={L} labels={{ add: labels.add, replaceCart: labels.replaceCart }} /></OfferDetail>}
        {dp && (
          <div className="dlg-backdrop" onClick={e => { if (e.target === e.currentTarget) setDetail(null); }}>
            <div className="dlg card item-detail" role="dialog" aria-label={tr(dp.name, L)}>
              <div className="row spread" style={{ alignItems: 'center', gap: 8 }}><strong style={{ fontSize: 18, minWidth: 0 }}>{tr(dp.name, L)}</strong><button type="button" className="btn ghost" onClick={() => setDetail(null)} aria-label="✕">✕</button></div>
              {dp.image_url && <img className="item-detail-img" src={dp.image_url} alt={tr(dp.name, L)} />}
              {!!(dp as { available_days?: number[] | null }).available_days?.length && <div style={{ fontSize: 13, color: '#b45309', fontWeight: 600 }}>📅 {weekdaysLabel((dp as { available_days?: number[] }).available_days!, L)}</div>}
              {tr(dp.description, L) && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{tr(dp.description, L)}</p>}
              <div className="row spread" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 16 }}>{priceEl(dp)}{dp.unit ? <span className="muted" style={{ fontWeight: 400 }}> / {dp.unit}</span> : null}</strong>
                <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                  {shop.whatsapp && <a className="btn ghost wa-mini" href={askLink(dp) ?? '#'} target="_blank" rel="noopener noreferrer" title={labels.askOnWhatsapp} aria-label={labels.askOnWhatsapp}>💬</a>}
                  {buy(dp)}
                </span>
              </div>
            </div>
          </div>
        )}
        {sheet && (
          <div className="dlg-backdrop" onClick={e => { if (e.target === e.currentTarget) setSheet(false); }}>
            <div className="dlg card" role="dialog" aria-label={labels.categories}>
              <div className="row spread" style={{ alignItems: 'center' }}><strong>{labels.categories}{secs.size ? ` (${secs.size})` : ''}</strong><button type="button" className="btn ghost" onClick={() => setSheet(false)} aria-label="✕">✕</button></div>
              <input className="input" placeholder={labels.typeToFilter} value={secQ} onChange={e => setSecQ(e.target.value)} />
              <div className="cat-list">
                {secMatches.map(x => <label key={x} className={`cat-row ${secs.has(x) ? 'active' : ''}`}><input type="checkbox" checked={secs.has(x)} onChange={() => toggleSec(x)} /> <span>{secName(x)}</span></label>)}
              </div>
              <div className="row spread"><button type="button" className="btn" onClick={() => setSecs(new Set())}>✕ {labels.clearFilter}</button><button type="button" className="btn primary" onClick={() => setSheet(false)}>{labels.ok}</button></div>
            </div>
          </div>
        )}
        {!visible.length && <p className="muted">{labels.noMatches}</p>}
        {visibleSections.map(sec => (
          <section className="card" key={sec || '_'}>
            {sec && <div className="col-title" style={{ marginTop: 0 }}>{secName(sec)}</div>}
            {shown.filter(p => (p.section ?? '') === sec).map(p => {
              return (
                <div className={`product menu-item ${p.is_available ? '' : 'off'}`} key={p.id}>
                  {p.image_url ? <img className="thumb lg" src={p.image_url} alt="" loading="lazy" onClick={() => setDetail(p.id)} style={{ cursor: 'zoom-in' }} /> : <span className="thumb ph" aria-hidden onClick={() => setDetail(p.id)} style={{ cursor: 'pointer' }}>{(tr(p.name, L) || '•').trim().charAt(0)}</span>}
                  <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setDetail(p.id)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setDetail(p.id); }} aria-label={`${tr(p.name, L)} — ${labels.details}`}>
                    <div className="name">{tr(p.name, L)}</div>
                    {!!(p as { available_days?: number[] | null }).available_days?.length && <div style={{ fontSize: 12, color: '#b45309', fontWeight: 600 }}>📅 {weekdaysLabel((p as { available_days?: number[] }).available_days!, L)}</div>}
                    {tr(p.description, L) && <div className="muted desc">{tr(p.description, L)}</div>}
                    <div className="price">{priceEl(p)}{p.unit ? <span className="muted"> / {p.unit}</span> : null}{typeof (p as { available?: number | null }).available === 'number' && (p as { available?: number }).available! > 0 && (p as { available?: number }).available! <= 5 ? <span className="muted" style={{ fontSize: 12 }}> · {(p as { available?: number }).available} {L === 'ar' ? 'متبقٍ' : 'left'}</span> : null}</div>
                  </div>
                  <div className="menu-acts">
                    {shop.whatsapp && <a className="btn ghost wa-mini" href={askLink(p) ?? '#'} target="_blank" rel="noopener noreferrer" title={labels.askOnWhatsapp} aria-label={labels.askOnWhatsapp}>💬</a>}
                    {buy(p)}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
        {visible.length > shown.length && <button type="button" className="btn wide" onClick={() => setLimit(l => l + 60)}>{labels.showMore} ({visible.length - shown.length})</button>}
      </div>
      {selectedCount > 0 && (
        <div className="cart-bar">
          <Link href="/cart" className="btn primary wide row spread" onClick={() => { if (shopOf(shop.id)) setSelected(shop.id, true); }}>
            <span>{selectedCount} {labels.items}</span><span>{labels.cart} · {money(selectedSubtotal)}</span>
          </Link>
        </div>
      )}
    </>
  );
}
