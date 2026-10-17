'use client';
import Link from 'next/link';
import { useCart } from '@/components/CartProvider';
import { formatMoney, t as tr, type DisplayCurrency, type Locale } from '@suqa/shared';
import { waLink } from '@/lib/whatsapp';

type Labels = Record<'cart' | 'emptyCart' | 'browseShops' | 'subtotal' | 'deliveryFee' | 'checkout' | 'from' | 'remove'
  | 'sendCartWhatsapp' | 'waHello' | 'waOrderIntro' | 'total' | 'notes' | 'minOrder' | 'belowMin' | 'checkoutSelected' | 'shopsSelected'
  | 'oneFeeCourier' | 'feePerShop' | 'includeInOrder' | 'keepForLater', string>;

export default function CartView({ locale: L, fx, displayCurrency, signedIn, deliveryMode, labels }: {
  locale: Locale; fx: number; displayCurrency: DisplayCurrency; signedIn: boolean; deliveryMode: 'per_shop' | 'courier'; labels: Labels;
}) {
  const { cart, multiShop, setQty, setSelected, removeShop, count, selectedShops, selectedSubtotal } = useCart();
  const money = (v: number) => formatMoney(v, fx, displayCurrency, L);
  if (!count) return <div className="card stack" style={{ textAlign: 'center' }}><p className="muted">{labels.emptyCart}</p><Link className="btn primary" href="/">{labels.browseShops}</Link></div>;

  const shopSub = (lines: { price_usd: number; qty: number }[]) => Math.round(lines.reduce((s, l) => s + l.price_usd * l.qty, 0) * 100) / 100;
  const belowMin = selectedShops.filter(s => (s.min_order_usd ?? 0) > shopSub(s.lines));
  const canCheckout = selectedShops.length > 0 && belowMin.length === 0;
  const waTextFor = (s: typeof cart.shops[number]) => [
    `${labels.waHello} ${tr(s.name, L)} 👋`, labels.waOrderIntro,
    ...s.lines.map(l => `• ${l.qty} × ${tr(l.name, L)}${l.unit ? ` (${l.unit})` : ''} — ${money(l.price_usd * l.qty)}`),
    `${labels.total}: ${money(shopSub(s.lines))} (+ ${labels.deliveryFee.toLowerCase()})`,
  ].join('\n');

  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{labels.cart}</h1>

      {cart.shops.map(s => {
        const sub = shopSub(s.lines); const min = s.min_order_usd ?? 0; const short = min > sub;
        const wa = s.whatsapp ? waLink(s.whatsapp, waTextFor(s)) : null;
        return (
          <section className={`card stack cart-shop ${s.selected ? '' : 'off'}`} key={s.id}>
            <div className="row spread">
              <label className="row" style={{ cursor: 'pointer', gap: 10 }}>
                {multiShop && <input type="checkbox" className="check" checked={s.selected} onChange={e => setSelected(s.id, e.target.checked)} aria-label={labels.includeInOrder} />}
                <strong><Link href={`/s/${s.slug}`}>{tr(s.name, L)}</Link></strong>
              </label>
              <span className="row" style={{ gap: 8 }}>
                <strong>{money(sub)}</strong>
                <button className="btn ghost muted" onClick={() => removeShop(s.id)} aria-label={labels.remove}>✕</button>
              </span>
            </div>
            {s.lines.map(l => (
              <div className="product" key={l.product_id}>
                <div style={{ flex: 1 }}>
                  <div className="name">{tr(l.name, L)}</div>
                  <div className="muted" style={{ fontSize: 13 }}>{money(l.price_usd)}{l.unit ? ` / ${l.unit}` : ''}</div>
                </div>
                <div className="stepper">
                  <button className="btn" onClick={() => setQty(s.id, l.product_id, l.qty - 1)}>−</button>
                  <span className="qty">{l.qty}</span>
                  <button className="btn" onClick={() => setQty(s.id, l.product_id, l.qty + 1)}>+</button>
                </div>
                <strong style={{ minWidth: 70, textAlign: 'end' }}>{money(l.price_usd * l.qty)}</strong>
              </div>
            ))}
            {short && s.selected && <div className="error" style={{ fontSize: 13 }}>{labels.belowMin} {money(min)}</div>}
            {multiShop && !s.selected && <div className="muted" style={{ fontSize: 13 }}>{labels.keepForLater}</div>}
            {wa && <a className="btn ghost wa-text" href={wa} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>💬 {labels.sendCartWhatsapp}</a>}
          </section>
        );
      })}

      <section className="card stack">
        {multiShop && <div className="row spread muted" style={{ fontSize: 13 }}><span>{labels.shopsSelected}</span><span>{selectedShops.length}</span></div>}
        <div className="row spread"><span>{labels.subtotal}</span><strong>{money(selectedSubtotal)}</strong></div>
        <div className="row spread muted" style={{ fontSize: 13 }}>
          <span>{labels.deliveryFee}</span>
          <span>{selectedShops.length > 1 ? (deliveryMode === 'courier' ? labels.oneFeeCourier : labels.feePerShop) : `→ ${labels.checkout}`}</span>
        </div>
        <Link className={`btn primary wide ${canCheckout ? '' : 'disabled'}`} aria-disabled={!canCheckout}
          href={canCheckout ? (signedIn ? '/checkout' : '/login?next=/checkout') : '#'} onClick={e => { if (!canCheckout) e.preventDefault(); }}
          style={{ textAlign: 'center', textDecoration: 'none' }}>
          {multiShop && selectedShops.length > 1 ? `${labels.checkoutSelected} (${selectedShops.length})` : labels.checkout}
        </Link>
      </section>
    </div>
  );
}
