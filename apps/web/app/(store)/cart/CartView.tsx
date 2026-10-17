'use client';
import Link from 'next/link';
import { useCart } from '@/components/CartProvider';
import { formatMoney, t as tr, type DisplayCurrency, type Locale } from '@suqa/shared';
import { waLink } from '@/lib/whatsapp';

type Labels = Record<'cart' | 'emptyCart' | 'browseShops' | 'subtotal' | 'deliveryFee' | 'checkout' | 'from' | 'remove' | 'sendCartWhatsapp' | 'waHello' | 'waOrderIntro' | 'total' | 'notes', string>;

export default function CartView({ locale: L, fx, displayCurrency, signedIn, labels }: { locale: Locale; fx: number; displayCurrency: DisplayCurrency; signedIn: boolean; labels: Labels }) {
  const { cart, setQty, subtotal, count } = useCart();
  const money = (v: number) => formatMoney(v, fx, displayCurrency, L);
  const waText = () => [
    `${labels.waHello} ${tr(cart.shop_name!, L)} 👋`, labels.waOrderIntro,
    ...cart.lines.map(l => `• ${l.qty} × ${tr(l.name, L)}${l.unit ? ` (${l.unit})` : ''} — ${money(l.price_usd * l.qty)}`),
    `${labels.total}: ${money(subtotal)} (+ ${labels.deliveryFee.toLowerCase()})`,
  ].join('\n');
  const wa = cart.shop_whatsapp ? waLink(cart.shop_whatsapp, waText()) : null;
  if (!count) return <div className="card stack" style={{ textAlign: 'center' }}><p className="muted">{labels.emptyCart}</p><Link className="btn primary" href="/">{labels.browseShops}</Link></div>;
  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{labels.cart} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>{labels.from} <Link href={`/s/${cart.shop_slug}`}>{tr(cart.shop_name!, L)}</Link></span></h1>
      <section className="card">
        {cart.lines.map(l => (
          <div className="product" key={l.product_id}>
            <div style={{ flex: 1 }}>
              <div className="name">{tr(l.name, L)}</div>
              <div className="muted" style={{ fontSize: 13 }}>{money(l.price_usd)}{l.unit ? ` / ${l.unit}` : ''}</div>
            </div>
            <div className="stepper">
              <button className="btn" onClick={() => setQty(l.product_id, l.qty - 1)}>−</button>
              <span className="qty">{l.qty}</span>
              <button className="btn" onClick={() => setQty(l.product_id, l.qty + 1)}>+</button>
            </div>
            <strong style={{ minWidth: 70, textAlign: 'end' }}>{money(l.price_usd * l.qty)}</strong>
          </div>
        ))}
      </section>
      <section className="card stack">
        <div className="row spread"><span>{labels.subtotal}</span><strong>{money(subtotal)}</strong></div>
        <div className="row spread muted" style={{ fontSize: 13 }}><span>{labels.deliveryFee}</span><span>→ {labels.checkout}</span></div>
        <Link className="btn primary wide" href={signedIn ? '/checkout' : '/login?next=/checkout'} style={{ textAlign: 'center', textDecoration: 'none' }}>{labels.checkout}</Link>
        {wa && <a className="btn wa wide" href={wa} target="_blank" rel="noopener noreferrer" style={{ textAlign: 'center' }}>💬 {labels.sendCartWhatsapp}</a>}
      </section>
    </div>
  );
}
