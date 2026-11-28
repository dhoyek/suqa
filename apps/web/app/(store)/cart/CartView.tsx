'use client';
import Link from 'next/link';
import { useCart } from '@/components/CartProvider';
import { formatMoney, t as tr, type DisplayCurrency, type Locale } from '@suqa/shared';
import { formatMoneySum, rateOf, type Rates } from '@/lib/shop-money';
import { waLink } from '@/lib/whatsapp';

type Labels = Record<'cart' | 'emptyCart' | 'browseShops' | 'subtotal' | 'deliveryFee' | 'checkout' | 'from' | 'remove'
  | 'sendCartWhatsapp' | 'waHello' | 'waOrderIntro' | 'total' | 'notes' | 'minOrder' | 'belowMin' | 'checkoutSelected' | 'shopsSelected'
  | 'oneFeeCourier' | 'feePerShop' | 'includeInOrder' | 'keepForLater' | 'continueShopping' | 'home' | 'lineNote', string>;

export default function CartView({ locale: L, fx, rates, displayCurrency, signedIn, deliveryMode, labels }: {
  locale: Locale; fx: number; rates?: Rates; displayCurrency: DisplayCurrency; signedIn: boolean; deliveryMode: 'per_shop' | 'courier'; labels: Labels;
}) {
  const { cart, multiShop, setQty, setNote, setSelected, removeShop, count, selectedShops, selectedSubtotal } = useCart();
  // each shop's lira at its own rate (103); a total across shops is the sum of their lira
  const moneyAt = (shopId: string) => (v: number, lbpExact?: number | null) => formatMoney(v, rateOf(rates, shopId, fx), displayCurrency, L, lbpExact);
  if (!count) return <div className="card stack" style={{ textAlign: 'center' }}><p className="muted">{labels.emptyCart}</p><Link className="btn primary" href="/">{labels.browseShops}</Link></div>;

  const shopSub = (lines: { price_usd: number; qty: number }[]) => Math.round(lines.reduce((s, l) => s + l.price_usd * l.qty, 0) * 100) / 100;
  const belowMin = selectedShops.filter(s => (s.min_order_usd ?? 0) > shopSub(s.lines));
  const canCheckout = selectedShops.length > 0 && belowMin.length === 0;
  const waTextFor = (s: typeof cart.shops[number], money = moneyAt(s.id)) => [
    `${labels.waHello} ${tr(s.name, L)} 👋`, labels.waOrderIntro,
    ...s.lines.map(l => `• ${l.qty} × ${tr(l.name, L)}${l.unit ? ` (${l.unit})` : ''} — ${money(l.price_usd * l.qty, l.lbp ? l.lbp * l.qty : null)}`),
    `${labels.total}: ${money(shopSub(s.lines))} (+ ${labels.deliveryFee.toLowerCase()})`,
  ].join('\n');

  return (
    <div className="stack">
      <div className="row spread" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{labels.cart}</h1>
        <span className="row" style={{ gap: 6 }}>{cart.shops[0] && <Link className="btn" href={`/s/${cart.shops[0].slug}`}>← {labels.continueShopping}</Link>}<Link className="btn ghost" href="/">🏠 {labels.home}</Link></span>
      </div>

      {cart.shops.map(s => {
        const money = moneyAt(s.id); const sub = shopSub(s.lines); const min = s.min_order_usd ?? 0; const short = min > sub;
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
              <div className="product cart-line" key={l.product_id}>
                <div className="info">
                  <div className="name">{l.bundle ? '🎁 ' : ''}{tr(l.name, L)}</div>
                  {l.bundle && <div className="muted" style={{ fontSize: 13 }}>{l.bundle.items.map(i => `${i.qty}× ${tr(i.name, L)}`).join(' · ')}</div>}
                  <div className="muted" style={{ fontSize: 13 }}>{l.bundle && l.bundle.normal_usd > l.price_usd ? <s style={{ marginInlineEnd: 6 }}>{money(l.bundle.normal_usd)}</s> : null}{money(l.price_usd, l.lbp)}{l.unit ? ` / ${l.unit}` : ''}</div>
                </div>
                <div className="stepper">
                  <button className="btn" onClick={() => setQty(s.id, l.product_id, Math.round((l.qty - (l.dec ? 0.5 : 1)) * 100) / 100)}>−</button>
                  <span className="qty">{l.qty}{l.dec && l.unit ? <small> {l.unit}</small> : null}</span>
                  <button className="btn" disabled={!!l.bundle?.max && l.qty >= l.bundle.max} onClick={() => setQty(s.id, l.product_id, Math.round((l.qty + (l.dec ? 0.5 : 1)) * 100) / 100)}>+</button>
                </div>
                <strong className="total">{money(l.price_usd * l.qty, l.lbp ? l.lbp * l.qty : null)}</strong>
                {!l.bundle && <input className="input line-note" placeholder={labels.lineNote} value={l.notes ?? ''} onChange={e => setNote(s.id, l.product_id, e.target.value)} />}
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
        <div className="row spread"><span>{labels.subtotal}</span><strong>{formatMoneySum(selectedShops.map(s => ({ usd: shopSub(s.lines), rate: rateOf(rates, s.id, fx) })), displayCurrency, L)}</strong></div>
        <div className="row spread muted" style={{ fontSize: 13 }}>
          <span>{labels.deliveryFee}</span>
          <span>{selectedShops.length > 1 ? (deliveryMode === 'courier' ? labels.oneFeeCourier : labels.feePerShop) : `→ ${labels.checkout}`}</span>
        </div>
        <div className="muted" style={{ fontSize: 13 }}>💵 {L === 'ar' ? 'الدفع نقداً عند الاستلام، بالدولار أو بالليرة.' : 'Pay cash when you receive the order, in USD or LBP.'}</div>
        <Link className={`btn primary wide ${canCheckout ? '' : 'disabled'}`} aria-disabled={!canCheckout}
          href={canCheckout ? (signedIn ? '/checkout' : '/login?next=/checkout') : '#'} onClick={e => { if (!canCheckout) e.preventDefault(); }}
          style={{ textAlign: 'center', textDecoration: 'none' }}>
          {multiShop && selectedShops.length > 1 ? `${labels.checkoutSelected} (${selectedShops.length})` : labels.checkout}
        </Link>
      </section>
    </div>
  );
}
