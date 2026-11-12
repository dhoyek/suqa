'use client';
import { useConfirm, useNotify } from '@/components/ConfirmProvider';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import StatusTimeline from '@/components/StatusTimeline';
import OrderThread from '@/components/OrderThread';
import { useCart } from '@/components/CartProvider';
import { formatMoney, pointFromEwkb, t as tr, type DisplayCurrency, type Locale, type Order, type OrderItem, type OrderStatus } from '@suqa/shared';

type ShopInfo = { id: string; name: Record<string, string>; slug: string; phone: string | null; whatsapp: string | null; address_text: string | null; min_order_usd: number | null; pickup_enabled: boolean | null };
type Row = Order & { items: (OrderItem & { voided?: boolean })[]; shop: ShopInfo; total_cents?: number | null; discount_cents?: number | null; cancel_reason?: string | null; needed_at?: string | null };
export type Extra = { driver: { name: string; phone: string | null; vehicle: string | null } | null; payments: { tender: string; amount: number; currency: string }[] };
type LabelKey = 'orderPlaced' | 'cancelOrder' | 'total' | 'deliveryFee' | 'call' | 'eta' | 'myOrders' | 'notes' | 'threadTitle' | 'threadCustomer' | 'threadShop' | 'readyForPickup' | 'pickedUp' | 'pickupBadge' | 'replaceCart';

const digits = (p?: string | null) => String(p ?? '').replace(/\D/g, '').replace(/^00/, '');
const tel = (p?: string | null) => { const d = digits(p); return d ? `+${d}` : ''; };

/** The customer's order page: where the order is, who to call, what was ordered and what is left to pay. Updates itself while the order is open. */
export default function OrderTracker(props: { initial: Row; extra: Extra; rating: { stars: number; comment: string | null } | null; locale: Locale; fx: number; displayCurrency: DisplayCurrency; timezone: string; justPlaced: boolean; statusLabels: Record<OrderStatus, string>; labels: Record<LabelKey, string> }) {
  const { locale: L, fx, displayCurrency, statusLabels, labels, extra, timezone } = props;
  const ar = L === 'ar';
  const ask = useConfirm();
  const sb = useMemo(() => supabaseBrowser(), []);
  const notify = useNotify();
  const router = useRouter();
  const cart = useCart();
  const [o, setO] = useState<Row>(props.initial);
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState(props.rating);
  const [stars, setStars] = useState(props.rating?.stars ?? 0); const [comment, setComment] = useState(props.rating?.comment ?? ''); const [rateBusy, setRateBusy] = useState(false);
  const rateDirty = stars > 0 && (stars !== (rating?.stars ?? 0) || comment.trim() !== (rating?.comment ?? ''));
  async function sendRating() {
    if (!stars) return;
    setRateBusy(true);
    const { error } = await sb.rpc('rate_order', { p_order: o.id, p_stars: stars, p_comment: comment.trim() || null });
    setRateBusy(false);
    if (error) { notify(friendlyError(error, L)); return; }
    setRating({ stars, comment: comment.trim() || null });
  }
  const money = (v: number) => formatMoney(Number(v), fx, displayCurrency, L);
  const loc = ar ? 'ar-LB-u-nu-latn' : 'en-GB';
  const fmt = (iso: string, withDate = false) => new Date(iso).toLocaleString(loc, { timeZone: timezone, ...(withDate ? { day: 'numeric', month: 'short' } : {}), hour: '2-digit', minute: '2-digit' });

  const open = !['delivered', 'rejected', 'cancelled'].includes(o.status);
  useEffect(() => {
    if (!open) return;                                             // a closed order no longer changes: no polling, no socket
    const refresh = async () => {
      const { data } = await sb.from('orders').select('*').eq('id', o.id).maybeSingle();
      if (!data) return;
      setO(prev => { if ((data as Row).status !== prev.status) router.refresh(); return { ...prev, ...(data as Row) }; });   // a new step may bring a driver / payment: reload those too
    };
    const ch = sb.channel(`order:${o.id}`).on('postgres_changes', { event: 'UPDATE', schema: 'suqa', table: 'orders', filter: `id=eq.${o.id}` }, refresh).subscribe();
    const t = setInterval(refresh, 20000);
    return () => { sb.removeChannel(ch); clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.id, open]);

  async function cancel() {
    if (!(await ask(`${labels.cancelOrder}?`, { danger: true }))) return;
    const { error } = await sb.from('orders').update({ status: 'cancelled' }).eq('id', o.id);
    if (error) notify(friendlyError(error, L)); else setO(prev => ({ ...prev, status: 'cancelled' }));
  }

  // order again: today's prices and availability, straight into the cart
  async function reorder() {
    const ids = items.map(i => i.product_id).filter(Boolean) as string[];
    if (!ids.length) { router.push(`/s/${o.shop.slug}`); return; }
    setBusy(true);
    const { data, error } = await sb.from('products').select('id,name,unit,price_usd,is_available,is_active').in('id', ids);
    setBusy(false);
    if (error) { notify(friendlyError(error, L)); return; }
    const byId = new Map(((data as { id: string; name: Record<string, string>; unit: string | null; price_usd: number | string; is_available: boolean; is_active: boolean }[]) ?? []).map(p => [p.id, p]));
    const shopRef = { id: o.shop.id, slug: o.shop.slug, name: o.shop.name, whatsapp: o.shop.whatsapp, min_order_usd: Number(o.shop.min_order_usd ?? 0), pickup_enabled: o.shop.pickup_enabled !== false };
    let added = 0, missing = 0, refused = false;
    for (const i of items) {
      const p = i.product_id ? byId.get(i.product_id) : undefined;
      if (!p || !p.is_available || !p.is_active) { missing++; continue; }
      const before = cart.qtyOf(o.shop.id, p.id);
      if (before === 0) {
        await cart.add(shopRef, { product_id: p.id, name: p.name, unit: p.unit, price_usd: Number(p.price_usd) }, async () => { const ok = await ask(labels.replaceCart); if (!ok) refused = true; return ok; });
        if (refused) return;
      }
      cart.setQty(o.shop.id, p.id, before + Number(i.quantity));
      added++;
    }
    if (!added) { notify(ar ? 'أصناف هذا الطلب غير متوفّرة حالياً' : 'These items are not available right now'); return; }
    if (missing) notify(ar ? `${missing} صنف غير متوفّر حالياً لم يُضَف` : `${missing} item(s) unavailable — not added`);
    router.push('/cart');
  }

  const items = (o.items ?? []).filter(i => !i.voided);
  const pickup = o.fulfillment === 'pickup';
  const stopped = o.status === 'rejected' || o.status === 'cancelled';
  const labelsFor = pickup ? { ...statusLabels, ready: labels.readyForPickup, delivered: labels.pickedUp } : statusLabels;
  const headline = stopped ? statusLabels[o.status]
    : o.status === 'pending' ? (ar ? 'وصل طلبك إلى المحل — بانتظار القبول' : 'Your order reached the shop — waiting for it to accept')
    : o.status === 'out_for_delivery' ? (ar ? 'طلبك في الطريق إليك' : 'Your order is on its way')
    : o.status === 'delivered' ? (pickup ? labels.pickedUp : (ar ? 'تم تسليم طلبك' : 'Delivered'))
    : o.status === 'ready' ? (pickup ? labels.readyForPickup : (ar ? 'طلبك جاهز وسيخرج قريباً' : 'Ready — leaving soon'))
    : (ar ? 'المحل يحضّر طلبك' : 'The shop is preparing your order');
  const etaAt = o.needed_at ? new Date(o.needed_at) : o.eta_minutes && o.accepted_at ? new Date(new Date(o.accepted_at).getTime() + o.eta_minutes * 60000) : null;

  const totalCents = Number(o.total_cents) || Math.round(Number(o.total_usd) * 100);
  const rate = Number(o.fx_lbp_rate) || fx || 1;
  const paidCents = extra.payments.filter(p => p.tender !== 'unpaid').reduce((s, p) => s + (p.currency === 'lbp' ? Math.round((Number(p.amount) * 100) / rate) : Number(p.amount)), 0);
  const due = Math.max(0, totalCents - paidCents);

  const a = (o.address ?? {}) as unknown as Record<string, unknown>;
  const addr = [a.line1, a.line2, a.area, a.city].filter(Boolean).map(String).join(ar ? '، ' : ', ');
  const pt = (a.lat != null && a.lng != null) ? { lat: Number(a.lat), lng: Number(a.lng) } : pointFromEwkb(a.location as string | undefined);
  const mapUrl = a.map_url ? String(a.map_url) : pt ? `https://maps.google.com/?q=${pt.lat},${pt.lng}` : null;
  const shopTel = tel(o.shop?.phone || o.shop?.whatsapp), shopWa = digits(o.shop?.whatsapp || o.shop?.phone);
  const driver = extra.driver; const showDriver = !!driver && !pickup && (o.status === 'out_for_delivery' || o.status === 'delivered');
  const discount = Number(o.discount_cents ?? 0) / 100;

  return (
    <div className="stack">
      <nav className="crumbs"><Link href="/orders">{ar ? '›' : '‹'} {labels.myOrders}</Link><span className="muted" dir="ltr">{o.number}</span>{o.basket_id && <Link href={`/orders/b/${o.basket_id}`} className="muted">🧺</Link>}</nav>
      {props.justPlaced && <div className="card" style={{ background: '#f0fdf4', borderColor: '#bbf7d0' }}>✅ {labels.orderPlaced}</div>}

      <section className="card track-head">
        <div className="row spread" style={{ alignItems: 'center' }}>
          <strong style={{ fontSize: 18 }}>{tr(o.shop?.name, L)}</strong>
          <span className={`badge ${o.status}`}>{labelsFor[o.status]}</span>
        </div>
        <div className={`track-status ${stopped ? 'stopped' : o.status === 'delivered' ? 'done' : ''}`}>{stopped ? '✕' : o.status === 'delivered' ? '✅' : pickup ? '🛍️' : o.status === 'out_for_delivery' ? '🛵' : '⏳'} {headline}</div>
        {!stopped && <StatusTimeline status={o.status} labels={labelsFor} pickup={pickup} />}
        {stopped && (o.reject_reason || o.cancel_reason) && <div className="error">{o.reject_reason || o.cancel_reason}</div>}
        <div className="track-facts">
          <span>🧾 {ar ? 'طُلب' : 'Placed'} {fmt(o.placed_at, true)}</span>
          {open && etaAt && <span>⏰ {o.needed_at ? (ar ? 'الموعد المطلوب' : 'Requested for') : (ar ? 'متوقّع حوالى' : 'Expected around')} <strong dir="ltr">{fmt(etaAt.toISOString())}</strong></span>}
          {o.delivered_at && <span>{pickup ? '🛍️' : '🏠'} {pickup ? labels.pickedUp : (ar ? 'سُلّم' : 'Delivered')} {fmt(o.delivered_at, true)}</span>}
          {open && <span className="muted" style={{ fontSize: 12 }}>{ar ? 'تتحدّث الصفحة تلقائياً' : 'This page updates itself'}</span>}
        </div>
        <OrderThread orderId={o.id} you="customer" labels={{ title: labels.threadTitle, customer: labels.threadCustomer, shop: labels.threadShop }} />
      </section>

      {o.status === 'delivered' && <section className="card stack rate-card">
        <div className="row spread"><strong>{rating && !rateDirty ? (ar ? 'تقييمك لهذا الطلب' : 'Your rating') : (ar ? 'كيف كان طلبك؟' : 'How was your order?')}</strong>{rating && !rateDirty && <span className="muted" style={{ fontSize: 12 }}>✓ {ar ? 'شكراً — وصل تقييمك إلى المحل' : 'Thanks — the shop received it'}</span>}</div>
        <div className="stars" role="radiogroup" aria-label={ar ? 'التقييم' : 'Rating'} dir="ltr">
          {[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={`${n}/5`} className={n <= stars ? 'on' : ''} onClick={() => setStars(n)}>★</button>)}
        </div>
        {stars > 0 && (rateDirty || !rating) && <>
          <textarea className="input" rows={2} maxLength={500} placeholder={ar ? 'ملاحظة للمحل (اختياري)' : 'A note for the shop (optional)'} value={comment} onChange={e => setComment(e.target.value)} />
          <button className="btn primary" disabled={rateBusy} onClick={sendRating}>{rateBusy ? '…' : rating ? (ar ? 'تحديث التقييم' : 'Update rating') : (ar ? 'إرسال التقييم' : 'Send rating')}</button>
        </>}
        {rating && !rateDirty && rating.comment && <div style={{ fontSize: 14 }}>“{rating.comment}”</div>}
      </section>}

      {showDriver && driver && <section className="card track-contact">
        <div><div className="muted" style={{ fontSize: 12 }}>{ar ? 'السائق' : 'Driver'}</div><strong>🛵 {driver.name}</strong>{driver.vehicle && <span className="muted"> · {driver.vehicle}</span>}{driver.phone && <div className="muted" dir="ltr" style={{ fontSize: 13 }}>{tel(driver.phone)}</div>}</div>
        {driver.phone && <div className="track-actions">
          <a className="btn" href={`tel:${tel(driver.phone)}`}>📞 {labels.call}</a>
          <a className="btn wa" href={`https://wa.me/${digits(driver.phone)}`} target="_blank" rel="noreferrer">💬 WhatsApp</a>
        </div>}
      </section>}

      <section className="card track-contact">
        <div><div className="muted" style={{ fontSize: 12 }}>{ar ? 'المحل' : 'Shop'}</div><Link href={`/s/${o.shop.slug}`} style={{ color: 'inherit', fontWeight: 700 }}>🏪 {tr(o.shop?.name, L)}</Link>{o.shop?.address_text && <div className="muted" style={{ fontSize: 13 }}>{o.shop.address_text}</div>}{shopTel && <div className="muted" dir="ltr" style={{ fontSize: 13 }}>{shopTel}</div>}</div>
        <div className="track-actions">
          {shopTel && <a className="btn" href={`tel:${shopTel}`}>📞 {labels.call}</a>}
          {shopWa && <a className="btn wa" href={`https://wa.me/${shopWa}?text=${encodeURIComponent(`${ar ? 'بخصوص طلبي' : 'About my order'} ${o.number}`)}`} target="_blank" rel="noreferrer">💬 WhatsApp</a>}
        </div>
      </section>

      {!pickup && (addr || mapUrl) && <section className="card track-contact">
        <div><div className="muted" style={{ fontSize: 12 }}>{ar ? 'عنوان التوصيل' : 'Delivery address'}</div><span>📍 {addr || (ar ? 'موقع على الخريطة' : 'Map pin')}</span></div>
        {mapUrl && <div className="track-actions"><a className="btn" href={mapUrl} target="_blank" rel="noreferrer">🗺 {ar ? 'الخريطة' : 'Map'}</a></div>}
      </section>}

      <section className="card stack">
        <div className="row spread"><strong>{ar ? 'تفاصيل الطلب' : 'Order details'}</strong><span className="muted" style={{ fontSize: 13 }}>{items.length} {ar ? 'صنف' : items.length === 1 ? 'item' : 'items'}</span></div>
        {items.map(i => <div className="order-line" key={i.id}>
          <div><span className="qty">{Number(i.quantity)}×</span> {tr(i.name, L)}{i.unit ? <span className="muted"> · {i.unit}</span> : null}
            {Number(i.quantity) !== 1 && <div className="muted" style={{ fontSize: 12 }}>{money(i.unit_price_usd)} {ar ? 'للواحد' : 'each'}</div>}
            {i.notes && <div style={{ fontSize: 12, color: '#92400e' }}>📝 {i.notes}</div>}</div>
          <span>{money(i.line_total_usd)}</span>
        </div>)}
        <hr style={{ border: 0, borderTop: '1px dashed var(--line)', margin: 0, width: '100%' }} />
        {(discount > 0 || (!pickup && Number(o.delivery_fee_usd) > 0)) && <div className="row spread muted" style={{ fontSize: 13 }}><span>{ar ? 'مجموع الأصناف' : 'Items'}</span><span>{money(o.subtotal_usd)}</span></div>}
        {discount > 0 && <div className="row spread" style={{ fontSize: 13 }}><span>{ar ? 'خصم' : 'Discount'}</span><span>−{money(discount)}</span></div>}
        {pickup ? <div className="muted" style={{ fontSize: 13 }}>🛍️ {labels.pickupBadge}</div> : <div className="row spread muted" style={{ fontSize: 13 }}><span>{labels.deliveryFee}</span><span>{Number(o.delivery_fee_usd) > 0 ? money(o.delivery_fee_usd) : (ar ? 'مجاناً' : 'Free')}</span></div>}
        <div className="row spread" style={{ fontSize: 18 }}><strong>{labels.total}</strong><strong>{money(o.total_usd)}</strong></div>
        {o.customer_notes && <div style={{ fontSize: 13 }}><span className="muted">{labels.notes}:</span> {o.customer_notes}</div>}
      </section>

      {!stopped && (open || due === 0) && <section className={`card track-pay ${due > 0 ? 'due' : 'paid'}`}>
        {due > 0
          ? <><span>💵 {pickup ? (ar ? 'المطلوب عند الاستلام' : 'To pay at pickup') : (ar ? 'المطلوب عند التسليم' : 'To pay on delivery')}</span><strong>{money(due / 100)}</strong></>
          : <span>✓ {ar ? 'مدفوع' : 'Paid'}</span>}
      </section>}

      <div className="order-actions">
        {!open && <button className="btn primary" disabled={busy} onClick={reorder}>🔁 {ar ? 'اطلب من جديد' : 'Order again'}</button>}
        <a className="btn" href={`/r/${o.id}`} target="_blank" rel="noreferrer">🧾 {ar ? 'الإيصال' : 'Receipt'}</a>
        <Link href={`/s/${o.shop.slug}`} className="btn">🏪 {ar ? 'صفحة المحل' : 'Shop page'}</Link>
        {o.status === 'pending' && <button className="btn danger" onClick={cancel}>{labels.cancelOrder}</button>}
      </div>
    </div>
  );
}
