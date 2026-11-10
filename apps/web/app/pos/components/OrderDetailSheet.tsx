'use client';
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fmtLbp, fmtUsd, num, text, type Order, type OrderLine, type Payment } from '@suqa/pos-core';
import Modal from './Modal';
import { pt, type Key, type L } from '../i18n';
import { fmtTime } from '../lib/boot';

type Hist = {
  events: { at: string; from: string | null; to: string | null; actor: string; note: string | null; by: string | null }[];
  audit: { at: string; action: string; after: Record<string, unknown> | null; by: string | null; device: string | null }[];
  payments: { at: string; tender: string; currency: 'usd' | 'lbp'; amount: number; unpaid_name: string | null; reference: string | null }[];
  debt: { at: string; amount_cents: number; tender: string; currency: 'usd' | 'lbp'; amount: number }[];
  returns: { at: string; number: string | null; refund_usd_cents: number; refund_lbp: number; reason: string | null; lines: { qty: number; destination: string; amount_cents: number; name: Record<string, string> | null }[] | null }[];
  stock: { at: string; kind: string; qty: number; name: Record<string, string> | null }[];
  messages: { at: string; direction: 'in' | 'out'; party: string; phone: string; body: string | null; status: string | null; error: string | null }[];
  customer: { name: string; phone: string; orders_count: number; last_order_at: string | null; notes: string | null; open_debt_cents: number } | null;
};
type Tab = 'timeline' | 'edits' | 'payments' | 'returns' | 'messages' | 'stock';

const when = (iso: string, locale: L) => new Date(iso).toLocaleString(locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Everything that happened to one order, read from the server (works only online; the local mirror has no history). */
export default function OrderDetailSheet({ sb, locale, order, lines, payments, online, onCustomer, onClose }: { sb: SupabaseClient; locale: L; order: Order; lines: OrderLine[]; payments: Payment[]; online: boolean; onCustomer?: (phone: string, name: string) => void; onClose: () => void }) {
  const [h, setH] = useState<Hist | null>(null); const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('timeline');
  useEffect(() => {
    if (!online) { setErr(pt('offlineHistory', locale)); return; }
    sb.rpc('pos_order_history', { p_order: order.id }).then(({ data, error }) => { if (error) setErr(error.message); else setH(data as Hist); });
  }, [sb, order.id, online, locale]);
  const live = lines.filter(l => !l.voided);
  const edits = (h?.audit ?? []).filter(a => a.action === 'order.edit' || a.action === 'order.delete' || a.action === 'driver.upsert' || a.action === 'order.pay' || a.action === 'order.status' || a.action === 'return.commit' || a.action === 'sale.cancel');
  const onlyEdits = edits.filter(a => a.action === 'order.edit');
  const tabs: [Tab, string, number][] = [
    ['timeline', pt('tabTimeline', locale), (h?.events.length ?? 0) + (h?.audit.filter(a => a.action === 'order.status').length ?? 0)],
    ['edits', pt('tabEdits', locale), onlyEdits.length],
    ['payments', pt('tabPayments', locale), (h?.payments.length ?? payments.length) + (h?.debt.length ?? 0)],
    ['returns', pt('tabReturns', locale), h?.returns.length ?? 0],
    ['messages', pt('tabMessages', locale), h?.messages.length ?? 0],
    ['stock', pt('tabStock', locale), h?.stock.length ?? 0],
  ];
  const c = h?.customer;
  return (
    <Modal open onClose={onClose} title={`🧾 ${order.number ?? order.local_number} · ${order.customer_name || ''}`} wide>
      <div className="detail-head">
        <div className="muted" style={{ fontSize: 13 }}>{pt(order.channel as Key, locale)} · {order.fulfillment === 'pickup' ? pt('pickupBadge', locale) : pt('deliveryBadge', locale)} · {pt(`st_${order.status}` as Key, locale)} · {fmtTime(order.placed_at, locale)}</div>
        <div className="order-items" style={{ fontSize: 13 }}>{live.map(l => <div key={l.id}>{num(l.quantity)}{l.unit ? ' ' + l.unit : '×'} {text(l.name, locale)}{l.notes ? <span className="muted"> ({l.notes})</span> : ''} <span className="muted num">{fmtUsd(num(l.line_total_cents))}</span></div>)}</div>
        <div className="num" style={{ fontSize: 13 }}>{pt('subtotal', locale)} {fmtUsd(num(order.subtotal_cents))}{num(order.discount_cents) > 0 ? ` − ${fmtUsd(num(order.discount_cents))}` : ''}{num(order.delivery_fee_usd) > 0 ? ` + 🛵 ${fmtUsd(Math.round(num(order.delivery_fee_usd) * 100))}` : ''} = <strong>{fmtUsd(num(order.total_cents))}</strong> <span className="muted">· {fmtLbp(num(order.total_lbp), locale)}</span></div>
        {c && <div className="detail-customer">
          <span>👤 <strong>{c.name || order.customer_name}</strong> <span dir="ltr" className="muted">{c.phone}</span></span>
          <span className="muted">{c.orders_count} {pt('ordersCount', locale)}{c.last_order_at ? ` · ${pt('lastOrder', locale)} ${when(c.last_order_at, locale)}` : ''}</span>
          {c.open_debt_cents > 0 && <span className="pill bad">{pt('debtShort', locale)} {fmtUsd(c.open_debt_cents)}</span>}
          {c.notes && <span className="muted">📝 {c.notes}</span>}
          {onCustomer && <button className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} onClick={() => { onClose(); onCustomer(c.phone, c.name || order.customer_name); }}>{pt('customerPage', locale)} ←</button>}
        </div>}
      </div>
      <div className="detail-tabs">{tabs.map(([k, label, n]) => <button key={k} className={`chip ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}{n ? <span className="muted"> {n}</span> : ''}</button>)}</div>
      {err && <p className="bad">{err}</p>}
      {!h && !err && <p className="muted">…</p>}
      {h && tab === 'timeline' && <ul className="timeline">
        {[...h.events.map(e => ({ at: e.at, text: `${e.to ? pt(`st_${e.to}` as Key, locale) : ''}${e.note ? ` — ${e.note}` : ''}`, by: e.by ?? pt(`actor_${e.actor}` as Key, locale), icon: e.note && !e.to ? '💬' : '●' })),
          ...h.audit.filter(a => a.action === 'order.status' || a.action === 'driver.upsert' || a.action === 'sale.cancel' || a.action === 'order.delete').map(a => ({ at: a.at, text: `${pt('posAction', locale)}: ${a.action === 'order.status' ? pt(`st_${String(a.after?.status ?? '')}` as Key, locale) : a.action}${a.after?.driver_id ? ' 🛵' : ''}${a.after?.eta_minutes ? ` · ETA ${String(a.after.eta_minutes)} ${pt('min', locale)}` : ''}${a.after?.reject_reason || a.after?.cancel_reason ? ` — ${String(a.after?.reject_reason ?? a.after?.cancel_reason)}` : ''}`, by: [a.by, a.device].filter(Boolean).join(' · '), icon: '▸' }))]
          .sort((a, b) => a.at.localeCompare(b.at))
          .map((x, i) => <li key={i}><span className="muted num" style={{ minWidth: 92 }}>{when(x.at, locale)}</span><span>{x.icon} {x.text}</span><span className="muted">{x.by}</span></li>)}
        {!h.events.length && !h.audit.length && <li className="muted">{pt('nothingYet', locale)}</li>}
      </ul>}
      {h && tab === 'edits' && <ul className="timeline">
        {onlyEdits.map((a, i) => { const ls = (a.after?.lines as Record<string, unknown>[] | undefined) ?? []; const res = a.after?.result as Record<string, unknown> | undefined; return (
          <li key={i} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
            <div className="row spread"><span className="muted num">{when(a.at, locale)}</span><span className="muted">{[a.by, a.device].filter(Boolean).join(' · ')}{a.after?.notify === false ? ` · 🔕` : ' · 🔔'}</span></div>
            {a.after?.note ? <div>📝 {String(a.after.note)}</div> : null}
            <div style={{ fontSize: 13 }}>{ls.map((l, j) => <div key={j}>{l.voided ? `🗑 ${pt('removeLine', locale)}` : l.new_id ? `＋ ${text((l.name as Record<string, string>) ?? {}, locale)} × ${l.qty}` : `✎ ${pt('qty', locale)} → ${l.qty}`}{l.id && !l.new_id ? <span className="muted"> · {text(lines.find(x => x.id === l.id)?.name ?? {}, locale)}</span> : ''}</div>)}</div>
            {res && res.total_cents != null && <div className="muted num" style={{ fontSize: 12 }}>{pt('total', locale)} → {fmtUsd(num(res.total_cents as number))}</div>}
          </li>); })}
        {!onlyEdits.length && <li className="muted">{pt('nothingYet', locale)}</li>}
      </ul>}
      {h && tab === 'payments' && <ul className="timeline">
        {h.payments.map((p, i) => <li key={'p' + i}><span className="muted num" style={{ minWidth: 92 }}>{when(p.at, locale)}</span><span>{pt(p.tender as Key, locale)}{p.unpaid_name ? ` · ${p.unpaid_name}` : ''}{p.reference ? ` · ${p.reference}` : ''}</span><strong className="num">{p.currency === 'lbp' ? fmtLbp(num(p.amount), locale) : fmtUsd(num(p.amount))}</strong></li>)}
        {h.debt.map((d, i) => <li key={'d' + i}><span className="muted num" style={{ minWidth: 92 }}>{when(d.at, locale)}</span><span>💵 {pt('debtSettled', locale)} · {pt(d.tender as Key, locale)}</span><strong className="num">{fmtUsd(num(d.amount_cents))}</strong></li>)}
        {num(order.change_usd_cents) + num(order.change_lbp) > 0 && <li><span style={{ minWidth: 92 }} /><span>{pt('change', locale)}</span><span className="num">{num(order.change_usd_cents) ? fmtUsd(num(order.change_usd_cents)) : fmtLbp(num(order.change_lbp), locale)}</span></li>}
        {num(order.courier_fee_cents) > 0 && <li><span style={{ minWidth: 92 }} /><span>🛵 {pt('driverFee', locale)}{order.courier_name ? ` · ${order.courier_name}` : ''}</span><span className="num">{fmtUsd(num(order.courier_fee_cents))}</span></li>}
        {!h.payments.length && !h.debt.length && <li className="muted">{pt('unpaidOrder', locale)}</li>}
      </ul>}
      {h && tab === 'returns' && <ul className="timeline">
        {h.returns.map((r, i) => <li key={i} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
          <div className="row spread"><span className="muted num">{when(r.at, locale)} · {r.number ?? ''}</span><strong className="num">{r.refund_usd_cents ? fmtUsd(num(r.refund_usd_cents)) : fmtLbp(num(r.refund_lbp), locale)}</strong></div>
          {r.reason && <div>📝 {r.reason}</div>}
          <div style={{ fontSize: 13 }}>{(r.lines ?? []).map((l, j) => <div key={j}>{num(l.qty)} × {text(l.name ?? {}, locale)} → {pt(l.destination === 'stock' ? 'toStock' : 'toDamaged', locale)} <span className="muted num">{fmtUsd(num(l.amount_cents))}</span></div>)}</div>
        </li>)}
        {!h.returns.length && <li className="muted">{pt('nothingYet', locale)}</li>}
      </ul>}
      {h && tab === 'messages' && <ul className="timeline">
        {h.messages.map((m, i) => <li key={i} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
          <div className="row spread"><span className="muted num">{when(m.at, locale)} · {m.direction === 'out' ? '📤' : '📥'} {pt(`party_${m.party}` as Key, locale)} <span dir="ltr">+{m.phone}</span></span><span className={`pill ${m.status === 'failed' ? 'bad' : m.status === 'read' || m.status === 'delivered' ? 'ok' : ''}`}>{m.status ?? '—'}</span></div>
          {m.body && <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.body}</div>}
          {m.error && <div className="bad" style={{ fontSize: 12 }}>{m.error}</div>}
        </li>)}
        {!h.messages.length && <li className="muted">{pt('nothingYet', locale)}</li>}
      </ul>}
      {h && tab === 'stock' && <ul className="timeline">
        {h.stock.map((s, i) => <li key={i}><span className="muted num" style={{ minWidth: 92 }}>{when(s.at, locale)}</span><span>{pt(`move_${s.kind}` as Key, locale)} · {text(s.name ?? {}, locale)}</span><strong className="num">{num(s.qty) > 0 ? '+' : ''}{num(s.qty)}</strong></li>)}
        {!h.stock.length && <li className="muted">{pt('nothingYet', locale)}</li>}
      </ul>}
    </Modal>
  );
}
