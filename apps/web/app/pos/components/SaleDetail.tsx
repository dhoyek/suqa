'use client';
import { useEffect, useState } from 'react';
import { fmtLbp, fmtUsd, num, text, type Order, type OrderLine, type Payment, type Staff } from '@suqa/pos-core';
import { pt, type Key, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import Modal from './Modal';
import { doPrint, loadPrintSettings, receiptHtml } from '../lib/print';
import { invoiceText, waHref } from '../lib/invoice';

/**
 * Reports → tap a record: one sale in full — items with quantity × price, discount, total in $ and L.L., how it was paid, who sold
 * it — with print and WhatsApp. Read from this device (every till keeps the shop's orders), so it opens offline too.
 */
export function SaleDetail({ boot, locale, orderId, onClose }: { boot: Booted; locale: L; orderId: string; onClose: () => void }) {
  const [d, setD] = useState<{ o: Order; lines: OrderLine[]; pays: Payment[]; staff: Staff[] } | null | 'missing'>(null);
  useEffect(() => { void (async () => {
    const o = await boot.db.orders.get(orderId); if (!o) { setD('missing'); return; }
    const [lines, pays, staff] = await Promise.all([boot.db.orderLines.where('order_id').equals(orderId).toArray(), boot.db.payments.where('order_id').equals(orderId).toArray(), boot.db.staff.toArray()]);
    setD({ o, lines: lines.filter(l => !l.voided), pays, staff });
  })(); }, [boot, orderId]);
  if (d === null) return null;
  if (d === 'missing') return <Modal open onClose={onClose} title={pt('saleDetails', locale)}><p className="muted">{pt('opsNotOnDevice', locale)}</p></Modal>;
  const { o, lines, pays, staff } = d; const rate = num(o.rate_lbp_per_usd);
  const seller = staff.find(s => s.user_id === o.staff_user_id); const sellerName = seller?.display_name || seller?.full_name || '';
  const fee = num((o as unknown as { delivery_fee_cents?: number }).delivery_fee_cents);
  return (
    <Modal open onClose={onClose} wide title={<>🧾 {o.number ?? o.local_number ?? ''} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>· {fmtTime(o.placed_at, locale)}</span></>}
      footer={<>
        <button className="btn" onClick={() => doPrint(receiptHtml(o, lines, pays, boot.shop, locale, loadPrintSettings(), { again: true, cashier: sellerName }))}>🖨 {pt('print', locale)}</button>
        <a className="btn" href={waHref(o.customer_phone, invoiceText(o, lines, pays, boot.shop, locale, { url: `${location.origin}/r/${o.id}` }))} target="_blank" rel="noreferrer">💬 WhatsApp</a>
        <span style={{ flex: 1 }} /><button className="btn primary" onClick={onClose}>{pt('ok', locale)}</button></>}>
      <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
        {o.channel === 'online' ? pt('onlineShop', locale) : pt(o.channel as 'walkin', locale)} · {pt(`st_${o.status}` as Key, locale)}{sellerName ? ` · ${pt('cashier', locale)}: ${sellerName}` : ''}
        {(o.customer_name || o.customer_phone) && <> · 👤 {o.customer_name || ''} <span dir="ltr">{o.customer_phone || ''}</span></>}
      </div>
      <table className="table"><tbody>
        <tr><th style={{ textAlign: 'start' }}>{pt('items', locale)}</th><th>{pt('qty', locale)}</th><th className="num">{pt('price', locale)}</th><th className="num">{pt('total', locale)}</th></tr>
        {lines.map(l => <tr key={l.id}>
          <td>{text(l.name, locale)}{l.notes && <div className="muted" style={{ fontSize: 12 }}>📝 {l.notes}</div>}</td>
          <td style={{ textAlign: 'center' }} dir="ltr">{num(l.quantity)}{l.unit ? (/^\d/.test(l.unit) ? ` × ${l.unit}` : ` ${l.unit}`) : ''}</td>
          <td className="num">{l.price_currency === 'lbp' ? fmtLbp(num(l.unit_price_lbp), locale) : fmtUsd(num(l.unit_price_cents))}{num(l.discount_cents) ? <div className="muted" style={{ fontSize: 12 }}>−{fmtUsd(num(l.discount_cents))}</div> : null}</td>
          <td className="num">{fmtUsd(num(l.line_total_cents))}</td>
        </tr>)}
        {num(o.discount_cents) > 0 && <tr><td colSpan={3}>{pt('discount', locale)}{o.discount_reason ? ` · ${o.discount_reason}` : ''}</td><td className="num">−{fmtUsd(num(o.discount_cents))}</td></tr>}
        {fee > 0 && <tr><td colSpan={3}>{pt('deliveryFee', locale)}</td><td className="num">{fmtUsd(fee)}</td></tr>}
        <tr style={{ fontWeight: 800 }}><td colSpan={3}>{pt('total', locale)} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· $1 = {rate.toLocaleString('en-US')}</span></td><td className="num">{fmtUsd(num(o.total_cents))}<div style={{ fontSize: 12 }}>{fmtLbp(num(o.total_lbp), locale)}</div></td></tr>
      </tbody></table>
      {!!pays.length && <table className="table" style={{ marginTop: 8 }}><tbody>
        <tr><th colSpan={3} style={{ textAlign: 'start' }}>{pt('payments', locale)}</th></tr>
        {pays.map(p => { const refund = num(p.amount) < 0 || /^refund /.test(p.note ?? ''); const amt = Math.abs(num(p.amount)); return <tr key={p.id} className={refund ? 'bad' : undefined}><td className="muted">{fmtTime(p.at, locale)}</td><td>{refund ? `↩ ${pt('refund', locale)} · ` : ''}{pt(p.tender, locale)}{p.unpaid_name ? ` · ${p.unpaid_name}` : ''}{p.note && !refund ? <span className="muted"> · {p.note}</span> : null}</td><td className="num">{refund ? '−' : ''}{p.currency === 'lbp' ? fmtLbp(amt, locale) : fmtUsd(amt)}</td></tr>; })}
      </tbody></table>}
    </Modal>
  );
}

/** What a list of sales is narrowed to: one channel, one way of paying, or the sales holding given items (then each row shows those items' quantity and amount). */
export type SalesFilter = { channel?: string; tender?: string; productIds?: string[]; noProduct?: boolean };

/** Reports → tap a day, a shift, a channel, a way of paying, an item or a category: its sales, newest first; tap one for its items. */
export function SalesList({ boot, locale, title, from, to, shiftId, filter, onClose }: { boot: Booted; locale: L; title: string; from?: string; to?: string; shiftId?: string; filter?: SalesFilter; onClose: () => void }) {
  const [rows, setRows] = useState<{ o: Order; items: number; qty: number | null; cents: number }[] | null>(null); const [open, setOpen] = useState<string | null>(null);
  const byItem = !!(filter?.productIds || filter?.noProduct);
  useEffect(() => { void (async () => {
    let os: Order[];
    if (shiftId) os = (await boot.db.orders.toArray()).filter(o => o.shift_id === shiftId);
    else { const s = new Date(`${from}T00:00:00`); const e = new Date(`${to ?? from}T00:00:00`); e.setDate(e.getDate() + 1); os = await boot.db.orders.where('placed_at').between(s.toISOString(), e.toISOString()).toArray(); }
    os = os.filter(o => !o.parked && o.status !== 'cancelled' && o.status !== 'rejected').sort((a, b) => b.placed_at.localeCompare(a.placed_at));
    if (filter?.channel) os = os.filter(o => o.channel === filter.channel);
    if (filter?.tender) { const paid = new Set((await boot.db.payments.toArray()).filter(p => p.tender === filter.tender).map(p => p.order_id)); os = os.filter(o => paid.has(o.id)); }
    const ids = new Set(os.map(o => o.id)); const count = new Map<string, number>(); const hit = new Map<string, { qty: number; cents: number }>();
    const want = new Set(filter?.productIds ?? []);
    for (const l of await boot.db.orderLines.toArray()) if (ids.has(l.order_id) && !l.voided) {
      count.set(l.order_id, (count.get(l.order_id) ?? 0) + 1);
      if (byItem && (l.product_id ? want.has(l.product_id) : !!filter?.noProduct)) { const h = hit.get(l.order_id) ?? { qty: 0, cents: 0 }; h.qty += num(l.quantity); h.cents += num(l.line_total_cents); hit.set(l.order_id, h); }
    }
    if (byItem) os = os.filter(o => hit.has(o.id));
    setRows(os.map(o => ({ o, items: count.get(o.id) ?? 0, qty: byItem ? hit.get(o.id)!.qty : null, cents: byItem ? hit.get(o.id)!.cents : num(o.total_cents) })));
  })(); }, [boot, from, to, shiftId, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const sum = (rows ?? []).reduce((s, r) => s + r.cents, 0);
  return (
    <>
      <Modal open={!open} onClose={onClose} wide title={<>{title} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>· {rows?.length ?? '…'} · {fmtUsd(sum)}</span></>}
        footer={<><span style={{ flex: 1 }} /><button className="btn primary" onClick={onClose}>{pt('ok', locale)}</button></>}>
        {!rows ? <p className="muted">…</p> : !rows.length ? <p className="muted">—</p> : <table className="table clickable"><tbody>
          {rows.map(({ o, items, qty, cents }) => <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(o.id)}>
            <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(o.placed_at, locale)}</td>
            <td><strong dir="ltr">{o.number ?? o.local_number}</strong> <span className="muted">{o.customer_name || ''}</span><div className="muted" style={{ fontSize: 12 }}>{qty != null ? <>{pt('qty', locale)} <span dir="ltr">{qty}</span> · </> : null}{items} {pt('itemsCount', locale)} · {o.channel === 'online' ? pt('onlineShop', locale) : pt(o.channel as 'walkin', locale)}</div></td>
            <td className="num">{fmtUsd(cents)}</td><td className="muted">›</td>
          </tr>)}
        </tbody></table>}
      </Modal>
      {open && <SaleDetail boot={boot} locale={locale} orderId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
