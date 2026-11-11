import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { getTenant } from '@/lib/tenant';
import { getLocale } from '@/lib/locale';
import { formatMoney, pointFromEwkb, t as tr, type LocalizedText } from '@suqa/shared';

export const dynamic = 'force-dynamic';

type Row = {
  id: string; number: string; status: string; driver_id: string | null; driver_ack_at: string | null; driver_picked_at: string | null; driver_delivered_at: string | null; placed_at: string; needed_at: string | null; fx_lbp_rate: number; subtotal_usd: number; delivery_fee_usd: number; total_usd: number;
  courier_fee_cents: number; paid_usd_cents: number; paid_lbp: number; customer_name: string; customer_phone: string; customer_notes: string | null; address: Record<string, unknown> | null;
  shop: { name: LocalizedText; phone: string | null; whatsapp: string | null; address_text: string | null } | null;
  items: { name: LocalizedText; quantity: number; unit: string | null; notes: string | null; voided: boolean | null }[];
  payments: { tender: string; amount: number; currency: string }[];
};
const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');
const addrText = (a: Record<string, unknown> | null) => a ? [a.label, a.line1, a.line2, a.street, a.building, a.floor, a.area, a.city, a.notes].filter(Boolean).join('، ') : '';
const mapUrl = (a: Record<string, unknown> | null) => { if (!a) return ''; if (a.map_url) return String(a.map_url); const p = (a.lat != null && a.lng != null) ? { lat: Number(a.lat), lng: Number(a.lng) } : pointFromEwkb(a.location as string | undefined); return p ? `https://maps.google.com/?q=${p.lat},${p.lng}` : ''; };

/** /d/<order id> — the driver's sheet for one delivery: who to call (shop + customer), where, what, and what to collect.
 *  Public by unguessable id, like the receipt page; shows only what a driver needs. */
export default async function DriverSheet({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ack?: string }> }) {
  const { id } = await params; const { ack } = await searchParams;
  const admin = supabaseAdmin(); if (!admin || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const tenant = await getTenant(); const L = await getLocale(tenant); const ar = L === 'ar';
  // driver_* step columns come from schemas 52/53; until a database has them, read the sheet without them (no buttons)
  const SEL = 'id, number, status, driver_id, driver_ack_at, driver_picked_at, driver_delivered_at, placed_at, needed_at, fx_lbp_rate, subtotal_usd, delivery_fee_usd, total_usd, courier_fee_cents, paid_usd_cents, paid_lbp, customer_name, customer_phone, customer_notes, address, shop:shops(name, phone, whatsapp, address_text), items:order_items(name, quantity, unit, notes, voided), payments(tender, amount, currency)';
  let { data, error } = await admin.from('orders').select(SEL).eq('id', id).maybeSingle();
  if (error && /driver_/.test(error.message)) ({ data, error } = await admin.from('orders').select(SEL.replace(/driver_(ack|picked|delivered)_at, /g, '')).eq('id', id).maybeSingle());
  const o = data as unknown as Row | null; if (!o) notFound();
  // one currency per line, each kept on its own row so "ل.ل." never wraps away from its number
  const money = (usd: number) => { const parts = formatMoney(Number(usd), Number(o.fx_lbp_rate), tenant.display_currency ?? 'both', L).split(' · ');
    return <span className="money-stack">{parts.map((x, i) => <span key={i} dir="ltr" style={{ display: 'block', whiteSpace: 'nowrap', fontSize: i ? '0.85em' : undefined, opacity: i ? .75 : 1 }}>{x}</span>)}</span>; };
  const paidUsd = o.payments.filter(p => p.tender !== 'unpaid').reduce((s, p) => s + (p.currency === 'lbp' ? Number(p.amount) / Number(o.fx_lbp_rate) : Number(p.amount) / 100), 0);
  const due = Math.max(0, Number(o.total_usd) - paidUsd);
  const shopPhone = o.shop?.whatsapp || o.shop?.phone || ''; const map = mapUrl(o.address); const address = addrText(o.address);
  const when = (iso: string | null) => iso ? new Date(iso).toLocaleString(ar ? 'ar-LB' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const Btn = ({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) => <a className={`btn ${primary ? 'primary' : ''}`} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" style={{ flex: 1, justifyContent: 'center' }}>{children}</a>;
  return (
    <main className="container narrow stack" style={{ paddingBottom: 24 }}>
      <h1 style={{ margin: '8px 0 0' }}>🛵 {ar ? 'توصيل' : 'Delivery'} {o.number}</h1>
      <div className="muted">{tr(o.shop?.name ?? {}, L)} · {when(o.placed_at)}{o.needed_at ? ` · ⏰ ${when(o.needed_at)}` : ''}</div>

      {/* one tap so the shop knows he got it and is coming for the bag */}
      {o.driver_id && ['accepted', 'preparing', 'ready', 'out_for_delivery'].includes(o.status) && (() => {
        const hm = (iso: string) => new Date(iso).toLocaleTimeString(ar ? 'ar-LB-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
        const Step = ({ done, label, at }: { done: boolean; label: string; at: string | null }) => <span className={`dstep ${done ? 'done' : ''}`}>{done ? '✓' : '○'} {label}{at ? ` ${hm(at)}` : ''}</span>;
        const next = !o.driver_ack_at ? { action: `/api/d/${o.id}/ack`, s: '', label: ar ? '✅ استلمت الطلب — أنا قادم' : '✅ Got it — on my way', hint: ar ? 'اضغط ليعرف المحل أنك رأيت الطلب وستأتي لاستلامه.' : 'Tap so the shop knows you saw it and are coming.' }
          : !o.driver_picked_at ? { action: `/api/d/${o.id}/step`, s: 'picked', label: ar ? '📦 استلمت الطلب من المحل' : '📦 Picked up from the shop', hint: ar ? 'اضغط عند خروجك من المحل ومعك الطلب.' : 'Tap when you leave the shop with the order.' }
          : !o.driver_delivered_at ? { action: `/api/d/${o.id}/step`, s: 'delivered', label: ar ? '🏠 سلّمت الطلب للزبون' : '🏠 Handed to the customer', hint: due > 0 ? (ar ? 'بعد استلام المبلغ من الزبون.' : 'After collecting the amount.') : (ar ? 'عند تسليم الطلب.' : 'On handover.') }
          : null;
        return <section className="card stack" style={{ gap: 8 }}>
          <div className="dsteps"><Step done={!!o.driver_ack_at} label={ar ? 'تأكيد' : 'Confirmed'} at={o.driver_ack_at} /><Step done={!!o.driver_picked_at} label={ar ? 'استلام' : 'Picked up'} at={o.driver_picked_at} /><Step done={!!o.driver_delivered_at} label={ar ? 'تسليم' : 'Delivered'} at={o.driver_delivered_at} /></div>
          {next ? <form method="post" action={next.action} className="stack" style={{ gap: 6 }}>
              {next.s && <input type="hidden" name="s" value={next.s} />}
              <button className="btn primary big" type="submit" style={{ minHeight: 64, fontSize: 20 }}>{next.label}</button>
              <small className="muted">{next.hint}</small>
            </form>
            : <div style={{ fontWeight: 700, color: '#166534' }}>✓ {ar ? 'تم التسليم — أعد المبلغ المحصّل للمحل.' : 'Delivered — bring the collected amount back to the shop.'}</div>}
        </section>;
      })()}
      {ack === 'err' && <div className="card bad">{ar ? 'تعذّر التأكيد — الطلب لم يعد مفتوحاً. اتصل بالمحل.' : 'Could not confirm — the order is no longer open. Call the shop.'}</div>}

      <section className="card stack">
        <strong>🏪 {ar ? 'المحل' : 'Shop'}: {tr(o.shop?.name ?? {}, L)}</strong>
        {o.shop?.address_text && <div className="muted">{o.shop.address_text}</div>}
        {shopPhone && <div className="row" style={{ gap: 8 }}><Btn href={`tel:+${digits(shopPhone)}`}>📞 {ar ? 'اتصال بالمحل' : 'Call shop'}</Btn><Btn href={`https://wa.me/${digits(shopPhone)}`}>💬 WhatsApp</Btn></div>}
      </section>

      <section className="card stack">
        <strong>👤 {ar ? 'الزبون' : 'Customer'}: {o.customer_name || '—'}</strong>
        {address && <div>📍 {address}</div>}
        {map && <a className="btn primary" href={map} target="_blank" rel="noreferrer" style={{ justifyContent: 'center' }}>🗺️ {ar ? 'افتح الموقع على الخريطة' : 'Open location on map'}</a>}
        {!map && !address && <div className="muted">{ar ? 'لا عنوان مسجّل — اتصل بالزبون' : 'No address on file — call the customer'}</div>}
        {o.customer_phone && <div className="row" style={{ gap: 8 }}><Btn href={`tel:+${digits(o.customer_phone)}`}>📞 {ar ? 'اتصال بالزبون' : 'Call customer'}</Btn><Btn href={`https://wa.me/${digits(o.customer_phone)}`}>💬 WhatsApp</Btn></div>}
        {o.customer_notes && <div className="muted">📝 {o.customer_notes}</div>}
      </section>

      <section className="card stack">
        <strong>🧾 {ar ? 'الطلب' : 'Order'}</strong>
        <ul style={{ margin: 0, paddingInlineStart: 18 }}>{o.items.filter(i => !i.voided).map((i, k) => <li key={k}>{Number(i.quantity)}{i.unit ? ` ${i.unit}` : '×'} {tr(i.name, L)}{i.notes ? <span className="muted"> ({i.notes})</span> : null}</li>)}</ul>
        <table className="table"><tbody>
          <tr><td>{ar ? 'قيمة الطلب' : 'Order amount'}</td><td className="num">{money(Number(o.subtotal_usd))}</td></tr>
          <tr><td>{ar ? 'رسوم التوصيل' : 'Delivery fee'}</td><td className="num">{money(Number(o.delivery_fee_usd))}</td></tr>
          <tr><td><strong>{ar ? 'الإجمالي' : 'Total'}</strong></td><td className="num"><strong>{money(Number(o.total_usd))}</strong></td></tr>
          <tr style={{ background: due > 0 ? '#fff8e6' : '#ecfdf5' }}><td><strong>{due > 0 ? (ar ? '💵 المطلوب تحصيله من الزبون' : '💵 Collect from customer') : (ar ? '✓ مدفوع مسبقاً — لا تحصيل' : '✓ Prepaid — nothing to collect')}</strong></td><td className="num"><strong>{due > 0 ? money(due) : ''}</strong></td></tr>
          {Number(o.courier_fee_cents) > 0 && <tr><td className="muted">{ar ? 'أجرة السائق' : 'Driver fee'}</td><td className="num muted">{money(Number(o.courier_fee_cents) / 100)}</td></tr>}
        </tbody></table>
      </section>
      <p className="muted" style={{ fontSize: 12 }}>{ar ? 'تُحدَّث حالة الطلب من المحل عند التسليم.' : 'The shop marks the order delivered on handover.'}</p>
    </main>
  );
}
