import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { getTenant } from '@/lib/tenant';
import { getLocale } from '@/lib/locale';
import { formatMoney, pointFromEwkb, t as tr, type LocalizedText } from '@suqa/shared';

export const dynamic = 'force-dynamic';

type Row = {
  id: string; number: string; status: string; placed_at: string; needed_at: string | null; fx_lbp_rate: number; subtotal_usd: number; delivery_fee_usd: number; total_usd: number;
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
export default async function DriverSheet({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = supabaseAdmin(); if (!admin || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const tenant = await getTenant(); const L = await getLocale(tenant); const ar = L === 'ar';
  const { data } = await admin.from('orders').select('id, number, status, placed_at, needed_at, fx_lbp_rate, subtotal_usd, delivery_fee_usd, total_usd, courier_fee_cents, paid_usd_cents, paid_lbp, customer_name, customer_phone, customer_notes, address, shop:shops(name, phone, whatsapp, address_text), items:order_items(name, quantity, unit, notes, voided), payments(tender, amount, currency)').eq('id', id).maybeSingle();
  const o = data as unknown as Row | null; if (!o) notFound();
  const money = (usd: number) => formatMoney(Number(usd), Number(o.fx_lbp_rate), tenant.display_currency ?? 'both', L);
  const paidUsd = o.payments.filter(p => p.tender !== 'unpaid').reduce((s, p) => s + (p.currency === 'lbp' ? Number(p.amount) / Number(o.fx_lbp_rate) : Number(p.amount) / 100), 0);
  const due = Math.max(0, Number(o.total_usd) - paidUsd);
  const shopPhone = o.shop?.whatsapp || o.shop?.phone || ''; const map = mapUrl(o.address); const address = addrText(o.address);
  const when = (iso: string | null) => iso ? new Date(iso).toLocaleString(ar ? 'ar-LB' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const Btn = ({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) => <a className={`btn ${primary ? 'primary' : ''}`} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" style={{ flex: 1, justifyContent: 'center' }}>{children}</a>;
  return (
    <main className="container narrow stack" style={{ paddingBottom: 24 }}>
      <h1 style={{ margin: '8px 0 0' }}>🛵 {ar ? 'توصيل' : 'Delivery'} {o.number}</h1>
      <div className="muted">{tr(o.shop?.name ?? {}, L)} · {when(o.placed_at)}{o.needed_at ? ` · ⏰ ${when(o.needed_at)}` : ''}</div>

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
