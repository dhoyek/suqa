'use client';
import { useEffect, useState } from 'react';
import { fmtLbp, fmtUsd, num, text, type Order, type OrderLine, type Payment } from '@suqa/pos-core';
import Modal from './Modal';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';

/** Read-only order sheet (lines, payments, totals) — opened from anywhere an order number is shown. */
export default function OrderDetail({ boot, locale, order, onClose, onCustomer }: { boot: Booted; locale: L; order: Order; onClose: () => void; onCustomer?: (phone: string, name: string) => void }) {
  const [lines, setLines] = useState<OrderLine[]>([]); const [pays, setPays] = useState<Payment[]>([]);
  useEffect(() => { boot.db.orderLines.where('order_id').equals(order.id).toArray().then(ls => setLines(ls.filter(l => !l.voided))); boot.db.payments.where('order_id').equals(order.id).toArray().then(setPays); }, [boot, order.id]);
  const o = order as Order & { total_cents?: number; discount_cents?: number; rate_lbp_per_usd?: number; placed_at?: string; created_at?: string; staff_name?: string | null };
  const total = num(o.total_cents ?? 0); const rate = num(o.rate_lbp_per_usd ?? 0);
  return (
    <Modal open onClose={onClose} title={`🧾 ${order.number || order.local_number || ''}`} footer={<><span className="muted" style={{ fontSize: 12 }}>{pt(`st_${order.status}` as Parameters<typeof pt>[0], locale)} · {order.channel === 'online' ? pt('onlineShop', locale) : pt(order.channel as Parameters<typeof pt>[0], locale)}</span><span style={{ flex: 1 }} /><button className="btn primary" onClick={onClose}>{pt('ok', locale)}</button></>}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row spread muted" style={{ fontSize: 13 }}>
          <span>{fmtTime(o.placed_at ?? o.created_at ?? '', locale)}</span>
          {(order.customer_name || order.customer_phone) && (onCustomer
            ? <button className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} onClick={() => onCustomer(order.customer_phone, order.customer_name)}>👤 {order.customer_name || order.customer_phone}</button>
            : <span>👤 {order.customer_name || order.customer_phone}</span>)}
        </div>
        <table className="table"><tbody>
          {lines.map(l => <tr key={l.id}><td>{text(l.name, locale)}{l.notes ? <div className="muted" style={{ fontSize: 12 }}>{l.notes}</div> : null}</td><td className="num muted">{num(l.quantity)} × {l.price_currency === 'lbp' ? fmtLbp(num(l.unit_price_lbp), locale) : fmtUsd(num(l.unit_price_cents))}</td><td className="num">{fmtUsd(num(l.line_total_cents))}</td></tr>)}
          {!lines.length && <tr><td className="muted">—</td></tr>}
        </tbody></table>
        {!!num(o.discount_cents) && <div className="row spread muted"><span>{pt('discount', locale)}</span><span>− {fmtUsd(num(o.discount_cents))}</span></div>}
        <div className="row spread" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}><strong>{pt('total', locale)}</strong><strong>{fmtUsd(total)}{rate ? <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}> · {fmtLbp(Math.round(total * rate / 100), locale)}</span> : null}</strong></div>
        {pays.map(p => <div className="row spread muted" key={p.id} style={{ fontSize: 13 }}><span>{pt(p.tender as Parameters<typeof pt>[0], locale)}{p.note ? ` · ${p.note}` : ''}</span><span>{p.currency === 'lbp' ? fmtLbp(num(p.amount), locale) : fmtUsd(num(p.amount))}</span></div>)}
        {order.customer_notes && <div className="muted" style={{ fontSize: 13 }}>📝 {order.customer_notes}</div>}
      </div>
    </Modal>
  );
}
