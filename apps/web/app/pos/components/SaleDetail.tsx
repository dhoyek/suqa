'use client';
import { useEffect, useState, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fillCents, fmtLbp, fmtUsd, num, returnDays, returnTooOld, returnedQty, text, type Order, type OrderLine, type Payment, type Staff } from '@suqa/pos-core';
import { pt, type Key, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import Modal from './Modal';
import { doPrint, loadPrintSettings, receiptHtml } from '../lib/print';
import { invoiceText, waHref } from '../lib/invoice';
import { can, roleOf } from '../lib/perm';
import ReasonDialog from './ReasonDialog';
import ReturnDialog from './ReturnDialog';

/**
 * Reports → tap a record: one sale in full — items with quantity × price, discount, total in $ and L.L., how it was paid, who sold
 * it — with print and WhatsApp. Read from this device (every till keeps the shop's orders), so it opens offline too.
 * Cancel from here: the operations log passes its own button (`actions`); elsewhere, give `staff` and the owner gets the same
 * cancel the log has for a sale — a counter sale paid in cash, not returned yet: reason, then the full return.
 * A sale that is not on this till (older than what it holds) is read from the server when `sb` is given and the till is online (93);
 * it is shown, printed and sent the same way, but cancelled from a till that holds it.
 */
/** ↩ Return items (107): with `staff`, a sale that was handed over, is on this till and still has something left to give back — some of
 * its items or all, within the shop's return period (the owner is not held to it). A sale still on credit is not refunded in cash. */
export function SaleDetail({ boot, locale, orderId, onClose, actions, staff: me, sb }: { boot: Booted; locale: L; orderId: string; onClose: () => void; actions?: ReactNode; staff?: Staff; sb?: SupabaseClient }) {
  const [d, setD] = useState<{ o: Order; lines: OrderLine[]; pays: Payment[]; staff: Staff[]; returned: boolean; left: boolean; remote?: boolean } | null | 'missing'>(null);
  const [ask, setAsk] = useState(false); const [ret, setRet] = useState<string | null>(null); const [part, setPart] = useState(false);
  useEffect(() => { void (async () => {
    const o = await boot.db.orders.get(orderId);
    if (!o) {
      if (sb && (typeof navigator === 'undefined' || navigator.onLine)) {
        const { data } = await sb.rpc('pos_sale_detail', { p_shop: boot.shop.id, p_order: orderId });
        const r = data as { order: Record<string, unknown>; lines: Record<string, unknown>[]; payments: Record<string, unknown>[]; returned: boolean } | null;
        if (r?.order) { setD({ o: fillCents('orders', r.order) as unknown as Order, lines: r.lines.map(l => fillCents('order_items', l) as unknown as OrderLine).filter(l => !l.voided), pays: r.payments as unknown as Payment[], staff: await boot.db.staff.toArray(), returned: r.returned, left: false, remote: true }); return; }
      }
      setD('missing'); return;
    }
    const [lines, pays, staff, rets] = await Promise.all([boot.db.orderLines.where('order_id').equals(orderId).toArray(), boot.db.payments.where('order_id').equals(orderId).toArray(), boot.db.staff.toArray(), boot.db.returns.where('order_id').equals(orderId).count()]);
    const back = rets > 0 ? await returnedQty(boot.db, orderId) : {};
    setD({ o, lines: lines.filter(l => !l.voided), pays, staff, returned: rets > 0, left: lines.some(l => !l.voided && num(l.quantity) - (back[l.id] ?? 0) > 0.0005) });
  })(); }, [boot, orderId, sb]);
  if (d === null) return null;
  if (d === 'missing') return <Modal open onClose={onClose} title={pt('saleDetails', locale)}><p className="muted">{pt('opsNotOnDevice', locale)}</p></Modal>;
  const { o, lines, pays, staff } = d; const rate = num(o.rate_lbp_per_usd);
  // the owner's cancel, same rule as the operations log: a counter sale, all cash, nothing given back yet
  const owner = !!me && can(roleOf(me), 'reports.profit'); const live = !d.remote && o.status !== 'cancelled' && o.status !== 'rejected' && !d.returned && !pays.some(p => num(p.amount) < 0);
  const why = !owner || actions || !live ? null : o.channel !== 'walkin' ? pt('opsWhyOrder', locale) : !pays.length || pays.some(p => p.tender !== 'cash_usd' && p.tender !== 'cash_lbp') ? pt('opsWhyNotCash', locale) : null;
  const canCancel = owner && !actions && live && !why;
  // ↩ some items back (107)
  const canSell = !!me && roleOf(me) !== 'setup'; const done = !d.remote && !o.parked && o.status === 'delivered';
  const onCredit = pays.some(p => p.tender === 'unpaid' && !p.settled_at);
  const whyNoReturn = !canSell || actions || !done ? null : !d.left ? pt('returnAllBack', locale) : onCredit ? pt('returnWhyDebt', locale) : !owner && returnTooOld(boot.shop, o) ? pt('returnTooOld', locale).replace('{n}', String(returnDays(boot.shop))) : null;
  const canReturn = canSell && !actions && done && !whyNoReturn;
  if (part && me) return <ReturnDialog boot={boot} locale={locale} order={o} lines={lines} staff={me} onDone={() => { boot.engine.poke(); onClose(); }} onClose={() => setPart(false)} />;
  if (ret != null && me) return <ReturnDialog boot={boot} locale={locale} order={o} lines={lines} staff={me} full presetReason={ret} onDone={() => { boot.engine.poke(); onClose(); }} onClose={() => setRet(null)} />;
  if (ask) return <ReasonDialog locale={locale} title={`${pt('opsCancel', locale)} · ${o.number ?? o.local_number ?? ''}`} line={<><strong dir="ltr">{o.number ?? o.local_number}</strong> {fmtUsd(num(o.total_cents))}</>} how={pt('opsSaleHow', locale)} onOk={r => { setAsk(false); setRet(r); }} onClose={() => setAsk(false)} />;
  const seller = staff.find(s => s.user_id === o.staff_user_id); const sellerName = seller?.display_name || seller?.full_name || '';
  const fee = num((o as unknown as { delivery_fee_cents?: number }).delivery_fee_cents);
  return (
    <Modal open onClose={onClose} wide title={<>🧾 {o.number ?? o.local_number ?? ''} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>· {fmtTime(o.placed_at, locale)}</span></>}
      footer={<>
        <button className="btn" onClick={() => doPrint(receiptHtml(o, lines, pays, boot.shop, locale, loadPrintSettings(), { again: true, cashier: sellerName }))}>🖨 {pt('print', locale)}</button>
        <a className="btn" href={waHref(o.customer_phone, invoiceText(o, lines, pays, boot.shop, locale, { url: `${location.origin}/r/${o.id}` }))} target="_blank" rel="noreferrer">💬 WhatsApp</a>
        {actions}{canReturn && <button className="btn" onClick={() => setPart(true)}>↩ {pt('returnItems', locale)}</button>}{canCancel && <button className="btn danger" onClick={() => setAsk(true)}>✕ {pt('opsCancel', locale)}</button>}
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
      {why && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>ⓘ {why}</p>}
      {whyNoReturn && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>ⓘ {whyNoReturn}</p>}
    </Modal>
  );
}

/** What a list of sales is narrowed to: one channel, one way of paying, one item, or one category ('' = items with no category). With an item or a category each row shows those items' quantity and amount. */
export type SalesFilter = { channel?: string; tender?: string; productId?: string; section?: string };
type SaleRow = { id: string; number: string | null; local_number: string | null; placed_at: string; customer_name: string | null; phone?: string | null; channel: string; items: number; qty: number | null; cents: number; paid_usd?: number | null; paid_lbp?: number | null };

/**
 * Reports → tap a day, a shift, a channel, a way of paying, an item or a category: its sales, newest first; tap one for its items.
 * With `sb` (the owner, online) the list is read from the server, with the report's own rules, so it agrees with the report's
 * totals for any period (93). Without it, or when the server cannot be reached, it is this till's own copy — which starts where
 * this till started — and the list says so.
 */
/** `plain` (the sale screen's "Recent sales", 107): no totals — a cashier finds a sale to reprint or return from, not the shop's turnover — and a box to find it by its number, the customer's name or phone. */
export function SalesList({ boot, locale, title, from, to, shiftId, filter, staff, sb, plain, onClose }: { boot: Booted; locale: L; title: string; from?: string; to?: string; shiftId?: string; filter?: SalesFilter; staff?: Staff; sb?: SupabaseClient; plain?: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SaleRow[] | null>(null); const [open, setOpen] = useState<string | null>(null);
  const [total, setTotal] = useState<{ count: number; cents: number; paid_usd?: number | null; paid_lbp?: number | null } | null>(null); const [local, setLocal] = useState(false);
  const byItem = filter?.productId != null || filter?.section != null;
  useEffect(() => { let on = true; void (async () => {
    if (sb && (typeof navigator === 'undefined' || navigator.onLine)) {
      const day = from ?? new Date().toISOString().slice(0, 10);
      const { data, error } = await sb.rpc('pos_report_sales', { p_shop: boot.shop.id, p_from: day, p_to: to ?? day, p_filter: { ...(shiftId ? { shift_id: shiftId } : {}), ...(filter?.channel ? { channel: filter.channel } : {}), ...(filter?.tender ? { tender: filter.tender } : {}), ...(filter?.productId != null ? { product_id: filter.productId } : {}), ...(filter?.section != null ? { section: filter.section } : {}) } });
      const r = data as { count: number; cents: number; paid_usd?: number | null; paid_lbp?: number | null; rows: SaleRow[] } | null;
      if (!error && r?.rows) { if (on) { setRows(r.rows.map(x => ({ ...x, cents: num(x.cents), qty: x.qty == null ? null : num(x.qty) }))); setTotal({ count: num(r.count), cents: num(r.cents), paid_usd: r.paid_usd, paid_lbp: r.paid_lbp }); setLocal(false); } return; }
    }
    let os: Order[];
    if (shiftId) os = (await boot.db.orders.toArray()).filter(o => o.shift_id === shiftId);
    else { const s = new Date(`${from}T00:00:00`); const e = new Date(`${to ?? from}T00:00:00`); e.setDate(e.getDate() + 1); os = await boot.db.orders.where('placed_at').between(s.toISOString(), e.toISOString()).toArray(); }
    os = os.filter(o => !o.parked && o.status !== 'cancelled' && o.status !== 'rejected').sort((a, b) => b.placed_at.localeCompare(a.placed_at));
    if (filter?.channel) os = os.filter(o => o.channel === filter.channel);
    // a way of paying: what each sale took that way; a sale whose rows add up to nothing there (a cancelled payment) is left out
    const took = new Map<string, { usd: number; lbp: number }>();
    if (filter?.tender) {
      for (const p of await boot.db.payments.toArray()) if (p.tender === filter.tender) { const t = took.get(p.order_id) ?? { usd: 0, lbp: 0 }; if (p.currency === 'lbp') t.lbp += num(p.amount); else t.usd += num(p.amount); took.set(p.order_id, t); }
      os = os.filter(o => { const t = took.get(o.id); return !!t && (t.usd !== 0 || t.lbp !== 0); });
    }
    const ids = new Set(os.map(o => o.id)); const count = new Map<string, number>(); const hit = new Map<string, { qty: number; cents: number }>();
    const inSection = filter?.section != null ? new Set((await boot.db.products.toArray()).filter(p => (p.section || '') === filter.section).map(p => p.id)) : null;
    const wanted = (pid: string | null | undefined) => (filter?.productId != null ? pid === filter.productId : inSection ? (pid ? inSection.has(pid) : filter?.section === '') : false);
    for (const l of await boot.db.orderLines.toArray()) if (ids.has(l.order_id) && !l.voided) {
      count.set(l.order_id, (count.get(l.order_id) ?? 0) + 1);
      if (byItem && wanted(l.product_id)) { const h = hit.get(l.order_id) ?? { qty: 0, cents: 0 }; h.qty += num(l.quantity); h.cents += num(l.line_total_cents); hit.set(l.order_id, h); }
    }
    if (byItem) os = os.filter(o => hit.has(o.id));
    if (!on) return;
    setRows(os.map(o => ({ id: o.id, number: o.number ?? null, local_number: o.local_number ?? null, placed_at: o.placed_at, customer_name: o.customer_name ?? null, phone: o.customer_phone ?? null, channel: o.channel, items: count.get(o.id) ?? 0,
      qty: byItem ? hit.get(o.id)!.qty : null, cents: byItem ? hit.get(o.id)!.cents : num(o.total_cents), paid_usd: filter?.tender ? took.get(o.id)!.usd : null, paid_lbp: filter?.tender ? took.get(o.id)!.lbp : null })));
    setTotal(null); setLocal(true);
  })(); return () => { on = false; }; }, [boot, sb, from, to, shiftId, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const sum = total?.cents ?? (rows ?? []).reduce((s, r) => s + r.cents, 0); const n = total?.count ?? rows?.length;
  // by way of paying: the amounts are what was taken that way (they add up to the report's line); the sale's total sits under them
  const byPaid = !!filter?.tender && !!rows?.length && rows.every(r => r.paid_usd != null || r.paid_lbp != null);
  const paid = (u: unknown, l: unknown) => [num(u as number) ? fmtUsd(num(u as number)) : '', num(l as number) ? fmtLbp(num(l as number), locale) : ''].filter(Boolean).join(' · ') || fmtUsd(0);
  const head = byPaid ? paid(total ? total.paid_usd : rows!.reduce((s, r) => s + num(r.paid_usd as number), 0), total ? total.paid_lbp : rows!.reduce((s, r) => s + num(r.paid_lbp as number), 0)) : fmtUsd(sum);
  const needle = q.trim().toLowerCase(); const digits = needle.replace(/\D/g, '');
  const shown = !rows || !needle ? rows : rows.filter(r => `${r.number ?? ''} ${r.local_number ?? ''} ${r.customer_name ?? ''}`.toLowerCase().includes(needle) || (digits.length >= 3 && (r.phone ?? '').replace(/\D/g, '').includes(digits)));
  return (
    <>
      <Modal open={!open} onClose={onClose} wide title={plain ? title : <>{title} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>· {n ?? '…'} · {head}</span></>}
        footer={<><span style={{ flex: 1 }} /><button className="btn primary" onClick={onClose}>{pt('ok', locale)}</button></>}>
        {local && !plain && <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>ⓘ {pt('salesOnDeviceOnly', locale)}</p>}
        {plain && <input className="input" style={{ marginBottom: 8 }} placeholder={pt('findSale', locale)} value={q} onChange={e => setQ(e.target.value)} />}
        {!shown ? <p className="muted">…</p> : !shown.length ? <p className="muted">—</p> : <table className="table clickable"><tbody>
          {shown.map(r => <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(r.id)}>
            <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.placed_at, locale)}</td>
            <td><strong dir="ltr">{r.number ?? r.local_number}</strong> <span className="muted">{r.customer_name || ''}</span><div className="muted" style={{ fontSize: 12 }}>{r.qty != null ? <>{pt('qty', locale)} <span dir="ltr">{r.qty}</span> · </> : null}{r.items} {pt('itemsCount', locale)} · {r.channel === 'online' ? pt('onlineShop', locale) : pt(r.channel as 'walkin', locale)}</div></td>
            <td className="num">{byPaid ? <>{paid(r.paid_usd, r.paid_lbp)}<div className="muted" style={{ fontSize: 12 }}>{pt('total', locale)} {fmtUsd(r.cents)}</div></> : fmtUsd(r.cents)}</td><td className="muted">›</td>
          </tr>)}
        </tbody></table>}
        {total && rows && total.count > rows.length && <p className="muted" style={{ fontSize: 12 }}>ⓘ {pt('salesFirstRows', locale).replace('{n}', String(rows.length))}</p>}
      </Modal>
      {open && <SaleDetail boot={boot} locale={locale} orderId={open} staff={staff} sb={sb} onClose={() => setOpen(null)} />}
    </>
  );
}
