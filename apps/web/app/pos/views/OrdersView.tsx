'use client';
import { useEffect, useMemo, useState } from 'react';
import { NEXT, cashMove, currentShift, deleteOrder, editOrder, fmtLbp, fmtUsd, num, payOrder, setOrderStatus, text, type CatalogIndex, type Currency, type Order, type OrderLine, type OrderStatus, type Payment, type Product, type Rate, type Staff } from '@suqa/pos-core';
import { pt, type L, type Key } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import { doPrint, loadPrintSettings, receiptHtml } from '../lib/print';
import Modal, { NumPad } from '../components/Modal';
import PayDialog from '../components/PayDialog';
import ReturnDialog from '../components/ReturnDialog';
import OwnerPin from '../components/OwnerPin';
import { useConfirm } from '@/components/ConfirmProvider';

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
export default function OrdersView({ boot, locale, index, tick, staff, onNewOrder }: { boot: Booted; locale: L; index: CatalogIndex; tick: number; staff: Staff; onNewOrder: () => void }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [lines, setLines] = useState<Record<string, OrderLine[]>>({});
  const [payments, setPayments] = useState<Record<string, Payment[]>>({});
  const [rate, setRate] = useState(89500);
  const [dialog, setDialog] = useState<null | { k: 'reject' | 'cancel' | 'eta'; o: Order } | { k: 'edit'; o: Order } | { k: 'pay'; o: Order; status: OrderStatus } | { k: 'return'; o: Order }>(null);
  const [sel, setSel] = useState<string | null>(null);
  const reload = async () => {
    const since = new Date(Date.now() - 36 * 3600_000).toISOString();
    const all = (await boot.db.orders.toArray()).filter(o => o.channel !== 'walkin' && !o.parked && (!o.closed_at || o.closed_at > since));
    // open orders: the ones wanted soonest first (scheduled ones by their time, ASAP ones by when they came in); closed ones newest first
    const open = (o: Order) => !o.closed_at; const k = (o: Order) => o.needed_at ?? o.placed_at;
    all.sort((a, b) => open(a) && open(b) ? (k(a) < k(b) ? -1 : 1) : (a.placed_at < b.placed_at ? 1 : -1));
    setOrders(all);
    const ids = all.map(o => o.id);
    const ls = await boot.db.orderLines.where('order_id').anyOf(ids).toArray(); const ps = await boot.db.payments.where('order_id').anyOf(ids).toArray();
    const lm: Record<string, OrderLine[]> = {}; for (const l of ls) (lm[l.order_id] ??= []).push(l); setLines(lm);
    const pm: Record<string, Payment[]> = {}; for (const p of ps) (pm[p.order_id] ??= []).push(p); setPayments(pm);
    boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { if (r) setRate(r.lbp_per_usd); });
  };
  useEffect(() => { void reload(); }, [boot, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const cols = useMemo(() => { const c: Record<Col, Order[]> = { new: [], active: [], onway: [], done: [], cancelled: [] }; for (const o of orders) c[COL_OF[o.status]].push(o); return c; }, [orders]);
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
  const paidCents = (o: Order) => (payments[o.id] ?? []).filter(p => p.tender !== 'unpaid').reduce((s, p) => s + (p.currency === 'lbp' ? Math.round((num(p.amount) * 100) / (num(o.rate_lbp_per_usd) || rate)) : num(p.amount)), 0);
  const isPaid = (o: Order) => paidCents(o) >= num(o.total_cents) - 1;

  const act = async (o: Order, status: OrderStatus) => {
    if (status === 'rejected') return setDialog({ k: 'reject', o });
    if (status === 'cancelled') return setDialog({ k: 'cancel', o });
    if (status === 'accepted' && o.channel === 'online') return setDialog({ k: 'eta', o });
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
        <span className="muted" style={{ fontSize: 13 }}>{pt('showColumns', locale)}:</span>
        {COLS.map(c => <button key={c} className={`chip ${show.has(c) ? 'active' : ''}`} onClick={() => toggleCol(c)}>{colLabel(c)} <span className="muted">{cols[c].length}</span></button>)}
      </div>
      <div className="orders-cols" style={{ ['--cols' as string]: Math.min(4, show.size) }}>
        {COLS.filter(c => show.has(c)).map(c => (
          <section key={c} className={`orders-col ${c}`}>
            <h4>{colLabel(c)} <span className="muted">{cols[c].length}</span></h4>
            {!cols[c].length && <p className="muted" style={{ fontSize: 13 }}>{pt('noOrders', locale)}</p>}
            {cols[c].map(o => {
              const ls = (lines[o.id] ?? []).filter(l => !l.voided); const open = sel === o.id; const pickup = o.fulfillment === 'pickup';
              return (
                <article key={o.id} className={`order-card ${open ? 'open' : ''} ch-${o.channel}`} onClick={() => setSel(open ? null : o.id)}>
                  <div className="row spread" style={{ alignItems: 'center' }}>
                    <strong>{o.number ?? o.local_number}{o.needed_at && !o.closed_at && <span className={`pill ${new Date(o.needed_at).getTime() < Date.now() ? 'bad' : 'warn'}`} style={{ marginInlineStart: 6 }}>⏰ {neededLabel(o.needed_at, locale)}</span>}</strong>
                    <span className="row" style={{ gap: 4 }}><span className="pill">{pt(o.channel as Key, locale)}</span><span className="pill">{pickup ? '🛍 ' + pt('pickupBadge', locale) : '🛵 ' + pt('deliveryBadge', locale)}</span>{chip(o.status)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>{fmtTime(o.placed_at, locale)} · {o.customer_name || '—'} {o.customer_phone && <span className="row" style={{ gap: 6, display: 'inline-flex', alignItems: 'center' }}><span dir="ltr">{o.customer_phone}</span><a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`tel:+${waDigits(o.customer_phone)}`} title={pt('call', locale)} onClick={e => e.stopPropagation()}>📞</a><a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`https://wa.me/${waDigits(o.customer_phone)}`} target="_blank" rel="noreferrer" title="WhatsApp" onClick={e => e.stopPropagation()}>💬</a></span>}</div>
                  <div className="order-items">{ls.map(l => <div key={l.id}>{num(l.quantity)}{l.unit ? ' ' + l.unit : '×'} {text(l.name, locale)}{l.notes ? <span className="muted"> ({l.notes})</span> : ''}</div>)}</div>
                  {o.customer_notes && <div className="muted" style={{ fontSize: 12 }}>📝 {o.customer_notes}</div>}
                  {!pickup && o.address && Object.keys(o.address).length > 0 && <div className="muted" style={{ fontSize: 12 }}>📍 {String((o.address as Record<string, unknown>).line1 ?? (o.address as Record<string, unknown>).area ?? '')}{(o.address as Record<string, unknown>).map_url ? <> · <a href={String((o.address as Record<string, unknown>).map_url)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>map</a></> : null}</div>}
                  <div className="row spread" style={{ alignItems: 'center', marginTop: 4 }}>
                    <strong>{fmtUsd(num(o.total_cents))} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· {fmtLbp(num(o.total_lbp), locale)}</span></strong>
                    <span className={`pill ${isPaid(o) ? 'ok' : 'warn'}`}>{isPaid(o) ? pt('paid', locale) : pt('unpaidOrder', locale)}</span>
                  </div>
                  {open && (
                    <div className="order-actions" onClick={e => e.stopPropagation()}>
                      {NEXT[o.status].map(n => <button key={n} className={`btn ${n === 'rejected' || n === 'cancelled' ? 'danger' : n === 'delivered' ? 'primary' : ''}`} onClick={() => act(o, n)}>
                        {n === 'delivered' && pickup ? pt('act_pickedUp', locale) : pt(`act_${n}` as Key, locale)}{n === 'delivered' && !isPaid(o) ? ' · ' + (pickup ? pt('collectPayment', locale) : pt('codSettle', locale)) : ''}
                      </button>)}
                      {!['delivered', 'rejected', 'cancelled'].includes(o.status) && <button className="btn" onClick={() => setDialog({ k: 'edit', o })}>✎ {pt('editOrder', locale)}</button>}
                      {o.status === 'delivered' && <button className="btn" onClick={() => setDialog({ k: 'return', o })}>↩ {pt('returnTitle', locale)}</button>}
                      {(o.status === 'cancelled' || o.status === 'rejected') && <button className="btn danger" onClick={() => askDelete(o)}>🗑 {pt('deleteOrder', locale)}</button>}
                      <button className="btn icon" title={pt('print', locale)} onClick={() => doPrint(receiptHtml(o, lines[o.id] ?? [], payments[o.id] ?? [], boot.shop, locale, loadPrintSettings(), { again: true }))}>🖨</button>
                      <label className="muted" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={o.notify_customer !== false} onChange={async e => { await setOrderStatus(boot.db, o, o.status, { notify_customer: e.target.checked }).catch(() => undefined); await boot.db.orders.update(o.id, { notify_customer: e.target.checked }); reload(); }} /> 🔔 {pt('notifyOn', locale)}</label>
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
      {(dialog?.k === 'reject' || dialog?.k === 'cancel') && <ReasonDialog locale={locale} title={pt(dialog.k === 'reject' ? 'act_rejected' : 'act_cancelled', locale)} label={pt(dialog.k === 'reject' ? 'rejectReason' : 'cancelReason', locale)}
        onDone={async r => { await setOrderStatus(boot.db, dialog.o, dialog.k === 'reject' ? 'rejected' : 'cancelled', dialog.k === 'reject' ? { reject_reason: r } : { cancel_reason: r }); boot.engine.poke(); setDialog(null); reload(); }} onClose={() => setDialog(null)} />}
      {dialog?.k === 'edit' && <EditOrderDialog boot={boot} locale={locale} index={index} order={dialog.o} lines={lines[dialog.o.id] ?? []} onDone={() => { setDialog(null); reload(); }} onClose={() => setDialog(null)} />}
      {dialog?.k === 'pay' && <PayDialog totalCents={num(dialog.o.total_cents) - paidCents(dialog.o)} rate={num(dialog.o.rate_lbp_per_usd) || rate} lbpStep={boot.shop.lbp_rounding_step ?? 5000} locale={locale}
        customer={{ name: dialog.o.customer_name, phone: dialog.o.customer_phone }} courier={dialog.o.fulfillment === 'delivery' ? { name: dialog.o.courier_name } : null} title={dialog.o.fulfillment === 'delivery' ? pt('codSettle', locale) : undefined}
        onConfirm={async (pays, changeIn: Currency, extra) => {
          const shift = await currentShift(boot.db); const r = num(dialog.o.rate_lbp_per_usd) || rate;
          await payOrder(boot.db, dialog.o, pays, r, boot.shop.lbp_rounding_step ?? 5000, changeIn, shift?.id ?? null, dialog.status, extra ? { courier_fee_cents: extra.courier_fee_cents, courier_name: extra.courier_name } : {});
          // the driver's fee leaves the drawer → cash out on the open shift, so expected cash stays right
          if (extra && extra.fee_amount > 0 && shift) await cashMove(boot.db, shift, { kind: 'out', amount: extra.fee_amount, currency: extra.fee_currency, reason: `${pt('driverFee', locale)} · ${dialog.o.number ?? dialog.o.local_number ?? ''}${extra.courier_name ? ' · ' + extra.courier_name : ''}`, user_id: staff.user_id });
          boot.engine.poke(); setDialog(null); await reload();
        }} onClose={() => setDialog(null)} />}
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

/** Missing item: remove a line, change its quantity, or add a substitute from the catalog. The customer gets the new list. */
function EditOrderDialog({ boot, locale, index, order, lines, onDone, onClose }: { boot: Booted; locale: L; index: CatalogIndex; order: Order; lines: OrderLine[]; onDone: () => void; onClose: () => void }) {
  const [rows, setRows] = useState(() => lines.filter(l => !l.voided).map(l => ({ l, qty: num(l.quantity), voided: false })));
  const [adds, setAdds] = useState<Array<{ p: Product; qty: number }>>([]);
  const [q, setQ] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const results = q.trim() ? index.search(q, 12) : [];
  const total = rows.filter(r => !r.voided).reduce((s, r) => s + Math.round(num(r.l.unit_price_cents) * r.qty) - num(r.l.discount_cents), 0) + adds.reduce((s, a) => s + Math.round(num(a.p.price_usd) * 100 * a.qty), 0);
  const save = async () => {
    setBusy(true);
    const edits = [...rows.filter(r => r.voided || r.qty !== num(r.l.quantity)).map(r => (r.voided ? { id: r.l.id, voided: true, void_reason: note } : { id: r.l.id, qty: r.qty })), ...adds.map(a => ({ product: a.p, new_qty: a.qty }))];
    await editOrder(boot.db, order, edits, note.trim() || undefined, order.notify_customer !== false); boot.engine.poke(); setBusy(false); onDone();
  };
  return (
    <Modal open onClose={onClose} title={`${pt('editOrder', locale)} · ${order.number ?? order.local_number}`} wide
      footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><strong>{fmtUsd(total)}</strong><button className="btn primary" disabled={busy} onClick={save}>{pt('save', locale)}</button></>}>
      <table className="table"><tbody>
        {rows.map((r, i) => <tr key={r.l.id} style={{ opacity: r.voided ? .45 : 1 }}>
          <td>{text(r.l.name, locale)}<div className="muted" style={{ fontSize: 12 }}>{fmtUsd(num(r.l.unit_price_cents))}</div></td>
          <td><div className="qty-btns"><button onClick={() => setRows(x => x.map((y, j) => (j === i ? { ...y, qty: Math.max(0.001, y.qty - 1) } : y)))}>−</button><span>{r.qty}</span><button onClick={() => setRows(x => x.map((y, j) => (j === i ? { ...y, qty: y.qty + 1 } : y)))}>+</button></div></td>
          <td><button className="btn danger" onClick={() => setRows(x => x.map((y, j) => (j === i ? { ...y, voided: !y.voided } : y)))}>{r.voided ? '↶' : pt('removeLine', locale)}</button></td>
        </tr>)}
        {adds.map((a, i) => <tr key={'a' + i}><td>＋ {text(a.p.name, locale)}</td><td><div className="qty-btns"><button onClick={() => setAdds(x => x.map((y, j) => (j === i ? { ...y, qty: Math.max(1, y.qty - 1) } : y)))}>−</button><span>{a.qty}</span><button onClick={() => setAdds(x => x.map((y, j) => (j === i ? { ...y, qty: y.qty + 1 } : y)))}>+</button></div></td><td><button className="btn icon" onClick={() => setAdds(x => x.filter((_, j) => j !== i))}>✕</button></td></tr>)}
      </tbody></table>
      <input className="input" placeholder={pt('substitute', locale)} value={q} onChange={e => setQ(e.target.value)} style={{ marginTop: 8 }} />
      {!!results.length && <ul className="tender-list" style={{ marginTop: 6 }}>{results.map(p => <li key={p.id}><span>{text(p.name, locale)} <span className="muted">{fmtUsd(Math.round(num(p.price_usd) * 100))}</span></span><button className="btn" onClick={() => { setAdds(x => [...x, { p, qty: 1 }]); setQ(''); }}>＋</button></li>)}</ul>}
      <label className="label" style={{ marginTop: 8 }}>{pt('editNote', locale)}</label><input className="input" value={note} onChange={e => setNote(e.target.value)} />
    </Modal>
  );
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
const waDigits = (p: string) => { const k = p.replace(/\D/g, '').replace(/^00/, ''); return k.startsWith('961') ? k : '961' + k.replace(/^0/, ''); };
