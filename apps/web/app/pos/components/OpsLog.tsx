'use client';
import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currentShift, fmtLbp, fmtUsd, num as num0, unsettleDebt, voidPurchase, type Order, type OrderLine, type Staff } from '@suqa/pos-core';
import { pt, type L, type Key } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import Modal from './Modal';
import ReturnDialog from './ReturnDialog';

const num = (v: unknown) => num0(v as number);
type Row = { id: number; at: string; user_id: string | null; action: string; ref_id: string | null; after: Record<string, unknown> | null };
type Op = Row & { failed: boolean; amount: string; detail: string; undone: string | null; canUndo: 'sale' | 'purchase' | 'debt' | 'cash' | 'stock' | 'supplier' | 'payout' | 'pay' | null; why: string | null };

/** The operations a till sends (no admin-side actions). */
const POS_OPS = ['sale.commit', 'sale.cancel', 'return.commit', 'order.pay', 'order.status', 'order.edit', 'order.info', 'order.merge', 'order.delete', 'order.needed',
  'order.driver_cash', 'order.driver_pay', 'driver.payout', 'cash.move', 'shift.open', 'shift.close', 'rate.set', 'debt.settle', 'debt.unsettle', 'stock.move',
  'product.patch', 'purchase.commit', 'purchase.void', 'supplier.pay', 'customer.upsert', 'customer.merge', 'customer.delete', 'supplier.upsert', 'supplier.merge',
  'supplier.delete', 'driver.upsert', 'driver.delete', 'op.cancel'];
/** cancelled on the server in one step (90): the opposite entry is written there, once, and reaches every till by sync */
const SERVER_CANCEL = ['cash', 'stock', 'supplier', 'payout', 'pay'];
const MONEY = ['op.cancel', 'sale.commit', 'return.commit', 'order.pay', 'driver.payout', 'cash.move', 'debt.settle', 'debt.unsettle', 'purchase.commit', 'purchase.void', 'supplier.pay', 'shift.open', 'shift.close'];
const REASONS = ['test', 'mistake', 'other'] as const;

/**
 * Reports → سجل العمليات: every operation the shop's tills sent — when, who, what, how much — newest first, from the audit log
 * (owner, online). Step 1 cancels what already has a safe reversal: a fully paid cash sale (a full return: stock back, cash out of
 * today's drawer), a purchase (void) and a debt collection (undo). Each cancel is itself a new logged operation, linked to the
 * original, and is refused once done — nothing is deleted and nothing counts twice. Other operations are shown, not cancelled here yet.
 */
export default function OpsLog({ boot, sb, locale, staff, from, to, onSale }: { boot: Booted; sb: SupabaseClient; locale: L; staff: Staff; from: string; to: string; onSale?: (orderId: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null); const [err, setErr] = useState<string | null>(null); const [tick, setTick] = useState(0);
  const [members, setMembers] = useState<Staff[]>([]); const [who, setWho] = useState(''); const [kind, setKind] = useState<'all' | 'money'>('money'); const [type, setType] = useState('');
  const [ask, setAsk] = useState<Op | null>(null); const [ret, setRet] = useState<{ order: Order; lines: OrderLine[]; reason: string } | null>(null); const [msg, setMsg] = useState<string | null>(null); const [view, setView] = useState<Op | null>(null);
  useEffect(() => { boot.db.staff.toArray().then(setMembers); }, [boot]);
  useEffect(() => {
    let on = true; setRows(null); setErr(null);
    const start = new Date(`${from}T00:00:00`).toISOString(); const end = new Date(new Date(`${to}T00:00:00`).getTime() + 86400000).toISOString();
    (async () => {
      const out: Row[] = [];
      for (let p = 0; p < 10; p++) {                      // pages of 1,000 (the API's cap) — up to 10,000 operations in a period
        const { data, error } = await sb.from('audit_log').select('id, at, user_id, action, ref_id, after').eq('shop_id', boot.shop.id).in('action', POS_OPS)
          .gte('at', start).lt('at', end).order('at', { ascending: false }).range(p * 1000, p * 1000 + 999);
        if (error) { if (on) { setErr(error.message); setRows([]); } return; }
        out.push(...((data as Row[]) ?? [])); if ((data?.length ?? 0) < 1000) break;
      }
      if (on) setRows(out);
    })();
    return () => { on = false; };
  }, [sb, boot, from, to, tick]);

  // an order payment carries the order's id only: its number comes from this till's own copy of the order
  const [nums, setNums] = useState<Record<string, string>>({});
  useEffect(() => { const ids = [...new Set((rows ?? []).filter(r => r.action === 'order.pay').map(r => String(r.after?.id ?? r.ref_id ?? '')).filter(Boolean))]; if (!ids.length) return;
    boot.db.orders.bulkGet(ids).then(os => setNums(Object.fromEntries(os.filter(Boolean).map(o => [o!.id, String(o!.number ?? o!.local_number ?? '')])))); }, [boot, rows]);
  const nameOf = (id: string | null | undefined) => { const s = members.find(x => x.user_id === id); return s?.display_name || s?.full_name || (id ? id.slice(0, 8) : '—'); };
  const label = (a: string) => { const k = `a_${a.replace('.', '_')}` as Key; const t = pt(k, locale); return !t || t === k ? a : t; };
  const usd = (c: unknown) => fmtUsd(num(c as number)); const lbp = (v: unknown) => fmtLbp(num(v as number), locale);
  const money = (cur: unknown, amt: unknown) => (cur === 'lbp' ? lbp(amt) : usd(amt));

  const ops = useMemo<Op[]>(() => {
    const all = rows ?? [];
    // what has already been reversed: returns by sale, voided purchases, undone debt collections
    const returned = new Map<string, Row>(), voided = new Map<string, Row>(), unsettled = new Map<string, Row>(), cancelled = new Map<string, Row>();
    for (const r of all) {
      const a = r.after ?? {}; const ok = (a.result as { status?: string } | undefined)?.status !== 'rejected';
      if (!ok) continue;
      if (r.action === 'return.commit' && a.order_id) returned.set(String(a.order_id), r);
      if (r.action === 'purchase.void' && (r.ref_id || a.id)) voided.set(String(r.ref_id ?? a.id), r);
      if (r.action === 'debt.unsettle' && (r.ref_id || a.id)) unsettled.set(String(r.ref_id ?? a.id), r);
      if (r.action === 'op.cancel' && a.cancel_of != null) cancelled.set(String(a.cancel_of), r);      // by the cancelled line itself: an order can be paid, cancelled and paid again
    }
    const undoneBy = (r: Row | undefined) => (r ? `${label(r.action)} · ${nameOf(r.user_id)} · ${fmtTime(r.at, locale)}${(r.after?.reason as string) ? ` · ${r.after?.reason}` : ''}` : null);
    return all.map(r => {
      const a = r.after ?? {}; const res = (a.result ?? {}) as Record<string, unknown>; const failed = res.status === 'rejected';
      const id = String(r.ref_id ?? a.id ?? '');
      let amount = '', detail = '', undone: string | null = null, canUndo: Op['canUndo'] = null, why: string | null = null;
      switch (r.action) {
        case 'sale.commit': {
          amount = usd(a.total_cents); const pays = (a.payments as { tender: string }[] | undefined) ?? [];
          detail = [String(res.number ?? a.local_number ?? ''), (a.customer_name as string) || '', `${(a.lines as unknown[] | undefined)?.length ?? 0} ${pt('itemsCount', locale)}`, pays.map(p => pt(p.tender as Key, locale)).join(' + ')].filter(Boolean).join(' · ');
          undone = undoneBy(returned.get(id));
          if (!undone) { if (a.channel && a.channel !== 'walkin') why = pt('opsWhyOrder', locale); else if (pays.some(p => p.tender !== 'cash_usd' && p.tender !== 'cash_lbp')) why = pt('opsWhyNotCash', locale); else canUndo = 'sale'; }
          break; }
        case 'return.commit': amount = '−' + (num(a.refund_lbp) ? lbp(a.refund_lbp) : usd(a.refund_usd_cents)); detail = [String(res.number ?? ''), (a.reason as string) || ''].filter(Boolean).join(' · '); break;
        case 'order.pay': { amount = usd(a.paid_usd_cents) + (num(a.paid_lbp) ? ' + ' + lbp(a.paid_lbp) : ''); undone = undoneBy(cancelled.get(String(r.id)));
          const pays = Array.isArray(a.payments) ? (a.payments as { tender?: string }[]) : [];
          detail = [nums[String(a.id ?? r.ref_id ?? '')] ?? '', [...new Set(pays.map(p => pt(String(p.tender) as Key, locale)))].join(' + ')].filter(Boolean).join(' · ');
          if (!undone && pays.length) canUndo = 'pay';                      // (a step with no payment has nothing to cancel)
          break; }
        case 'cash.move': amount = (a.kind === 'out' ? '−' : '+') + money(a.currency, a.amount); detail = String(a.reason ?? ''); undone = undoneBy(cancelled.get(String(r.id)));
          // only a move made by hand: one that belongs to a debt, a supplier payment, a driver or a fee goes with that operation
          if (!undone) { if (a.source === 'manual') canUndo = 'cash'; else why = pt(a.source ? 'opsWhyCashLinked' : 'opsWhyCashOld', locale); }
          break;
        case 'driver.payout': amount = money(a.currency, a.amount); detail = `${num(res.orders)} ${pt('ordersCount', locale)}`; undone = undoneBy(cancelled.get(String(r.id))); if (!undone) canUndo = 'payout'; break;
        case 'debt.settle': amount = money(a.currency, a.amount); detail = String(a.name || a.phone || ''); undone = undoneBy(unsettled.get(id)); if (!undone) canUndo = 'debt'; break;
        case 'debt.unsettle': detail = String(a.reason ?? ''); break;
        case 'purchase.commit': amount = usd(a.total_cents); detail = String(a.invoice_no ?? ''); undone = undoneBy(voided.get(id)); if (!undone) canUndo = 'purchase'; break;
        case 'purchase.void': detail = String(a.reason ?? ''); break;
        case 'supplier.pay': amount = money(a.currency, a.amount); detail = String(a.note ?? ''); undone = undoneBy(cancelled.get(String(r.id))); if (!undone) canUndo = 'supplier'; break;
        case 'shift.open': amount = usd(a.float_usd_cents) + (num(a.float_lbp) ? ' + ' + lbp(a.float_lbp) : ''); break;
        case 'shift.close': amount = usd(a.counted_usd_cents) + (num(a.counted_lbp) ? ' + ' + lbp(a.counted_lbp) : ''); detail = num(a.diff_usd_cents) || num(a.diff_lbp) ? `${pt('difference', locale)} ${usd(a.diff_usd_cents)} / ${lbp(a.diff_lbp)}` : ''; break;
        case 'stock.move': amount = `${num(a.qty) > 0 ? '+' : ''}${num(a.qty)}`; detail = String(a.kind ?? '') + (a.note ? ` · ${a.note}` : ''); undone = undoneBy(cancelled.get(String(r.id))); if (!undone) canUndo = 'stock'; break;
        case 'rate.set': amount = `$1 = ${num(a.lbp_per_usd).toLocaleString('en-US')}`; break;
        case 'op.cancel': detail = [label(String(a.action ?? '')), String(a.reason ?? '')].filter(Boolean).join(' · '); break;
        case 'sale.cancel': detail = `${num(a.lines)} ${pt('itemsCount', locale)}${a.reason ? ' · ' + a.reason : ''}`; break;
        default: detail = String((a.customer_name ?? a.name ?? '') || '');
      }
      if (failed) { canUndo = null; why = null; }
      return { ...r, failed, amount, detail, undone, canUndo, why };
    });
  }, [rows, members, locale, nums]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = ops.filter(o => (!who || o.user_id === who) && (kind === 'all' || MONEY.includes(o.action)) && (!type || o.action === type));
  const types = [...new Set(ops.map(o => o.action))];

  // ---- cancel: reason first, then the existing reversal for that kind of operation ----
  const cancel = async (o: Op, reason: string) => {
    setAsk(null); setMsg(null);
    const id = String(o.ref_id ?? o.after?.id ?? '');
    try {
      if (o.canUndo && SERVER_CANCEL.includes(o.canUndo)) {
        const shift = await currentShift(boot.db);
        const { error } = await sb.rpc('pos_op_cancel', { p_shop: boot.shop.id, p_audit_id: o.id, p_shift: shift?.id ?? null, p_reason: reason });
        if (error) { const k = ({ no_open_shift: 'opsErrNoShift', owner_only: 'opsErrOwner', cash_move_unmarked: 'opsWhyCashOld', cash_move_belongs_to_operation: 'opsWhyCashLinked', has_driver_cash: 'opsErrDriverCash', has_return: 'opsErrHasReturn', debt_collected: 'opsErrDebtCollected', other_payments: 'opsErrOtherPays' } as Record<string, Key>)[error.message]; setMsg(k ? pt(k, locale) : error.message); return; }
        boot.engine.poke(); setMsg(pt('opsCancelled', locale)); setTick(t => t + 1); return;
      }
      if (o.canUndo === 'sale') {
        const order = await boot.db.orders.get(id); const lines = await boot.db.orderLines.where('order_id').equals(id).toArray();
        if (!order || !lines.length) { setMsg(pt('opsNotOnDevice', locale)); return; }
        setRet({ order, lines, reason }); return;                                          // the return screen, every line pre-filled
      }
      if (o.canUndo === 'purchase') {
        const p = await boot.db.purchases.get(id); if (!p) { setMsg(pt('opsNotOnDevice', locale)); return; }
        await voidPurchase(boot.db, p, reason, staff.user_id, staff.user_id);
      }
      if (o.canUndo === 'debt') {
        const s = await boot.db.debtSettlements.get(id); if (!s) { setMsg(pt('opsNotOnDevice', locale)); return; }
        await unsettleDebt(boot.db, s, { shift: await currentShift(boot.db), user_id: staff.user_id, reason, approved_by: null, label: `${pt('opsCancel', locale)} · ${s.name || s.phone}` });
      }
      boot.engine.poke(); setMsg(pt('opsCancelled', locale)); setTimeout(() => setTick(t => t + 1), 2500);
    } catch (e) { setMsg((e as Error).message); }
  };

  if (err) return <p className="bad">{err}</p>;
  if (!rows) return <p className="muted">…</p>;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="seg"><button className={kind === 'money' ? 'active' : ''} onClick={() => setKind('money')}>💵 {pt('opsMoney', locale)}</button><button className={kind === 'all' ? 'active' : ''} onClick={() => setKind('all')}>{pt('opsAll', locale)}</button></div>
        <select className="input" style={{ width: 'auto' }} value={who} onChange={e => setWho(e.target.value)}><option value="">👤 {pt('opsEveryone', locale)}</option>{members.map(m => <option key={m.user_id} value={m.user_id}>{m.display_name || m.full_name}</option>)}</select>
        <select className="input" style={{ width: 'auto' }} value={type} onChange={e => setType(e.target.value)}><option value="">{pt('opsAllTypes', locale)}</option>{types.map(t => <option key={t} value={t}>{label(t)}</option>)}</select>
        <span className="muted">{shown.length}</span>
      </div>
      {msg && <div className="card" style={{ padding: 10 }}>{msg}</div>}
      {!shown.length ? <p className="muted">—</p> : <table className="table ops-log"><tbody>
        {shown.map(o => <tr key={o.id} style={{ cursor: 'pointer', ...(o.undone || o.failed ? { opacity: .6 } : {}) }} onClick={() => {
          // a sale, a payment or a return opens the sale with its items; any other operation opens what was recorded
          const a = o.after ?? {}; const orderId = o.action === 'sale.commit' ? (o.ref_id ?? a.id) : o.action === 'order.pay' ? a.id : o.action === 'return.commit' ? a.order_id : null;
          if (orderId && onSale) onSale(String(orderId)); else setView(o); }}>
          <td style={{ whiteSpace: 'nowrap' }} className="muted">{fmtTime(o.at, locale)}<div style={{ fontSize: 12 }}>{nameOf(o.user_id)}</div></td>
          <td><strong style={o.undone ? { textDecoration: 'line-through' } : undefined}>{label(o.action)}</strong>{o.failed && <span className="pill bad" style={{ marginInlineStart: 6 }}>{pt('opsFailed', locale)}</span>}
            {o.detail && <div className="muted" style={{ fontSize: 12 }}>{o.detail}</div>}
            {o.undone && <div className="bad" style={{ fontSize: 12 }}>↩ {pt('opsUndone', locale)}: {o.undone}</div>}
            {o.why && <div className="muted" style={{ fontSize: 11 }}>ⓘ {o.why}</div>}</td>
          <td className="num" style={{ whiteSpace: 'nowrap' }}>{o.amount}</td>
          <td onClick={e => e.stopPropagation()}>{o.canUndo && <button className="btn danger" style={{ minHeight: 0, padding: '4px 10px' }} onClick={() => setAsk(o)}>✕ {pt('opsCancel', locale)}</button>}</td>
        </tr>)}
      </tbody></table>}
      <p className="muted" style={{ fontSize: 12 }}>{pt('opsNote', locale)}</p>
      {view && <OpDetail boot={boot} locale={locale} op={view} label={label(view.action)} who={nameOf(view.user_id)} onClose={() => setView(null)} />}
      {ask && <ReasonDialog locale={locale} op={ask} label={label(ask.action)} onOk={r => void cancel(ask, r)} onClose={() => setAsk(null)} />}
      {ret && <ReturnDialog boot={boot} locale={locale} order={ret.order} lines={ret.lines} staff={staff} full presetReason={ret.reason}
        onDone={() => { setRet(null); boot.engine.poke(); setMsg(pt('opsCancelled', locale)); setTimeout(() => setTick(t => t + 1), 2500); }} onClose={() => setRet(null)} />}
    </div>
  );
}

function ReasonDialog({ locale, op, label, onOk, onClose }: { locale: L; op: Op; label: string; onOk: (reason: string) => void; onClose: () => void }) {
  const [k, setK] = useState<typeof REASONS[number] | null>(null); const [note, setNote] = useState('');
  const reason = k === 'other' ? note.trim() : k ? pt(k === 'test' ? 'opsReasonTest' : 'opsReasonMistake', locale) + (note.trim() ? ` · ${note.trim()}` : '') : '';
  return (
    <Modal open onClose={onClose} title={`${pt('opsCancel', locale)} · ${label}`}
      footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn danger" disabled={!reason} onClick={() => onOk(reason)}>✕ {pt('opsCancel', locale)}</button></>}>
      <p style={{ marginTop: 0 }}><strong>{label}</strong> {op.amount} <span className="muted">{op.detail}</span></p>
      <p className="muted" style={{ fontSize: 13 }}>{pt(({ sale: 'opsSaleHow', purchase: 'opsPurchaseHow', debt: 'opsDebtHow', cash: 'opsCashHow', stock: 'opsStockHow', supplier: 'opsSupplierHow', payout: 'opsPayoutHow', pay: 'opsPayHow' } as const)[op.canUndo ?? 'debt'], locale)}</p>
      <div className="seg" style={{ marginBottom: 8 }}>{REASONS.map(r => <button key={r} className={k === r ? 'active' : ''} onClick={() => setK(r)}>{pt(r === 'test' ? 'opsReasonTest' : r === 'mistake' ? 'opsReasonMistake' : 'opsReasonOther', locale)}</button>)}</div>
      <input className="input" placeholder={pt('opsReasonNote', locale)} value={note} onChange={e => setNote(e.target.value)} />
    </Modal>
  );
}

/** Any operation other than a sale: what the till recorded — its lines (purchase, return, stock) with item names, and its fields. */
export function OpDetail({ boot, locale, op, label, who, onClose }: { boot: Booted; locale: L; op: Pick<Op, 'id' | 'at' | 'after' | 'amount' | 'detail'>; label: string; who: string; onClose: () => void }) {
  const a = op.after ?? {}; const lines = Array.isArray(a.lines) ? (a.lines as Record<string, unknown>[]) : [];
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => { const ids = lines.map(l => String(l.product_id ?? '')).filter(Boolean); if (!ids.length) return;
    boot.db.products.bulkGet(ids).then(ps => setNames(Object.fromEntries(ps.filter(Boolean).map(p => [p!.id, (locale === 'ar' ? p!.name.ar || p!.name.en : p!.name.en || p!.name.ar) ?? ''])))); }, [boot, op.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // only the words a person reads (amounts are already in the line above, in $ / L.L.)
  const FIELD: Record<string, [string, string]> = { reason: ['السبب', 'Reason'], note: ['ملاحظة', 'Note'], name: ['الاسم', 'Name'], phone: ['الهاتف', 'Phone'], customer_name: ['الزبون', 'Customer'],
    customer_phone: ['هاتف الزبون', 'Customer phone'], invoice_no: ['رقم الفاتورة', 'Invoice no.'], kind: ['النوع', 'Kind'], status: ['الحالة', 'Status'], tender: ['طريقة الدفع', 'Paid by'], number: ['الرقم', 'Number'] };
  const KIND: Record<string, [string, string]> = { in: ['إدخال', 'In'], out: ['إخراج', 'Out'], receive: ['استلام', 'Received'], adjust: ['تعديل', 'Adjustment'], damage: ['تالف', 'Damaged'], count: ['جرد', 'Count'] };
  const show = (k: string, v: unknown) => k === 'kind' && KIND[String(v)] ? KIND[String(v)][locale === 'ar' ? 0 : 1] : k === 'tender' ? pt(String(v) as Key, locale) : String(v);
  const fields = Object.entries(a).filter(([k, v]) => FIELD[k] && v !== null && v !== '' && typeof v !== 'object');
  return (
    <Modal open onClose={onClose} wide title={<>{label} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>· {fmtTime(op.at, locale)} · {who}</span></>}
      footer={<><span style={{ flex: 1 }} /><button className="btn primary" onClick={onClose}>{pt('ok', locale)}</button></>}>
      {op.amount && <p style={{ marginTop: 0 }}><strong className="num">{op.amount}</strong> <span className="muted">{op.detail}</span></p>}
      {!!lines.length && <table className="table"><tbody>
        <tr><th style={{ textAlign: 'start' }}>{pt('items', locale)}</th><th>{pt('qty', locale)}</th><th className="num">{pt('total', locale)}</th></tr>
        {lines.map((l, i) => { const nm = (l.name as { ar?: string; en?: string } | undefined); const name = nm ? (locale === 'ar' ? nm.ar || nm.en : nm.en || nm.ar) : names[String(l.product_id ?? '')] || '—';
          const cents = num(l.line_total_cents ?? l.amount_cents); return <tr key={i}><td>{name}</td><td style={{ textAlign: 'center' }}>{num(l.qty ?? l.quantity)}</td><td className="num">{cents ? fmtUsd(cents) : ''}</td></tr>; })}
      </tbody></table>}
      {!!fields.length && <table className="table" style={{ marginTop: 8 }}><tbody>
        {fields.map(([k, v]) => <tr key={k}><td className="muted">{FIELD[k][locale === 'ar' ? 0 : 1]}</td><td style={{ overflowWrap: 'anywhere' }}>{show(k, v)}</td></tr>)}
      </tbody></table>}
    </Modal>
  );
}
