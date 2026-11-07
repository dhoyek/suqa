'use client';
import { useConfirm } from '@/components/ConfirmProvider';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useCart } from '@/components/CartProvider';
import { formatMoney, t as tr, type DisplayCurrency, type Locale, type LocalizedText, type Product } from '@suqa/shared';
import { waLink } from '@/lib/whatsapp';

type Labels = Record<'add' | 'soldOut' | 'replaceCart' | 'cart' | 'checkout' | 'items' | 'askOnWhatsapp' | 'waHello' | 'waAskItem' | 'waFrom' | 'searchItems' | 'noMatches' | 'all', string>;

export default function ShopMenu({ shop, products, locale: L, fx, displayCurrency, labels }: {
  shop: { id: string; slug: string; name: LocalizedText; min_order_usd: number; whatsapp: string | null; pickup_enabled?: boolean }; products: Product[];
  locale: Locale; fx: number; displayCurrency: DisplayCurrency; labels: Labels;
}) {
  const { add, setQty, qtyOf: qtyIn, selectedCount, selectedSubtotal, shopOf, setSelected } = useCart();
  const ask = useConfirm();
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const money = (v: number) => formatMoney(v, fx, displayCurrency, L);
  const sections = Array.from(new Set(products.map(p => p.section ?? '')));
  const qtyOf = (id: string) => qtyIn(shop.id, id);
  // Category chips + substring search (any position, both languages, case-insensitive)
  const [sec, setSec] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const norm = (v: string) => v.toLowerCase().replace(/[\u064B-\u0652]/g, '').replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  const visible = useMemo(() => {
    const needle = norm(q.trim());
    return products.filter(p => (sec === null || (p.section ?? '') === sec)
      && (!needle || norm(`${p.name?.ar ?? ''} ${p.name?.en ?? ''} ${p.description?.ar ?? ''} ${p.description?.en ?? ''}`).includes(needle)));
  }, [products, sec, q]);
  const visibleSections = sections.filter(s => visible.some(p => (p.section ?? '') === s));
  // Prefilled WhatsApp message with the item's details and a link back to the shop page.
  const askLink = (p: Product) => waLink(shop.whatsapp, [
    `${labels.waHello} ${tr(shop.name, L)} 👋`, labels.waAskItem,
    `• ${tr(p.name, L)}${p.unit ? ` (${p.unit})` : ''} — ${money(Number(p.price_usd))}`,
    tr(p.description, L) || null,
    origin ? `${labels.waFrom} ${origin}/s/${shop.slug}` : null,
  ].filter(Boolean).join('\n'));

  return (
    <>
      <div className="stack" style={{ paddingBottom: selectedCount ? 90 : 0 }}>
        <input className="input search" type="search" placeholder={labels.searchItems} value={q} onChange={e => setQ(e.target.value)} aria-label={labels.searchItems} />
        {sections.filter(Boolean).length > 1 && (
          <nav className="row chips">
            <button type="button" className={`chip ${sec === null ? 'active' : ''}`} onClick={() => setSec(null)}>{labels.all}</button>
            {sections.filter(Boolean).map(s => <button type="button" key={s} className={`chip ${sec === s ? 'active' : ''}`} onClick={() => setSec(s)}>{s}</button>)}
          </nav>
        )}
        {!visible.length && <p className="muted">{labels.noMatches}</p>}
        {visibleSections.map(sec => (
          <section className="card" key={sec || '_'}>
            {sec && <div className="col-title" style={{ marginTop: 0 }}>{sec}</div>}
            {visible.filter(p => (p.section ?? '') === sec).map(p => {
              const q = qtyOf(p.id);
              return (
                <div className={`product ${p.is_available ? '' : 'off'}`} key={p.id}>
                  {p.image_url && <img className="thumb lg" src={p.image_url} alt="" loading="lazy" />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="name">{tr(p.name, L)}</div>
                    {tr(p.description, L) && <div className="muted" style={{ fontSize: 13 }}>{tr(p.description, L)}</div>}
                    <div style={{ fontSize: 14 }}>{money(Number(p.price_usd))}{p.unit ? <span className="muted"> / {p.unit}</span> : null}{typeof (p as { available?: number | null }).available === 'number' && (p as { available?: number }).available! > 0 && (p as { available?: number }).available! <= 5 ? <span className="muted" style={{ fontSize: 12 }}> · {(p as { available?: number }).available} {L === 'ar' ? 'متبقٍ' : 'left'}</span> : null}</div>
                  </div>
                  {shop.whatsapp && <a className="btn ghost wa-mini" href={askLink(p) ?? '#'} target="_blank" rel="noopener noreferrer" title={labels.askOnWhatsapp} aria-label={labels.askOnWhatsapp}>💬</a>}
                  {!p.is_available ? <span className="badge cancelled">{labels.soldOut}</span>
                    : q === 0 ? <button className="btn primary" onClick={() => add({ id: shop.id, slug: shop.slug, name: shop.name, whatsapp: shop.whatsapp, min_order_usd: shop.min_order_usd, pickup_enabled: shop.pickup_enabled !== false }, { product_id: p.id, name: p.name, unit: p.unit, price_usd: Number(p.price_usd) }, () => ask(labels.replaceCart))}>+ {labels.add}</button>
                    : <div className="stepper">
                        <button className="btn" onClick={() => setQty(shop.id, p.id, q - 1)} aria-label="−">−</button>
                        <span className="qty">{q}</span>
                        <button className="btn" onClick={() => setQty(shop.id, p.id, q + 1)} aria-label="+">+</button>
                      </div>}
                </div>
              );
            })}
          </section>
        ))}
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
