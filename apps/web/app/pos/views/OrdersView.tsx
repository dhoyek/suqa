'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NEXT, cashMove, currentShift, deleteOrder, editOrder, fmtLbp, fmtUsd, num, payOrder, setOrderStatus, text, type CatalogIndex, type Currency, type Order, type OrderLine, type OrderStatus, type Payment, type Product, type Rate, type Staff, type SyncStatus, waDigits, type Driver } from '@suqa/pos-core';
import { pt, type L, type Key } from '../i18n';
import { pointFromEwkb } from '@suqa/shared';
import OrderThread from '@/components/OrderThread';
import DriverPicker from '../components/DriverPicker';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import { doPrint, loadPrintSettings, receiptHtml } from '../lib/print';
import Modal, { NumPad } from '../components/Modal';
import PayDialog from '../components/PayDialog';
import ReturnDialog from '../components/ReturnDialog';
import OwnerPin from '../components/OwnerPin';
import { useConfirm } from '@/components/ConfirmProvider';
import OrderDetailSheet from '../components/OrderDetailSheet';
import { newOrderChime } from '../lib/chime';
import type { SupabaseClient } from '@supabase/supabase-js';
import { orderSheetHtml } from '../lib/print';

type Col = 'new' | 'active' | 'onway' | 'done' | 'cancelled';
const COLS: Col[] = ['new', 'active', 'onway', 'done', 'cancelled'];
const COL_OF: Record<OrderStatus, Col> = { pending: 'new', accepted: 'active', preparing: 'active', ready: 'active', out_for_delivery: 'onway', delivered: 'done', rejected: 'cancelled', cancelled: 'cancelled' };
const LS_COLS = 'suqa-pos-order-cols';
const loadCols = (): Set<Col> => { try { const v = JSON.parse(localStorage.getItem(LS_COLS) ?? 'null'); if (Array.isArray(v) && v.length) return new Set(v as Col[]); } catch {} return new Set<Col>(['new', 'active', 'onway', 'done']); };

/**
 * The shop's single order inbox: online, WhatsApp and phone orders side by side (walk-in sales live in Reports).
 * Reads the local mirror (works offline); every action queues an op; the feed brings other devices' actions back within seconds.
 * Handover: pickup → pay dialog; courier delivery → cash on delivery recorded automatically; already-paid orders just close.
 */
export default function OrdersView({ boot, sb, locale, index, tick, staff, status, onNewOrder, onCustomer }: { boot: Booted; sb: SupabaseClient; locale: L; index: CatalogIndex; tick: number; staff: Staff; status?: SyncStatus | null; onNewOrder: () => void; onCustomer?: (phone: string, name: string) => void }) {
  const online = status?.online ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [orders, setOrders] = useState<Order[]>([]);
  const [lines, setLines] = useState<Record<string, OrderLine[]>>({});
  const [payments, setPayments] = useState<Record<string, Payment[]>>({});
  const [rate, setRate] = useState(89500);
  const [dialog, setDialog] = useState<null | { k: 'reject' | 'cancel' | 'eta' | 'driver'; o: Order } | { k: 'edit'; o: Order } | { k: 'pay'; o: Order; status: OrderStatus } | { k: 'return'; o: Order } | { k: 'detail'; o: Order }>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState(''); const [range, setRange] = useState<'today' | 'yesterday' | '7d' | 'all'>('today'); const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [, setClock] = useState(0); useEffect(() => { const t = setInterval(() => setClock(c => c + 1), 30_000); return () => clearInterval(t); }, []);   // ages tick every 30 s
  const ackSeen = useRef<Set<string> | null>(null); const [ackToast, setAckToast] = useState<string | null>(null);
  const reload = async () => {
    const since = new Date(Date.now() - (range === '7d' || range === 'all' ? 8 * 24 : 48) * 3600_000).toISOString();
    const all = (await boot.db.orders.toArray()).filter(o => o.channel !== 'walkin' && !o.parked && (!o.closed_at || o.closed_at > since));
    // open orders: the ones wanted soonest first (scheduled ones by their time, ASAP ones by when they came in); closed ones newest first
    const open = (o: Order) => !o.closed_at; const k = (o: Order) => o.needed_at ?? o.placed_at;
    all.sort((a, b) => open(a) && open(b) ? (k(a) < k(b) ? -1 : 1) : (a.placed_at < b.placed_at ? 1 : -1));
    // a driver just confirmed one of our orders → chime + toast (only for confirmations that arrive while the board is open)
    const acked = new Set(all.filter(o => o.driver_ack_at).map(o => o.id));
    if (ackSeen.current) { const fresh = all.find(o => o.driver_ack_at && !ackSeen.current!.has(o.id)); if (fresh) { newOrderChime(); setAckToast(`🛵✅ ${fresh.courier_name ?? ''} — ${fresh.number ?? fresh.local_number ?? ''} ${pt('driverAcked', locale)}`); setTimeout(() => setAckToast(null), 6000); } }
    ackSeen.current = acked;
    setOrders(all);
    const ids = all.map(o => o.id);
    const ls = await boot.db.orderLines.where('order_id').anyOf(ids).toArray(); const ps = await boot.db.payments.where('order_id').anyOf(ids).toArray();
    const lm: Record<string, OrderLine[]> = {}; for (const l of ls) (lm[l.order_id] ??= []).push(l); setLines(lm);
    const pm: Record<string, Payment[]> = {}; for (const p of ps) (pm[p.order_id] ??= []).push(p); setPayments(pm);
    boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { if (r) setRate(r.lbp_per_usd); });
  };
  useEffect(() => { void reload(); }, [boot, tick, range]); // eslint-disable-line react-hooks/exhaustive-deps
  const paidCents = (o: Order) => (payments[o.id] ?? []).filter(p => p.tender !== 'unpaid').reduce((s, p) => s + (p.currency === 'lbp' ? Math.round((num(p.amount) * 100) / (num(o.rate_lbp_per_usd) || rate)) : num(p.amount)), 0);
  const isPaid = (o: Order) => paidCents(o) >= num(o.total_cents) - 1;
  const cols = useMemo(() => {
    const c: Record<Col, Order[]> = { new: [], active: [], onway: [], done: [], cancelled: [] };
    const needle = q.trim().toLowerCase(); const digits = needle.replace(/\D/g, '');
    const dayStart = (d: number) => { const x = new Date(); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - d); return x.toISOString(); };
    const from = range === 'today' ? dayStart(0) : range === 'yesterday' ? dayStart(1) : range === '7d' ? dayStart(6) : ''; const to = range === 'yesterday' ? dayStart(0) : '';
    for (const o of orders) {
      const col = COL_OF[o.status];
      // open orders always show; the date range only trims the finished columns
      if ((col === 'done' || col === 'cancelled') && ((from && o.placed_at < from) || (to && o.placed_at >= to))) continue;
      if (unpaidOnly && isPaid(o)) continue;
      if (needle) {
        const hay = [o.number, o.local_number, o.customer_name, o.customer_phone, o.courier_name, ...(lines[o.id] ?? []).map(l => text(l.name, locale))].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle) && !(digits.length >= 3 && (o.customer_phone ?? '').replace(/\D/g, '').includes(digits))) continue;
      }
      c[col].push(o);
    }
    c.new.sort((a, b) => (a.needed_at ?? a.placed_at) < (b.needed_at ?? b.placed_at) ? -1 : 1);   // waiting longest first
    return c;
  }, [orders, q, range, unpaidOnly, lines, payments, locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const [show, setShow] = useState<Set<Col>>(loadCols);
  const toggleCol = (c: Col) => setShow(s => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); if (!n.size) n.add(c); try { localStorage.setItem(LS_COLS, JSON.stringify([...n])); } catch {} return n; });
  const [members, setMembers] = useState<Staff[]>([]); const [gate, setGate] = useState<Order | null>(null);
  useEffect(() => { boot.db.staff.toArray().then(setMembers); }, [boot]);
  const confirm = useConfirm();
  const colLabel = (c: Col) => pt(c === 'new' ? 'colNew' : c === 'active' ? 'colActive' : c === 'onway' ? 'colOnWay' : c === 'done' ? 'colDone' : 'colCancelled', locale);
  const removeOrder = async (o: Order, approvedBy: string | null) => { await deleteOrder(boot.db, o, approvedBy); boot.engine.poke(); setSel(null); await reload(); };
  const askDelete = async (o: Order) => {
    if (!(await confirm(pt('deleteOrderConfirm', locale), { danger: true }))) return;
    if (staff.role === 'owner') await removeOrder(o, staff.user_id); else setGate(o);
  };

  const act = async (o: Order, status: OrderStatus) => {
    if (status === 'rejected') return setDialog({ k: 'reject', o });
    if (status === 'cancelled') return setDialog({ k: 'cancel', o });
    if (status === 'accepted' && o.channel === 'online') return setDialog({ k: 'eta', o });
    // delivery leaves the shop: who takes it? (a driver gets a WhatsApp with the order; the shop itself needs nothing)
    if (status === 'out_for_delivery' && o.fulfillment === 'delivery') return setDialog({ k: 'driver', o });
    // handover: pickup → pay dialog; delivery → cash-on-delivery settlement (what the customer paid, who delivered, driver fee)
    if (status === 'delivered' && !isPaid(o)) return setDialog({ k: 'pay', o, status });
    await setOrderStatus(boot.db, o, status); boot.engine.poke(); await reload();
  };
  const chip = (s: OrderStatus) => <span className={`pill st-${s}`}>{pt(`st_${s}` as Key, locale)}</span>;

  return (
    <div className="orders-wrap">
      <div className="row spread" style={{ padding: '10px 12px 0', alignItems: 'center' }}>
        <strong>{pt('ordersNav', locale)}</strong>
        <button className="btn primary" onClick={onNewOrder}>＋ {pt('newOrder', locale)}</button>
      </div>
      <div className="row" style={{ gap: 6, padding: '8px 12px 0', alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 220px', minHeight: 36 }} placeholder={pt('searchOrders', locale)} value={q} onChange={e => setQ(e.target.value)} />
        <div className="seg">{(['today', 'yesterday', '7d', 'all'] as const).map(r => <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>{pt(`range_${r}` as Key, locale)}</button>)}</div>
        <button className={`chip ${unpaidOnly ? 'active' : ''}`} onClick={() => setUnpaidOnly(v => !v)}>💵 {pt('unpaidOnly', locale)}</button>
      </div>
      <div className="row" style={{ gap: 6, padding: '6px 12px 0', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 13 }}>{pt('showColumns', locale)}:</span>
        {COLS.map(c => <button key={c} className={`chip ${show.has(c) ? 'active' : ''}`} onClick={() => toggleCol(c)}>{colLabel(c)} <span className="muted">{cols[c].length}</span></button>)}
      </div>
      <div className="orders-cols" style={{ ['--cols' as string]: Math.min(4, show.size) }}>
        {COLS.filter(c => show.has(c)).map(c => (
          <section key={c} className={`orders-col ${c}`}>
            <h4 className="row spread"><span>{colLabel(c)} <span className="muted">{cols[c].length}</span></span>{!!cols[c].length && <span className="muted num" style={{ fontWeight: 400, fontSize: 12 }}>{fmtUsd(cols[c].reduce((s, o) => s + num(o.total_cents), 0))}{c === 'done' ? ` · ${cols[c].filter(o => !isPaid(o)).length} ${pt('unpaidOrder', locale)}` : ''}</span>}</h4>
            {!cols[c].length && <p className="muted" style={{ fontSize: 13 }}>{pt('noOrders', locale)}</p>}
            {cols[c].map(o => {
              const ls = (lines[o.id] ?? []).filter(l => !l.voided); const open = sel === o.id; const pickup = o.fulfillment === 'pickup';
              return (
                <article key={o.id} className={`order-card ${open ? 'open' : ''} ch-${o.channel}`} onClick={() => setSel(open ? null : o.id)}>
                  <div className="row spread" style={{ alignItems: 'center' }}>
                    <strong>{o.number ?? o.local_number}{o.needed_at && !o.closed_at && <span className={`pill ${new Date(o.needed_at).getTime() < Date.now() ? 'bad' : 'warn'}`} style={{ marginInlineStart: 6 }}>⏰ {neededLabel(o.needed_at, locale)}</span>}{!o.closed_at && <AgePill o={o} prep={num((boot.shop as unknown as { prep_minutes?: number }).prep_minutes) || 30} locale={locale} />}</strong>
                    <span className="row" style={{ gap: 4 }}><span className="pill">{pt(o.channel as Key, locale)}</span><span className="pill">{pickup ? '🛍 ' + pt('pickupBadge', locale) : '🛵 ' + pt('deliveryBadge', locale)}</span>{chip(o.status)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>{fmtTime(o.placed_at, locale)} · {o.customer_name || '—'} {o.customer_phone && <span className="row" style={{ gap: 6, display: 'inline-flex', alignItems: 'center' }}><span dir="ltr">{o.customer_phone}</span><a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`tel:+${waDigits(o.customer_phone)}`} title={pt('call', locale)} onClick={e => e.stopPropagation()}>📞</a><a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`https://wa.me/${waDigits(o.customer_phone)}`} target="_blank" rel="noreferrer" title="WhatsApp" onClick={e => e.stopPropagation()}>💬</a></span>}</div>
                  <div className="order-items">{ls.map(l => <div key={l.id}>{num(l.quantity)}{l.unit ? ' ' + l.unit : '×'} {text(l.name, locale)}{l.notes ? <span className="muted"> ({l.notes})</span> : ''}</div>)}</div>
                  {o.customer_notes && <div className="muted" style={{ fontSize: 12 }}>📝 {o.customer_notes}</div>}
                  {!pickup && o.address && Object.keys(o.address).length > 0 && <div className="muted" style={{ fontSize: 12 }}>📍 {addrLine(o.address as Record<string, unknown>)}{mapHref(o.address as Record<string, unknown>) ? <> · <a href={mapHref(o.address as Record<string, unknown>)!} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>🗺 {pt('openMap', locale)}</a></> : null}</div>}
                  {(o.reject_reason || o.cancel_reason) && <div className="bad" style={{ fontSize: 12 }}>{o.reject_reason || o.cancel_reason}</div>}
                  {o.fulfillment === 'delivery' && (o.status === 'out_for_delivery' || o.status === 'delivered') && <DriverLine o={o} boot={boot} locale={locale} />}
                  {o.channel === 'online' && !o.closed_at && online && <OrderThread orderId={o.id} you="shop" labels={{ title: pt('threadTitle', locale), customer: pt('threadCustomer', locale), shop: pt('threadShop', locale) }} />}
                  <div className="row spread" style={{ alignItems: 'center', marginTop: 4 }}>
                    <strong>{fmtUsd(num(o.total_cents))} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· {fmtLbp(num(o.total_lbp), locale)}{num(o.delivery_fee_usd) > 0 ? ` · ${pt('ofWhichDelivery', locale)} ${fmtUsd(Math.round(num(o.delivery_fee_usd) * 100))}` : ''}</span></strong>
                    <span className={`pill ${isPaid(o) ? 'ok' : 'warn'}`}>{isPaid(o) ? pt('paid', locale) : pt('unpaidOrder', locale)}</span>
                  </div>
                  {open && (
                    <div className="order-actions" onClick={e => e.stopPropagation()}>
                      {NEXT[o.status].filter(n => n !== 'rejected' && n !== 'cancelled').map(n => <button key={n} className={`btn ${n === 'delivered' ? 'primary' : ''}`} onClick={() => act(o, n)}>
                        {n === 'delivered' && pickup ? pt('act_pickedUp', locale) : pt(`act_${n}` as Key, locale)}{n === 'delivered' && !isPaid(o) ? ' · ' + (pickup ? pt('collectPayment', locale) : pt('codSettle', locale)) : ''}
                      </button>)}
                      {!['delivered', 'rejected', 'cancelled'].includes(o.status) && <button className="btn" onClick={() => setDialog({ k: 'edit', o })}>✎ {pt('editOrder', locale)}</button>}
                      <button className="btn" onClick={() => setDialog({ k: 'detail', o })}>🧾 {pt('orderDetails', locale)}</button>
                      <span style={{ position: 'relative' }}>
                        <button className="btn icon" title={pt('moreActions', locale)} onClick={() => setMenu(menu === o.id ? null : o.id)}>⋯</button>
                        {menu === o.id && <div className="order-menu" onClick={() => setMenu(null)}>
                          <button onClick={() => doPrint(receiptHtml(o, lines[o.id] ?? [], payments[o.id] ?? [], boot.shop, locale, loadPrintSettings(), { again: true }))}>🖨 {pt('print', locale)}</button>
                          <button onClick={() => doPrint(orderSheetHtml(o, lines[o.id] ?? [], boot.shop, locale, loadPrintSettings()))}>📋 {pt('printSheet', locale)}</button>
                          <label><input type="checkbox" checked={o.notify_customer !== false} onClick={e => e.stopPropagation()} onChange={async e => { await setOrderStatus(boot.db, o, o.status, { notify_customer: e.target.checked }).catch(() => undefined); await boot.db.orders.update(o.id, { notify_customer: e.target.checked }); reload(); }} /> 🔔 {pt('notifyOn', locale)}</label>
                          {o.status === 'delivered' && <button onClick={() => setDialog({ k: 'return', o })}>↩ {pt('returnTitle', locale)}</button>}
                          {NEXT[o.status].includes('rejected') && <button className="danger" onClick={() => act(o, 'rejected')}>✕ {pt('act_rejected', locale)}</button>}
                          {NEXT[o.status].includes('cancelled') && <button className="danger" onClick={() => act(o, 'cancelled')}>✕ {pt('act_cancelled', locale)}</button>}
                          {(o.status === 'cancelled' || o.status === 'rejected') && <button className="danger" onClick={() => askDelete(o)}>🗑 {pt('deleteOrder', locale)}</button>}
                        </div>}
                      </span>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        ))}
      </div>

      {gate && <OwnerPin open locale={locale} staff={members} me={staff} reason={pt('deleteOrder', locale)} onDone={id => { const o = gate; setGate(null); if (id) void removeOrder(o, id); }} />}
      {dialog?.k === 'eta' && <EtaDialog locale={locale} onDone={async eta => { await setOrderStatus(boot.db, dialog.o, 'accepted', { eta_minutes: eta }); boot.engine.poke(); setDialog(null); reload(); }} onClose={() => setDialog(null)} />}
      {dialog?.k === 'driver' && <DriverPicker boot={boot} locale={locale} order={dialog.o} onClose={() => setDialog(null)}
        onPick={async d => { await setOrderStatus(boot.db, dialog.o, 'out_for_delivery', { driver_id: d?.id ?? null, courier_name: d?.name ?? null }); boot.engine.poke(); setDialog(null); await reload(); }} />}
      {(dialog?.k === 'reject' || dialog?.k === 'cancel') && <ReasonDialog locale={locale} title={pt(dialog.k === 'reject' ? 'act_rejected' : 'act_cancelled', locale)} label={pt(dialog.k === 'reject' ? 'rejectReason' : 'cancelReason', locale)}
        onDone={async r => { await setOrderStatus(boot.db, dialog.o, dialog.k === 'reject' ? 'rejected' : 'cancelled', dialog.k === 'reject' ? { reject_reason: r } : { cancel_reason: r }); boot.engine.poke(); setDialog(null); reload(); }} onClose={() => setDialog(null)} />}
      {dialog?.k === 'edit' && <EditOrderDialog boot={boot} locale={locale} index={index} order={dialog.o} lines={lines[dialog.o.id] ?? []} paidCents={paidCents(dialog.o)} onDone={() => { setDialog(null); reload(); }} onClose={() => setDialog(null)} />}
      {dialog?.k === 'pay' && <PayDialog totalCents={num(dialog.o.total_cents) - paidCents(dialog.o)} rate={num(dialog.o.rate_lbp_per_usd) || rate} lbpStep={boot.shop.lbp_rounding_step ?? 5000} locale={locale}
        customer={{ name: dialog.o.customer_name, phone: dialog.o.customer_phone }} courier={dialog.o.fulfillment === 'delivery' ? { name: dialog.o.courier_name } : null} title={dialog.o.fulfillment === 'delivery' ? pt('codSettle', locale) : undefined}
        onConfirm={async (pays, changeIn: Currency, extra) => {
          const shift = await currentShift(boot.db); const r = num(dialog.o.rate_lbp_per_usd) || rate;
          await payOrder(boot.db, dialog.o, pays, r, boot.shop.lbp_rounding_step ?? 5000, changeIn, shift?.id ?? null, dialog.status, extra ? { courier_fee_cents: extra.courier_fee_cents, courier_name: extra.courier_name } : {});
          // the driver's fee leaves the drawer → cash out on the open shift, so expected cash stays right
          if (extra && extra.fee_amount > 0 && shift) await cashMove(boot.db, shift, { kind: 'out', amount: extra.fee_amount, currency: extra.fee_currency, reason: `${pt('driverFee', locale)} · ${dialog.o.number ?? dialog.o.local_number ?? ''}${extra.courier_name ? ' · ' + extra.courier_name : ''}`, user_id: staff.user_id });
          boot.engine.poke(); setDialog(null); await reload();
        }} onClose={() => setDialog(null)} />}
      {ackToast && <div className="toast">{ackToast}</div>}
      {dialog?.k === 'detail' && <OrderDetailSheet sb={sb} locale={locale} order={dialog.o} lines={lines[dialog.o.id] ?? []} payments={payments[dialog.o.id] ?? []} online={online} onCustomer={onCustomer} onClose={() => setDialog(null)} />}
      {dialog?.k === 'return' && <ReturnDialog boot={boot} locale={locale} order={dialog.o} lines={lines[dialog.o.id] ?? []} staff={staff} onDone={() => { setDialog(null); reload(); }} onClose={() => setDialog(null)} />}
    </div>
  );
}

function EtaDialog({ locale, onDone, onClose }: { locale: L; onDone: (eta: number | null) => void; onClose: () => void }) {
  const [v, setV] = useState('');
  return <Modal open onClose={onClose} title={pt('act_accepted', locale)} footer={<><button className="btn ghost" onClick={() => onDone(null)}>{pt('act_accepted', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" onClick={() => onDone(Number(v) || null)}>{pt('ok', locale)}</button></>}>
    <div className="row spread"><span className="muted">{pt('eta', locale)}</span><strong style={{ fontSize: 22 }}>{v || '—'}</strong></div>
    <div className="row" style={{ gap: 6, margin: '6px 0' }}>{[10, 15, 20, 30, 45, 60].map(m => <button key={m} className={`chip ${v === String(m) ? 'active' : ''}`} onClick={() => setV(String(m))}>{m}</button>)}</div>
    <NumPad value={v} onChange={setV} decimal={false} onEnter={() => onDone(Number(v) || null)} />
  </Modal>;
}
function ReasonDialog({ locale, title, label, onDone, onClose }: { locale: L; title: string; label: string; onDone: (r: string) => void; onClose: () => void }) {
  const [r, setR] = useState('');
  return <Modal open onClose={onClose} title={title} footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn danger" onClick={() => onDone(r.trim())}>{title}</button></>}>
    <label className="label">{label}</label><input className="input" value={r} onChange={e => setR(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') onDone(r.trim()); }} />
  </Modal>;
}

/** Missing item: remove a line (undoable until save), change its quantity, or add a substitute from the catalog. The customer gets the new list. */
function EditOrderDialog({ boot, locale, index, order, lines, paidCents, onDone, onClose }: { boot: Booted; locale: L; index: CatalogIndex; order: Order; lines: OrderLine[]; paidCents: number; onDone: () => void; onClose: () => void }) {
  const confirm = useConfirm();
  const locked = order.status === 'delivered' || order.status === 'cancelled' || order.status === 'rejected';
  const [rows, setRows] = useState(() => lines.filter(l => !l.voided).map(l => ({ l, qty: num(l.quantity), voided: false, dec: !!(l.product_id && index.byId.get(l.product_id)?.decimal_qty) || (num(l.quantity) % 1 !== 0) })));
  const [adds, setAdds] = useState<Array<{ p: Product; qty: number }>>([]);
  const [q, setQ] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const scanned = q.trim().length >= 6 && /^\d+$/.test(q.trim()) ? index.scan(q.trim()) : null;
  const results = q.trim() ? (scanned ? [scanned, ...index.search(q, 11).filter(p => p.id !== scanned.id)] : index.search(q, 12)) : [];
  const lineTotal = (r: typeof rows[number]) => Math.round(num(r.l.unit_price_cents) * r.qty) - num(r.l.discount_cents);
  const oldSubtotal = rows.reduce((s, r) => s + num(r.l.line_total_cents), 0);
  const subtotal = rows.filter(r => !r.voided).reduce((s, r) => s + lineTotal(r), 0) + adds.reduce((s, a) => s + Math.round(num(a.p.price_usd) * 100 * a.qty), 0);
  const fee = Math.round(num(order.delivery_fee_usd) * 100); const discount = Math.min(num(order.discount_cents), subtotal);
  const total = subtotal - discount + fee; const oldTotal = num(order.total_cents);
  const removed = rows.filter(r => r.voided).length, changed = rows.filter(r => !r.voided && r.qty !== num(r.l.quantity)).length, added = adds.length;
  const dirty = removed + changed + added > 0;
  const refund = paidCents - total;                                                  // > 0 → the customer already paid more than the new total
  const REASONS: Key[] = ['reasonOutOfStock', 'reasonNotToday', 'reasonCustomerAsked', 'reasonMistake'];
  const stepOf = (dec: boolean) => (dec ? 0.1 : 1);
  const minOf = (dec: boolean) => (dec ? 0.01 : 1);
  const setQty = (i: number, v: number, dec: boolean) => setRows(x => x.map((y, j) => (j === i ? { ...y, qty: Math.max(minOf(dec), Math.round(v * 1000) / 1000) } : y)));
  const save = async () => {
    setBusy(true);
    const edits = [...rows.filter(r => r.voided || r.qty !== num(r.l.quantity)).map(r => (r.voided ? { id: r.l.id, voided: true, void_reason: note } : { id: r.l.id, qty: r.qty })), ...adds.map(a => ({ product: a.p, new_qty: a.qty }))];
    await editOrder(boot.db, order, edits, note.trim() || undefined, order.notify_customer !== false); boot.engine.poke(); setBusy(false); onDone();
  };
  const close = async () => { if (!dirty || await confirm(pt('discardChanges', locale), { danger: true })) onClose(); };
  const unitOf = (l: OrderLine) => (l.unit ? ' ' + l.unit : '');
  return (
    <Modal open onClose={close} title={`${pt('editOrder', locale)} · ${order.number ?? order.local_number}`} wide
      footer={<><button className="btn ghost" onClick={close}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} />
        <span className="num" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.1 }}>
          {dirty && total !== oldTotal && <small className="muted" style={{ textDecoration: 'line-through' }}>{fmtUsd(oldTotal)}</small>}<strong>{fmtUsd(total)}</strong></span>
        <button className="btn primary" disabled={busy || !dirty || locked} onClick={save}>{pt('save', locale)}</button></>}>
      {locked && <div className="pill warn" style={{ marginBottom: 8 }}>{pt('orderLocked', locale)}</div>}
      <div className="edit-lines">
        {rows.map((r, i) => <div key={r.l.id} className={`edit-line ${r.voided ? 'voided' : ''}`}>
          <div className="edit-line-name">
            <div className={r.voided ? 'strike' : ''}>{text(r.l.name, locale)}</div>
            <div className="muted num" style={{ fontSize: 12 }}>{fmtUsd(num(r.l.unit_price_cents))}{unitOf(r.l) ? ` /${r.l.unit}` : ''} × {r.qty}{unitOf(r.l)} = <strong>{fmtUsd(lineTotal(r))}</strong>
              {!r.voided && r.qty !== num(r.l.quantity) && <span style={{ textDecoration: 'line-through', marginInlineStart: 6 }}>{fmtUsd(num(r.l.line_total_cents))}</span>}</div>
          </div>
          <div className="qty-btns">
            <button disabled={r.voided || locked} onClick={() => setQty(i, r.qty - stepOf(r.dec), r.dec)}>−</button>
            <input className="qty-in num" inputMode="decimal" disabled={r.voided || locked} value={r.qty} onChange={e => { if (e.target.value === '') return; const v = Number(e.target.value); if (!Number.isNaN(v)) setQty(i, r.dec ? v : Math.round(v), r.dec); }} />
            <button disabled={r.voided || locked} onClick={() => setQty(i, r.qty + stepOf(r.dec), r.dec)}>+</button>
          </div>
          <button className={`btn ${r.voided ? '' : 'danger'}`} disabled={locked} onClick={() => setRows(x => x.map((y, j) => (j === i ? { ...y, voided: !y.voided } : y)))}>{r.voided ? '↶ ' + pt('restoreLine', locale) : pt('removeLine', locale)}</button>
        </div>)}
        {adds.map((a, i) => <div key={'a' + i} className="edit-line added">
          <div className="edit-line-name"><div>＋ {text(a.p.name, locale)}</div><div className="muted num" style={{ fontSize: 12 }}>{fmtUsd(Math.round(num(a.p.price_usd) * 100))} × {a.qty}{a.p.unit ? ' ' + a.p.unit : ''} = <strong>{fmtUsd(Math.round(num(a.p.price_usd) * 100 * a.qty))}</strong></div></div>
          <div className="qty-btns">
            <button onClick={() => setAdds(x => x.map((y, j) => (j === i ? { ...y, qty: Math.max(minOf(!!a.p.decimal_qty), Math.round((y.qty - stepOf(!!a.p.decimal_qty)) * 1000) / 1000) } : y)))}>−</button>
            <input className="qty-in num" inputMode="decimal" value={a.qty} onChange={e => { if (e.target.value === '') return; const v = Number(e.target.value); if (!Number.isNaN(v)) setAdds(x => x.map((y, j) => (j === i ? { ...y, qty: Math.max(minOf(!!a.p.decimal_qty), a.p.decimal_qty ? v : Math.round(v)) } : y))); }} />
            <button onClick={() => setAdds(x => x.map((y, j) => (j === i ? { ...y, qty: Math.round((y.qty + stepOf(!!a.p.decimal_qty)) * 1000) / 1000 } : y)))}>+</button>
          </div>
          <button className="btn icon" onClick={() => setAdds(x => x.filter((_, j) => j !== i))}>✕</button>
        </div>)}
      </div>
      {!locked && <>
        <input className="input" placeholder={pt('substituteHint', locale)} value={q} onChange={e => setQ(e.target.value)} style={{ marginTop: 8 }} />
        {!!results.length && <ul className="tender-list" style={{ marginTop: 6 }}>{results.map(p => <li key={p.id}><span>{text(p.name, locale)} <span className="muted num">{fmtUsd(Math.round(num(p.price_usd) * 100))}{p.unit ? ` /${p.unit}` : ''}</span>{p.track_stock && num(p.on_hand) <= 0 && <span className="pill warn" style={{ marginInlineStart: 6 }}>{pt('outOfStock', locale)}</span>}</span><button className="btn" onClick={() => { setAdds(x => [...x, { p, qty: 1 }]); setQ(''); }}>＋</button></li>)}</ul>}
        {q.trim() && !results.length && <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>{pt('noResults', locale)}</div>}
      </>}
      {dirty && <div className="edit-summary num">
        {removed > 0 && <span>🗑 {removed}</span>}{changed > 0 && <span>✎ {changed}</span>}{added > 0 && <span>＋ {added}</span>}
        <span style={{ flex: 1 }} />
        <span>{pt('subtotal', locale)}: <s className="muted">{fmtUsd(oldSubtotal)}</s> → <strong>{fmtUsd(subtotal)}</strong></span>
      </div>}
      {dirty && refund > 0 && <div className="pill warn" style={{ marginTop: 6 }}>💵 {pt('refundDue', locale)} {fmtUsd(refund)}</div>}
      {dirty && paidCents > 0 && refund < 0 && <div className="pill" style={{ marginTop: 6 }}>💵 {pt('extraDue', locale)} {fmtUsd(-refund)}</div>}
      {!locked && <>
        <label className="label" style={{ marginTop: 8 }}>{pt('editNote', locale)}</label>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>{REASONS.map(k => <button key={k} className={`btn ${note === pt(k, locale) ? 'primary' : 'ghost'}`} style={{ minHeight: 32, padding: '4px 10px', fontSize: 13 }} onClick={() => setNote(note === pt(k, locale) ? '' : pt(k, locale))}>{pt(k, locale)}</button>)}</div>
        <input className="input" value={note} onChange={e => setNote(e.target.value)} />
      </>}
    </Modal>
  );
}

/** How long the order has been waiting: grey, amber past the shop's prep time, red past twice that. For accepted orders the promised ETA counts. */
function AgePill({ o, prep, locale }: { o: Order; prep: number; locale: L }) {
  const since = o.status === 'pending' ? o.placed_at : (o.accepted_at ?? o.placed_at);
  const mins = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 60000));
  const limit = o.status === 'pending' ? 5 : (o.eta_minutes ?? prep);
  const cls = mins > limit * 2 ? 'bad' : mins > limit ? 'warn' : '';
  const label = mins < 60 ? `${mins} ${pt('min', locale)}` : `${Math.floor(mins / 60)} ${pt('hour', locale)} ${mins % 60} ${pt('min', locale)}`;
  return <span className={`pill ${cls}`} style={{ marginInlineStart: 6, fontWeight: 400 }} title={o.status === 'pending' ? pt('waitingSince', locale) : pt('sinceAccepted', locale)}>⏱ {label}{o.status !== 'pending' && o.eta_minutes ? ` / ${o.eta_minutes}` : ''}</span>;
}

/** "⏰ 17:30 · بعد 40 د" / "متأخر 10 د"; shows the date when it is not today. */
function neededLabel(iso: string, locale: L): string {
  const d = new Date(iso); const diff = Math.round((d.getTime() - Date.now()) / 60000);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString(locale === 'ar' ? 'ar-LB' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) + (sameDay ? '' : ' ' + d.toLocaleDateString(locale === 'ar' ? 'ar-LB' : 'en-GB', { day: 'numeric', month: 'short' }));
  const rel = Math.abs(diff) >= 120 ? `${Math.round(Math.abs(diff) / 60)} ${pt('hour', locale)}` : `${Math.abs(diff)} ${pt('min', locale)}`;
  return diff < 0 ? `${t} · ${pt('late', locale)} ${rel}` : `${t} · ${pt('inTime', locale)} ${rel}`;
}

/** wa.me / tel want the international number without '+': 70 483 148 → 96170483148. */

/** Online orders carry line1/line2/notes/label + a PostGIS point; POS-typed ones carry line1 + map_url/lat/lng. */
function addrLine(a: Record<string, unknown>): string {
  return [a.line1, a.line2].filter(Boolean).map(String).join(', ') || String(a.label ?? a.area ?? '') + (a.notes ? ` — ${a.notes}` : '');
}
function mapHref(a: Record<string, unknown>): string | null {
  if (a.map_url) return String(a.map_url);
  const p = (a.lat != null && a.lng != null) ? { lat: Number(a.lat), lng: Number(a.lng) } : pointFromEwkb(a.location as string | null | undefined);
  return p ? `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}` : null;
}
const fmtClock = (iso: string, locale: L) => new Date(iso).toLocaleTimeString(locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

/** "🛵 Abou Ali 📞 💬" on an order that left the shop — or "المحل" when the shop delivered it itself. */
function DriverLine({ o, boot, locale }: { o: Order; boot: Booted; locale: L }) {
  const [d, setD] = useState<Driver | null>(null);
  useEffect(() => { if (o.driver_id) boot.db.drivers.get(o.driver_id).then(x => setD(x ?? null)); else setD(null); }, [boot, o.driver_id]);
  const ack = o.driver_id && o.status === 'out_for_delivery'
    ? (o.driver_ack_at
      ? <span className="pill ok" style={{ marginInlineStart: 4 }} title={pt('driverAckHint', locale)}>✓ {pt('driverAcked', locale)} {fmtClock(o.driver_ack_at, locale)}</span>
      : <span className={`pill ${o.updated_at && Date.now() - new Date(o.updated_at).getTime() > 5 * 60000 ? 'warn' : ''}`} style={{ marginInlineStart: 4 }} title={pt('driverAckHint', locale)}>⏳ {pt('driverAckWaiting', locale)}</span>)
    : null;
  return <div className="muted" style={{ fontSize: 12 }}>🛵 {d ? <>{d.name}{ack} <a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`tel:+${waDigits(d.phone)}`} onClick={e => e.stopPropagation()}>📞</a><a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`https://wa.me/${waDigits(d.phone)}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>💬</a></> : (o.courier_name || pt('shopDelivers', locale))}</div>;
}
