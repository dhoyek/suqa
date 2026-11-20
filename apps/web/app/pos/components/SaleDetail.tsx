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
          <td style={{ textAlign: 'center' }}>{num(l.quantity)}{l.unit ? ` ${l.unit}` : ''}</td>
          <td className="num">{l.price_currency === 'lbp' ? fmtLbp(num(l.unit_price_lbp), locale) : fmtUsd(num(l.unit_price_cents))}{num(l.discount_cents) ? <div className="muted" style={{ fontSize: 12 }}>−{fmtUsd(num(l.discount_cents))}</div> : null}</td>
          <td className="num">{fmtUsd(num(l.line_total_cents))}</td>
        </tr>)}
        {num(o.discount_cents) > 0 && <tr><td colSpan={3}>{pt('discount', locale)}{o.discount_reason ? ` · ${o.discount_reason}` : ''}</td><td className="num">−{fmtUsd(num(o.discount_cents))}</td></tr>}
        {fee > 0 && <tr><td colSpan={3}>{pt('deliveryFee', locale)}</td><td className="num">{fmtUsd(fee)}</td></tr>}
        <tr style={{ fontWeight: 800 }}><td colSpan={3}>{pt('total', locale)} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· $1 = {rate.toLocaleString('en-US')}</span></td><td className="num">{fmtUsd(num(o.total_cents))}<div style={{ fontSize: 12 }}>{fmtLbp(num(o.total_lbp), locale)}</div></td></tr>
      </tbody></table>
      {!!pays.length && <table className="table" style={{ marginTop: 8 }}><tbody>
        <tr><th colSpan={3} style={{ textAlign: 'start' }}>{pt('payments', locale)}</th></tr>
        {pays.map(p => <tr key={p.id}><td className="muted">{fmtTime(p.at, locale)}</td><td>{pt(p.tender, locale)}{p.unpaid_name ? ` · ${p.unpaid_name}` : ''}{p.note ? <span className="muted"> · {p.note}</span> : null}</td><td className="num">{p.currency === 'lbp' ? fmtLbp(num(p.amount), locale) : fmtUsd(num(p.amount))}</td></tr>)}
      </tbody></table>}
    </Modal>
  );
}

/** Reports → tap a day or a shift: its sales, newest first; tap one for its items. */
export function SalesList({ boot, locale, title, from, to, shiftId, onClose }: { boot: Booted; locale: L; title: string; from?: string; to?: string; shiftId?: string; onClose: () => void }) {
  const [rows, setRows] = useState<{ o: Order; items: number }[] | null>(null); const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { void (async () => {
    let os: Order[];
    if (shiftId) os = (await boot.db.orders.toArray()).filter(o => o.shift_id === shiftId);
    else { const s = new Date(`${from}T00:00:00`); const e = new Date(`${to ?? from}T00:00:00`); e.setDate(e.getDate() + 1); os = await boot.db.orders.where('placed_at').between(s.toISOString(), e.toISOString()).toArray(); }
    os = os.filter(o => !o.parked && o.status !== 'cancelled' && o.status !== 'rejected').sort((a, b) => b.placed_at.localeCompare(a.placed_at));
    const ids = new Set(os.map(o => o.id)); const count = new Map<string, number>();
    for (const l of await boot.db.orderLines.toArray()) if (ids.has(l.order_id) && !l.voided) count.set(l.order_id, (count.get(l.order_id) ?? 0) + 1);
    setRows(os.map(o => ({ o, items: count.get(o.id) ?? 0 })));
  })(); }, [boot, from, to, shiftId]);
  const sum = (rows ?? []).reduce((s, r) => s + num(r.o.total_cents), 0);
  return (
    <>
      <Modal open={!open} onClose={onClose} wide title={<>{title} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>· {rows?.length ?? '…'} · {fmtUsd(sum)}</span></>}
        footer={<><span style={{ flex: 1 }} /><button className="btn primary" onClick={onClose}>{pt('ok', locale)}</button></>}>
        {!rows ? <p className="muted">…</p> : !rows.length ? <p className="muted">—</p> : <table className="table clickable"><tbody>
          {rows.map(({ o, items }) => <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(o.id)}>
            <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(o.placed_at, locale)}</td>
            <td><strong dir="ltr">{o.number ?? o.local_number}</strong> <span className="muted">{o.customer_name || ''}</span><div className="muted" style={{ fontSize: 12 }}>{items} {pt('itemsCount', locale)} · {o.channel === 'online' ? pt('onlineShop', locale) : pt(o.channel as 'walkin', locale)}</div></td>
            <td className="num">{fmtUsd(num(o.total_cents))}</td><td className="muted">›</td>
          </tr>)}
        </tbody></table>}
      </Modal>
      {open && <SaleDetail boot={boot} locale={locale} orderId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
