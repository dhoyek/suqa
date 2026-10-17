'use client';
import { useConfirm } from '@/components/ConfirmProvider';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useCart } from '@/components/CartProvider';
import { formatMoney, t as tr, type DisplayCurrency, type Locale, type LocalizedText, type Product } from '@suqa/shared';
import { waLink } from '@/lib/whatsapp';

type Labels = Record<'add' | 'soldOut' | 'replaceCart' | 'cart' | 'checkout' | 'items' | 'askOnWhatsapp' | 'waHello' | 'waAskItem' | 'waFrom', string>;

export default function ShopMenu({ shop, products, locale: L, fx, displayCurrency, labels }: {
  shop: { id: string; slug: string; name: LocalizedText; min_order_usd: number; whatsapp: string | null }; products: Product[];
  locale: Locale; fx: number; displayCurrency: DisplayCurrency; labels: Labels;
}) {
  const { add, setQty, qtyOf: qtyIn, selectedCount, selectedSubtotal, shopOf, setSelected } = useCart();
  const ask = useConfirm();
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const money = (v: number) => formatMoney(v, fx, displayCurrency, L);
  const sections = Array.from(new Set(products.map(p => p.section ?? '')));
  const qtyOf = (id: string) => qtyIn(shop.id, id);
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
        {sections.map(sec => (
          <section className="card" key={sec || '_'}>
            {sec && <div className="col-title" style={{ marginTop: 0 }}>{sec}</div>}
            {products.filter(p => (p.section ?? '') === sec).map(p => {
              const q = qtyOf(p.id);
              return (
                <div className={`product ${p.is_available ? '' : 'off'}`} key={p.id}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="name">{tr(p.name, L)}</div>
                    {tr(p.description, L) && <div className="muted" style={{ fontSize: 13 }}>{tr(p.description, L)}</div>}
                    <div style={{ fontSize: 14 }}>{money(Number(p.price_usd))}{p.unit ? <span className="muted"> / {p.unit}</span> : null}</div>
                  </div>
                  {shop.whatsapp && <a className="btn ghost wa-mini" href={askLink(p) ?? '#'} target="_blank" rel="noopener noreferrer" title={labels.askOnWhatsapp} aria-label={labels.askOnWhatsapp}>💬</a>}
                  {!p.is_available ? <span className="badge cancelled">{labels.soldOut}</span>
                    : q === 0 ? <button className="btn primary" onClick={() => add({ id: shop.id, slug: shop.slug, name: shop.name, whatsapp: shop.whatsapp, min_order_usd: shop.min_order_usd }, { product_id: p.id, name: p.name, unit: p.unit, price_usd: Number(p.price_usd) }, () => ask(labels.replaceCart))}>+ {labels.add}</button>
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
