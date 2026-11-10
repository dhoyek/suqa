import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { getTenant } from '@/lib/tenant';
import { STATUS_LABEL } from '@/lib/ui-text';
import StatusTimeline from '@/components/StatusTimeline';
import { pointFromEwkb, type OrderStatus } from '@suqa/shared';
import AutoRefresh from './AutoRefresh';

// Public order page (QR / WhatsApp "track your order" link). The order id is a v7 UUID — not guessable.
// Walk-in sales show the receipt only. WhatsApp / phone orders also show where the order is (stepper), ETA, who is bringing it
// (driver with call / WhatsApp) and how to reach the shop; it refreshes itself while the order is still open.
// Shown: the customer's own delivery address (the link goes to them). Never shown: the customer's phone, cost, internal notes.
export const dynamic = 'force-dynamic';
const usd = (c: number) => '$' + (c / 100).toFixed(2);
const lbp = (n: number, ar: boolean) => Number(n).toLocaleString('en-US') + (ar ? ' ل.ل.' : ' LBP');
const digits = (p?: string | null) => String(p ?? '').replace(/\D/g, '').replace(/^00/, '');
const tel = (p?: string | null) => { const d = digits(p); return d ? `+${d}` : ''; };

type Row = {
  id: string; number: string | null; local_number: string | null; status: OrderStatus; channel: string; fulfillment: 'delivery' | 'pickup';
  placed_at: string; accepted_at: string | null; delivered_at: string | null; closed_at: string | null; needed_at: string | null; eta_minutes: number | null;
  reject_reason: string | null; cancel_reason: string | null; address: Record<string, unknown> | null; delivery_fee_usd: number | string | null;
  rate_lbp_per_usd: number; subtotal_cents: number; discount_cents: number; total_cents: number; total_lbp: number; change_usd_cents: number; change_lbp: number;
  tenant_id: string; driver_id: string | null; courier_name: string | null;
  shop: { name: Record<string, string>; phone?: string | null; whatsapp?: string | null; receipt_footer?: string | null; address_text?: string | null } | null;
  items: Array<{ name: Record<string, string>; quantity: number | string; unit?: string | null; notes?: string | null; price_currency: string; unit_price_cents: number; unit_price_lbp: number; discount_cents: number; line_total_cents: number; voided: boolean }>;
  payments: Array<{ tender: string; amount: number; currency: string }>;
};

export default async function OrderPublicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = supabaseAdmin(); const t = await getTenant();
  if (!admin || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { data } = await admin.from('orders').select('id, number, local_number, status, channel, fulfillment, placed_at, accepted_at, delivered_at, closed_at, needed_at, eta_minutes, reject_reason, cancel_reason, address, delivery_fee_usd, rate_lbp_per_usd, subtotal_cents, discount_cents, total_cents, total_lbp, change_usd_cents, change_lbp, tenant_id, driver_id, courier_name, shop:shops(name, phone, whatsapp, receipt_footer, address_text), items:order_items(name, quantity, unit, notes, price_currency, unit_price_cents, unit_price_lbp, discount_cents, line_total_cents, voided), payments(tender, amount, currency)').eq('id', id).maybeSingle();
  const o = data as unknown as Row | null;
  if (!o || o.tenant_id !== t.id) notFound();
  const L = t.default_locale === 'en' ? 'en' : 'ar'; const ar = L === 'ar';
  const shop = o.shop;
  const tx = (n: Record<string, string> | null | undefined) => n?.[L] || n?.ar || n?.en || '';
  const fmt = (iso: string, withDate = false) => new Date(iso).toLocaleString(ar ? 'ar-LB-u-nu-latn' : 'en-GB', withDate ? { dateStyle: 'short', timeStyle: 'short' } : { hour: '2-digit', minute: '2-digit' });
  const tender: Record<string, string> = ar ? { cash_usd: 'نقدي $', cash_lbp: 'نقدي ل.ل.', card: 'بطاقة', wallet: 'محفظة', unpaid: 'غير مدفوع' } : { cash_usd: 'Cash USD', cash_lbp: 'Cash LBP', card: 'Card', wallet: 'Wallet', unpaid: 'Unpaid' };
  const items = o.items.filter(i => !i.voided);
  const tracked = o.channel !== 'walkin';
  const open = !o.closed_at && !['delivered', 'rejected', 'cancelled'].includes(o.status);
  const pickup = o.fulfillment === 'pickup';
  const stopped = o.status === 'rejected' || o.status === 'cancelled';
  const statusLabels = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [k, v[L]])) as Record<OrderStatus, string>;
  if (pickup) { statusLabels.ready = ar ? 'جاهز للاستلام' : 'Ready for pickup'; statusLabels.delivered = ar ? 'تم الاستلام' : 'Picked up'; }

  // driver (POS orders carry the shop's driver id; online/courier orders may only have a name)
  type Drv = { name: string; phone: string | null; vehicle: string | null };
  let driver: Drv | null = null;
  if (o.driver_id) { const { data: d } = await admin.from('shop_drivers').select('name, phone, vehicle').eq('id', o.driver_id).maybeSingle(); if (d) driver = d as Drv; }
  if (!driver && o.courier_name) driver = { name: o.courier_name, phone: null, vehicle: null };
  const showDriver = !!driver && !pickup && (o.status === 'out_for_delivery' || o.status === 'delivered');

  // what the customer still owes at the door
  const rate = Number(o.rate_lbp_per_usd) || 1;
  const paidCents = o.payments.filter(p => p.tender !== 'unpaid').reduce((s, p) => s + (p.currency === 'lbp' ? Math.round((Number(p.amount) * 100) / rate) : Number(p.amount)), 0);
  const due = Math.max(0, o.total_cents - paidCents);

  // ETA: promised minutes after acceptance, or the time the customer asked for
  const etaAt = o.needed_at ? new Date(o.needed_at) : o.eta_minutes && o.accepted_at ? new Date(new Date(o.accepted_at).getTime() + o.eta_minutes * 60000) : null;
  const a = (o.address ?? {}) as Record<string, unknown>;
  const addr = [a.line1, a.line2, a.area, a.city].filter(Boolean).map(String).join('، ');
  const pt = (a.lat != null && a.lng != null) ? { lat: Number(a.lat), lng: Number(a.lng) } : pointFromEwkb(a.location as string | undefined);
  const mapUrl = a.map_url ? String(a.map_url) : pt ? `https://maps.google.com/?q=${pt.lat},${pt.lng}` : null;
  const shopWa = digits(shop?.whatsapp || shop?.phone); const shopTel = tel(shop?.phone || shop?.whatsapp);
  const headline = stopped ? statusLabels[o.status]
    : o.status === 'pending' ? (ar ? 'وصل طلبك إلى المحل' : 'Your order reached the shop')
    : o.status === 'out_for_delivery' ? (ar ? 'طلبك في الطريق إليك' : 'Your order is on its way')
    : o.status === 'delivered' ? (pickup ? statusLabels.delivered : (ar ? 'تم تسليم طلبك' : 'Delivered'))
    : o.status === 'ready' ? (pickup ? statusLabels.ready : (ar ? 'طلبك جاهز وسيخرج قريباً' : 'Ready — leaving soon'))
    : (ar ? 'المحل يحضّر طلبك' : 'The shop is preparing your order');

  return (
    <main className="container track-page" style={{ maxWidth: 480, padding: 16 }} dir={ar ? 'rtl' : 'ltr'}>
      {tracked && open && <AutoRefresh seconds={30} />}
      {tracked && <>
        <section className="card track-head">
          <div className="row spread" style={{ alignItems: 'center' }}>
            <strong style={{ fontSize: 18 }}>{tx(shop?.name)}</strong>
            <span className="muted" dir="ltr" style={{ fontSize: 13 }}>{o.number ?? o.local_number}</span>
          </div>
          <div className={`track-status ${stopped ? 'stopped' : o.status === 'delivered' ? 'done' : ''}`}>{pickup ? '🛍️' : o.status === 'out_for_delivery' ? '🛵' : stopped ? '✕' : o.status === 'delivered' ? '✅' : '⏳'} {headline}</div>
          {!stopped && <StatusTimeline status={o.status} labels={statusLabels} pickup={pickup} />}
          {stopped && (o.reject_reason || o.cancel_reason) && <p className="bad" style={{ margin: '6px 0 0' }}>{o.reject_reason || o.cancel_reason}</p>}
          <div className="track-facts">
            <span>🧾 {fmt(o.placed_at, true)}</span>
            {open && etaAt && <span>⏰ {o.needed_at ? (ar ? 'الموعد المطلوب' : 'Requested for') : (ar ? 'متوقّع حوالى' : 'Expected around')} <strong dir="ltr">{fmt(etaAt.toISOString())}</strong></span>}
            {o.delivered_at && <span>{pickup ? '🛍️' : '🏠'} {fmt(o.delivered_at, true)}</span>}
            {open && <span className="muted" style={{ fontSize: 12 }}>{ar ? 'تتحدّث الصفحة تلقائياً' : 'This page updates itself'}</span>}
          </div>
        </section>

        {showDriver && driver && <section className="card track-contact">
          <div><div className="muted" style={{ fontSize: 12 }}>{ar ? 'السائق' : 'Driver'}</div><strong>🛵 {driver.name}</strong>{driver.vehicle && <span className="muted"> · {driver.vehicle}</span>}{driver.phone && <div className="muted" dir="ltr" style={{ fontSize: 13 }}>{tel(driver.phone)}</div>}</div>
          {driver.phone && <div className="track-actions">
            <a className="btn" href={`tel:${tel(driver.phone)}`}>📞 {ar ? 'اتصال' : 'Call'}</a>
            <a className="btn wa" href={`https://wa.me/${digits(driver.phone)}`} target="_blank" rel="noreferrer">💬 WhatsApp</a>
          </div>}
        </section>}

        <section className="card track-contact">
          <div><div className="muted" style={{ fontSize: 12 }}>{ar ? 'المحل' : 'Shop'}</div><strong>🏪 {tx(shop?.name)}</strong>{shop?.address_text && <div className="muted" style={{ fontSize: 13 }}>{shop.address_text}</div>}{shopTel && <div className="muted" dir="ltr" style={{ fontSize: 13 }}>{shopTel}</div>}</div>
          <div className="track-actions">
            {shopTel && <a className="btn" href={`tel:${shopTel}`}>📞 {ar ? 'اتصال' : 'Call'}</a>}
            {shopWa && <a className="btn wa" href={`https://wa.me/${shopWa}?text=${encodeURIComponent(`${ar ? 'بخصوص طلبي' : 'About my order'} ${o.number ?? o.local_number ?? ''}`)}`} target="_blank" rel="noreferrer">💬 WhatsApp</a>}
          </div>
        </section>

        {!pickup && (addr || mapUrl) && <section className="card track-contact">
          <div><div className="muted" style={{ fontSize: 12 }}>{ar ? 'عنوان التوصيل' : 'Delivery address'}</div><span>📍 {addr || (ar ? 'موقع على الخريطة' : 'Map pin')}</span></div>
          {mapUrl && <div className="track-actions"><a className="btn" href={mapUrl} target="_blank" rel="noreferrer">🗺 {ar ? 'الخريطة' : 'Map'}</a></div>}
        </section>}

        {!stopped && <section className={`card track-pay ${due > 0 ? 'due' : 'paid'}`}>
          {due > 0
            ? <><span>💵 {pickup ? (ar ? 'المطلوب عند الاستلام' : 'To pay at pickup') : (ar ? 'المطلوب عند التسليم' : 'To pay on delivery')}</span><span className="money-stack" dir="ltr"><strong>{usd(due)}</strong><small>{lbp(Math.round((due * rate) / 100), ar)}</small></span></>
            : <span>✓ {ar ? 'مدفوع' : 'Paid'}</span>}
        </section>}
      </>}

      <div className="card receipt-card" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 14 }}>
        {!tracked && <div style={{ textAlign: 'center' }}><strong style={{ fontSize: 18 }}>{tx(shop?.name)}</strong>{shop?.phone && <div className="muted" dir="ltr">{shop.phone}</div>}</div>}
        <div className="row spread muted" style={{ margin: '4px 0 10px', fontSize: 12 }}><span>{tracked ? (ar ? 'تفاصيل الطلب' : 'Order details') : `${ar ? 'رقم' : 'No.'} ${o.number ?? o.local_number}`}</span>{!tracked && <span>{fmt(o.placed_at, true)}</span>}</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
          {items.map((i, k) => <tr key={k}><td style={{ padding: '4px 0' }}>{tx(i.name)}{i.notes && <div style={{ fontSize: 12, color: '#92400e' }}>📝 {i.notes}</div>}<div className="muted" style={{ fontSize: 12 }}>{Number(i.quantity)}{i.unit ? ` ${i.unit}` : ''} × {i.price_currency === 'usd' ? usd(i.unit_price_cents) : lbp(i.unit_price_lbp, ar)}{i.discount_cents ? ` − ${usd(i.discount_cents)}` : ''}</div></td><td style={{ textAlign: 'end', verticalAlign: 'top' }} dir="ltr">{usd(i.line_total_cents)}</td></tr>)}
        </tbody></table>
        <hr style={{ border: 0, borderTop: '1px dashed var(--line)', margin: '8px 0' }} />
        {(o.discount_cents > 0 || Number(o.delivery_fee_usd) > 0) && <div className="row spread muted"><span>{ar ? 'المجموع' : 'Subtotal'}</span><span dir="ltr">{usd(o.subtotal_cents)}</span></div>}
        {o.discount_cents > 0 && <div className="row spread"><span>{ar ? 'خصم' : 'Discount'}</span><span dir="ltr">−{usd(o.discount_cents)}</span></div>}
        {Number(o.delivery_fee_usd) > 0 && <div className="row spread"><span>{ar ? 'التوصيل' : 'Delivery'}</span><span dir="ltr">{usd(Math.round(Number(o.delivery_fee_usd) * 100))}</span></div>}
        <div className="row spread" style={{ fontSize: 18, fontWeight: 700, alignItems: 'flex-start' }}><span>{ar ? 'الإجمالي' : 'Total'}</span><span className="money-stack" dir="ltr" style={{ textAlign: 'end' }}><span>{usd(o.total_cents)}</span><small style={{ display: 'block', fontSize: 14 }}>{lbp(o.total_lbp, ar)}</small></span></div>
        <div className="row spread muted" style={{ fontSize: 12 }}><span>{ar ? 'سعر الصرف' : 'Rate'}</span><span dir="ltr">$1 = {Number(o.rate_lbp_per_usd).toLocaleString('en-US')}</span></div>
        {o.payments.map((p, k) => <div key={k} className="row spread"><span>{tender[p.tender] ?? p.tender}</span><span dir="ltr">{p.currency === 'lbp' ? lbp(p.amount, ar) : usd(p.amount)}</span></div>)}
        {(o.change_usd_cents > 0 || o.change_lbp > 0) && <div className="row spread"><span>{ar ? 'الباقي' : 'Change'}</span><span dir="ltr">{o.change_usd_cents ? usd(o.change_usd_cents) : lbp(o.change_lbp, ar)}</span></div>}
        <p className="muted" style={{ textAlign: 'center', marginTop: 12 }}>{shop?.receipt_footer || (ar ? 'شكراً لزيارتكم' : 'Thank you')}</p>
      </div>
    </main>
  );
}
