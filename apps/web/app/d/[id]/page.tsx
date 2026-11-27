import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { getTenant } from '@/lib/tenant';
import { getLocale } from '@/lib/locale';
import { formatMoney, pointFromEwkb, t as tr, type LocalizedText } from '@suqa/shared';
import DriverPay from './DriverPay';

export const dynamic = 'force-dynamic';

type Row = {
  id: string; number: string; status: string; driver_id: string | null; driver_ack_at: string | null; driver_picked_at: string | null; driver_delivered_at: string | null; placed_at: string; needed_at: string | null; fx_lbp_rate: number; subtotal_usd: number; delivery_fee_usd: number; total_usd: number;
  courier_fee_cents: number; paid_usd_cents: number; paid_lbp: number; customer_name: string; customer_phone: string; customer_notes: string | null; address: Record<string, unknown> | null;
  shop: { name: LocalizedText; phone: string | null; whatsapp: string | null; address_text: string | null } | null;
  items: { name: LocalizedText; quantity: number; unit: string | null; notes: string | null; voided: boolean | null }[];
  payments: { tender: string; amount: number; currency: string; settled_at: string | null }[];
};
const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');
const addrText = (a: Record<string, unknown> | null) => a ? [a.label, a.line1, a.line2, a.street, a.building, a.floor, a.area, a.city, a.notes].filter(Boolean).join('، ') : '';
const mapUrl = (a: Record<string, unknown> | null) => { if (!a) return ''; if (a.map_url) return String(a.map_url); const p = (a.lat != null && a.lng != null) ? { lat: Number(a.lat), lng: Number(a.lng) } : pointFromEwkb(a.location as string | undefined); return p ? `https://maps.google.com/?q=${p.lat},${p.lng}` : ''; };

/** /d/<order id> — the driver's sheet for one delivery: who to call (shop + customer), where, what, and what to collect.
 *  Public by unguessable id, like the receipt page; shows only what a driver needs. */
export default async function DriverSheet({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ack?: string; why?: string }> }) {
  const { id } = await params; const { ack, why } = await searchParams;
  const admin = supabaseAdmin(); if (!admin || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const tenant = await getTenant(); const L = await getLocale(tenant); const ar = L === 'ar';
  // driver_* step columns come from schemas 52/53; until a database has them, read the sheet without them (no buttons)
  const SEL = 'id, number, status, driver_id, driver_ack_at, driver_picked_at, driver_delivered_at, placed_at, needed_at, fx_lbp_rate, subtotal_usd, delivery_fee_usd, total_usd, courier_fee_cents, paid_usd_cents, paid_lbp, customer_name, customer_phone, customer_notes, address, shop:shops(name, phone, whatsapp, address_text), items:order_items(name, quantity, unit, notes, voided), payments(tender, amount, currency, settled_at)';
  let { data, error } = await admin.from('orders').select(SEL).eq('id', id).maybeSingle();
  if (error && /driver_/.test(error.message)) ({ data, error } = await admin.from('orders').select(SEL.replace(/driver_(ack|picked|delivered)_at, /g, '')).eq('id', id).maybeSingle());
  const o = data as unknown as Row | null; if (!o) notFound();
  // one currency per line, each kept on its own row so "ل.ل." never wraps away from its number
  const money = (usd: number) => { const parts = formatMoney(Number(usd), Number(o.fx_lbp_rate), tenant.display_currency ?? 'both', L).split(' · ');
    return <span className="money-stack">{parts.map((x, i) => <span key={i} dir="ltr" style={{ display: 'block', whiteSpace: 'nowrap', fontSize: i ? '0.85em' : undefined, opacity: i ? .75 : 1 }}>{x}</span>)}</span>; };
  const paidUsd = o.payments.filter(p => p.tender !== 'unpaid').reduce((s, p) => s + (p.currency === 'lbp' ? Number(p.amount) / Number(o.fx_lbp_rate) : Number(p.amount) / 100), 0);
  const due = Math.max(0, Math.round((Number(o.total_usd) - paidUsd) * 100) / 100);
  const drvPays = o.payments.filter(p => p.tender === 'driver'); const cashSettled = drvPays.length > 0 && drvPays.every(p => p.settled_at);
  const drvUsd = drvPays.filter(p => p.currency === 'usd').reduce((s, p) => s + Number(p.amount), 0) / 100, drvLbp = drvPays.filter(p => p.currency === 'lbp').reduce((s, p) => s + Number(p.amount), 0);
  // "$20.00 − 715,000 L.L.": a negative part is change he gave from his own pocket in that currency
  const cashStr = (u: number, l: number) => { const parts: [number, string][] = []; if (u) parts.push([u, `$${Math.abs(u).toFixed(2)}`]); if (l) parts.push([l, `${Math.abs(l).toLocaleString('en-US')} ${ar ? 'ل.ل.' : 'LBP'}`]); return parts.map(([n, t], i) => (i === 0 ? (n < 0 ? '− ' : '') : n < 0 ? ' − ' : ' + ') + t).join(''); };
  const debtUsd = o.payments.filter(p => p.tender === 'unpaid').reduce((s, p) => s + Number(p.amount), 0) / 100;
  // the pay screen's numbers (81); absent on a database without the script → the sheet shows no pay screen
  const { data: infoData } = o.driver_id && ['accepted', 'preparing', 'ready', 'out_for_delivery'].includes(o.status) ? await admin.rpc('driver_pay_info', { p_order: id }) : { data: null };
  const info = infoData as { card_ok?: boolean; due_cents: number; rate: number; lbp_step: number; can_debt: boolean; credit_limit_cents: number | null; debt_cents: number | null } | null;
  const WHY: Record<string, [string, string]> = { not_covered: ['المبلغ المُدخل أقل من المطلوب.', 'The amount entered is less than what is due.'], too_much: ['المبلغ المُدخل أكثر من المطلوب — راجع الباقي للزبون.', 'The amount entered is more than what is due — check the change.'], over_credit_limit: ['يتجاوز حدّ الدين المسموح لهذا الزبون. اتصل بالمحل.', 'Over this customer\'s credit limit. Call the shop.'], debt_needs_customer: ['لا رقم للزبون — لا يمكن تسجيل دين. اتصل بالمحل.', 'No customer number — a debt cannot be recorded. Call the shop.'], pay_required: ['أدخل ما دفعه الزبون.', 'Enter what the customer paid.'], bad_amount: ['مبلغ غير صحيح.', 'Invalid amount.'] };
  const shopPhone = o.shop?.whatsapp || o.shop?.phone || ''; const map = mapUrl(o.address); const address = addrText(o.address);
  const when = (iso: string | null) => iso ? new Date(iso).toLocaleString(ar ? 'ar-LB-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Beirut' }) : '';
  const Btn = ({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) => <a className={`btn ${primary ? 'primary' : ''}`} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" style={{ flex: 1, justifyContent: 'center' }}>{children}</a>;
  return (
    <main className="container narrow stack" style={{ paddingBottom: 24 }}>
      <h1 style={{ margin: '8px 0 0' }}>🛵 {ar ? 'توصيل' : 'Delivery'} {o.number}</h1>
      <div className="muted">{tr(o.shop?.name ?? {}, L)} · {when(o.placed_at)}{o.needed_at ? ` · ⏰ ${when(o.needed_at)}` : ''}</div>

      {/* one tap so the shop knows he got it and is coming for the bag */}
      {o.driver_id && ['accepted', 'preparing', 'ready', 'out_for_delivery'].includes(o.status) && (() => {
        const hm = (iso: string) => new Date(iso).toLocaleTimeString(ar ? 'ar-LB-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Beirut' });
        const Step = ({ done, label, at }: { done: boolean; label: string; at: string | null }) => <span className={`dstep ${done ? 'done' : ''}`}>{done ? '✓' : '○'} {label}{at ? ` ${hm(at)}` : ''}</span>;
        // both early taps are offered together: "got it" first (highlighted), "picked up" under it — he may skip straight to the second
        type Tap = { action: string; s: string; label: string; hint: string };
        const ackTap: Tap = { action: `/api/d/${o.id}/ack`, s: '', label: ar ? '✅ استلمت الرسالة — أنا قادم' : '✅ Got the message — coming', hint: ar ? 'ليعرف المحل أنك رأيت الطلب وستأتي لاستلامه.' : 'So the shop knows you saw it and are coming.' };
        const pickTap: Tap = { action: `/api/d/${o.id}/step`, s: 'picked', label: ar ? '📦 استلمت الطلب — أنا في الطريق' : '📦 Picked up — on my way', hint: ar ? 'عند خروجك من المحل ومعك الطلب. الزبون يُبلَّغ أن طلبه في الطريق.' : 'When you leave the shop with the order. The customer is told it is on its way.' };
        // "delivered" is final (81): with money to collect it is his pay screen, otherwise one tap
        const doneTap: Tap = { action: `/api/d/${o.id}/step`, s: 'delivered', label: ar ? '🏠 سلّمت الطلب للزبون' : '🏠 Handed to the customer', hint: ar ? 'يُقفل الطلب عند المحل.' : 'The order closes at the shop.' };
        const payNow = !o.driver_delivered_at && !!o.driver_picked_at && due > 0 && !!info;
        const taps: Tap[] = o.driver_delivered_at || payNow ? [] : o.driver_picked_at ? [doneTap] : o.driver_ack_at ? [pickTap] : [ackTap, pickTap];
        return <section className="card stack" style={{ gap: 8 }}>
          <div className="dsteps"><Step done={!!o.driver_ack_at} label={ar ? 'تأكيد' : 'Confirmed'} at={o.driver_ack_at} /><Step done={!!o.driver_picked_at} label={ar ? 'استلام' : 'Picked up'} at={o.driver_picked_at} /><Step done={!!o.driver_delivered_at} label={ar ? 'تسليم' : 'Delivered'} at={o.driver_delivered_at} /></div>
          {payNow && info ? <DriverPay orderId={o.id} dueCents={Number(info.due_cents)} rate={Number(info.rate)} step={Number(info.lbp_step)} canDebt={!!info.can_debt} cardOk={!!info.card_ok} creditLimitCents={info.credit_limit_cents == null ? null : Number(info.credit_limit_cents)} debtCents={info.debt_cents == null ? null : Number(info.debt_cents)} ar={ar} />
          : taps.length ? taps.map((t, i) => <form key={t.s || 'ack'} method="post" action={t.action} className="stack" style={{ gap: 4 }}>
              {t.s && <input type="hidden" name="s" value={t.s} />}
              <button className={`btn big ${i === 0 ? 'primary' : ''}`} type="submit" style={{ minHeight: i === 0 ? 64 : 52, fontSize: i === 0 ? 20 : 17 }}>{t.label}</button>
              <small className="muted">{t.hint}</small>
            </form>)
            : <div style={{ fontWeight: 700, color: '#166534' }}>✓ {ar ? 'تم التسليم — أعد المبلغ المحصّل للمحل.' : 'Delivered — bring the collected amount back to the shop.'}</div>}
        </section>;
      })()}
      {/* closed by the driver (or the shop): what he holds for this order, and the way to his account */}
      {o.driver_id && o.status === 'delivered' && <section className="card stack" style={{ gap: 6, background: '#ecfdf5' }}>
        <strong style={{ color: '#166534' }}>✓ {ar ? 'تم التسليم' : 'Delivered'}{o.driver_delivered_at ? ` · ${when(o.driver_delivered_at)}` : ''}</strong>
        {(drvUsd !== 0 || drvLbp !== 0) && <div>{ar ? '💵 النقد معك لهذا الطلب' : '💵 Cash with you for this order'}: <strong dir="ltr">{cashStr(drvUsd, drvLbp)}</strong>{cashSettled ? <span className="muted"> · ✓ {ar ? 'سُلِّم للمحل' : 'handed to the shop'}</span> : <span> — {ar ? 'سلّمه للمحل' : 'hand it to the shop'}</span>}</div>}
        {debtUsd > 0 && <div className="muted">📒 {ar ? 'دين على الزبون' : 'Debt on the customer'}: <span dir="ltr">${debtUsd.toFixed(2)}</span></div>}
      </section>}
      {o.driver_id && <a className="btn" href={`/d/me/${o.driver_id}`} style={{ justifyContent: 'center' }}>💰 {ar ? 'حسابي مع المحل' : 'My account with the shop'}</a>}
      {ack === 'err' && <div className="card bad">{why && WHY[why] ? WHY[why][ar ? 0 : 1] : ar ? 'تعذّر التأكيد — الطلب لم يعد مفتوحاً. اتصل بالمحل.' : 'Could not confirm — the order is no longer open. Call the shop.'}</div>}

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
          <tr style={{ background: due > 0 ? '#fff8e6' : '#ecfdf5' }}><td><strong>{due > 0 ? (o.status === 'delivered' ? (ar ? '📒 غير مدفوع — دين على الزبون' : '📒 Unpaid — on the customer') : ar ? '💵 المطلوب تحصيله من الزبون' : '💵 Collect from customer') : (ar ? '✓ مدفوع مسبقاً — لا تحصيل' : '✓ Prepaid — nothing to collect')}</strong></td><td className="num"><strong>{due > 0 ? money(due) : ''}</strong></td></tr>
          {Number(o.courier_fee_cents) > 0 && <tr><td className="muted">{ar ? 'أجرة السائق' : 'Driver fee'}</td><td className="num muted">{money(Number(o.courier_fee_cents) / 100)}</td></tr>}
        </tbody></table>
      </section>
      <p className="muted" style={{ fontSize: 12 }}>{ar ? 'عند ضغطك «سلّمت الطلب» يُقفل الطلب عند المحل. المحل يستطيع تصحيح المبلغ إن لزم.' : 'Your "delivered" tap closes the order at the shop. The shop can correct the amount if needed.'}</p>
    </main>
  );
}
