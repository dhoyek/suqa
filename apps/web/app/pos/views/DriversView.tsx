'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currentShift, dayKey, driverPayRule, fmtLbp, fmtPhone, fmtUsd, payDriver, roundLbp, setOrderDriverCash, setOrderDriverPay, text, usdToLbp, waDigits, type Currency, type DriverPayMode, type Rate, type Shift, type Staff, type SyncStatus } from '@suqa/pos-core';
import { pt, posErr, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import Modal from '../components/Modal';
import { doPrint, driverStatementHtml, loadPrintSettings } from '../lib/print';

type Drv = { id: string; name: string; phone: string; vehicle: string | null; active: boolean; pay_mode: DriverPayMode | null; pay_cents: number | null;
  deliveries: number; value_cents: number; earned_cents: number; avg_minutes: number | null; acked: number; owed_cents: number; owed_count: number; out_count: number; holding_cents: number; cash_cents?: number; cash_usd_cents?: number; cash_lbp?: number; cash_count?: number };
export type DrvOrder = { id: string; number: string | null; driver_id: string; status: string; customer: string | null; total_cents: number; delivery_fee_cents: number; pay_cents: number;
  paid_at: string | null; payout_id: string | null; at: string; placed_at: string; ack_at: string | null; picked_at: string | null; handed_at: string | null; due_cents: number; rate?: number; cash_cents?: number | null; cash_usd_cents?: number | null; cash_lbp?: number | null; cash_settled_at?: string | null };
export type Payout = { id: string; driver_id: string; orders_count: number; amount_cents: number; currency: Currency; amount: number; from_drawer: boolean; collected_cents: number; cash_cents?: number; cash_lbp?: number; note: string | null; at: string };
type Rep = { default: { mode: DriverPayMode; cents: number }; drivers: Drv[]; orders: DrvOrder[]; payouts: Payout[] };
type Preset = 'today' | 'week' | 'month' | 'lastMonth';
/** Cash as the driver holds it: dollars and lira side by side ("$29.00 + 540,000 ل.ل."). */
const cashText = (usd: number, lbp: number, locale: L) => [usd ? fmtUsd(usd) : '', lbp ? fmtLbp(lbp, locale) : ''].filter(Boolean).join(' + ') || fmtUsd(0);

function range(p: Preset): [string, string] {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (p === 'week') { const s = new Date(d); s.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return [dayKey(s), dayKey(d)]; }
  if (p === 'month') return [dayKey(new Date(d.getFullYear(), d.getMonth(), 1)), dayKey(d)];
  if (p === 'lastMonth') return [dayKey(new Date(d.getFullYear(), d.getMonth() - 1, 1)), dayKey(new Date(d.getFullYear(), d.getMonth(), 0))];
  return [dayKey(d), dayKey(d)];
}

/**
 * السائقون (owner): what each driver did in the period, the cash he is holding, what he has earned and what is still owed to him —
 * and settling with him. The customers' money is each order's own payment: taken at the till (Orders screen), or collected by the
 * driver when he confirms the delivery (tender 'driver' — with him until a settlement closes it, once). The driver's pay is settled
 * once per delivery. One settlement can close both. Read from the server (needs a connection).
 */
export default function DriversView({ boot, sb, locale, status, staff, tick }: { boot: Booted; sb: SupabaseClient; locale: L; status: SyncStatus | null; staff: Staff; tick: number }) {
  const online = status?.online ?? true;
  const [preset, setPreset] = useState<Preset>('month');
  const [rep, setRep] = useState<Rep | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null); const [rate, setRate] = useState(89500);
  const [from, to] = useMemo(() => range(preset), [preset]);
  const load = useCallback(async () => {
    if (!online) return;
    setBusy(true);
    const { data, error } = await sb.rpc('pos_driver_report', { p_shop: boot.shop.id, p_from: from, p_to: to });
    setBusy(false);
    if (error) { setErr(posErr(error.message, locale)); return; }
    setErr(null); setRep(data as Rep);
  }, [sb, boot, from, to, online]);
  useEffect(() => { void load(); }, [load, tick]);
  useEffect(() => { boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { if (r) setRate(r.lbp_per_usd); }); }, [boot, tick]);

  const ruleLabel = (d: Drv) => { const r = driverPayRule({ driver_pay_mode: rep?.default.mode, driver_pay_cents: rep?.default.cents }, d); return (r.mode === 'per_delivery' ? `${fmtUsd(r.cents)} · ${pt('pay_per_delivery', locale)}` : pt(`pay_${r.mode}` as 'pay_none', locale)) + (r.own ? ` (${pt('payOwn', locale)})` : ''); };
  const drivers = rep?.drivers ?? [];
  const shown = drivers.filter(d => d.active || d.deliveries || d.owed_cents || d.out_count || d.cash_cents);
  const cashOf = (d: Drv) => d.cash_cents ?? 0;
  const tot = shown.reduce((s, d) => ({ deliveries: s.deliveries + d.deliveries, owed: s.owed + d.owed_cents, holding: s.holding + d.holding_cents + cashOf(d), earned: s.earned + d.earned_cents }), { deliveries: 0, owed: 0, holding: 0, earned: 0 });
  const sel = open ? drivers.find(d => d.id === open) ?? null : null;

  return (
    <div className="stack" style={{ padding: 12, maxWidth: 1100, marginInline: 'auto' }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>🛵 {pt('driversNav', locale)}</h3>
        <div className="seg">{(['today', 'week', 'month', 'lastMonth'] as Preset[]).map(p => <button key={p} className={preset === p ? 'active' : ''} onClick={() => setPreset(p)}>{pt(p === 'today' ? 'pToday' : p === 'week' ? 'pWeek' : p === 'month' ? 'pMonth' : 'pLastMonth', locale)}</button>)}</div>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={busy || !online} onClick={() => void load()}>{busy ? '…' : '🔄'}</button>
      </div>
      {!online && <div className="card muted">{pt('needOnline', locale)}</div>}
      {err && <div className="card bad">{err}</div>}
      {rep && <>
        <div className="kpis">
          <div className="kpi"><span>{pt('drvDeliveries', locale)}</span><strong>{tot.deliveries}</strong></div>
          <div className="kpi"><span>{pt('drvEarned', locale)}</span><strong>{fmtUsd(tot.earned)}</strong></div>
          <div className="kpi"><span>{pt('drvOwed', locale)}</span><strong className={tot.owed > 0 ? 'bad' : ''}>{fmtUsd(tot.owed)}</strong></div>
          <div className="kpi"><span>{pt('drvHolding', locale)}</span><strong>{fmtUsd(tot.holding)}</strong></div>
        </div>
        {!shown.length && <div className="card muted">{pt('drvNoData', locale)}</div>}
        <div className="drv-grid">
          {shown.map(d => <button key={d.id} className={`card drv-card ${d.active ? '' : 'muted'}`} onClick={() => setOpen(d.id)}>
            <div className="row spread" style={{ alignItems: 'center' }}><strong>🛵 {d.name}</strong>{d.out_count > 0 && <span className="pill warn">{pt('drvOut', locale)} · {d.out_count}</span>}</div>
            <small className="muted">{ruleLabel(d)}</small>
            <div className="drv-stats">
              <span><b>{d.deliveries}</b> {pt('drvDeliveries', locale)}</span>
              <span><b>{fmtUsd(d.value_cents)}</b> {pt('drvValue', locale)}</span>
              {d.avg_minutes != null && <span><b>{d.avg_minutes}′</b> {pt('drvAvg', locale)}</span>}
              {d.deliveries > 0 && <span><b>{Math.round((d.acked / d.deliveries) * 100)}%</b> {pt('drvAck', locale)}</span>}
            </div>
            <div className="row spread drv-money">
              <span>{pt('drvHolding', locale)} <b>{fmtUsd(d.holding_cents + cashOf(d))}</b></span>
              <span className={d.owed_cents > 0 ? 'bad' : 'muted'}>{pt('drvOwed', locale)} <b>{fmtUsd(d.owed_cents)}</b></span>
            </div>
          </button>)}
        </div>
      </>}
      {sel && rep && <DriverSheet boot={boot} locale={locale} staff={staff} d={sel} rule={ruleLabel(sel)} rate={rate} from={from} to={to}
        orders={rep.orders.filter(o => o.driver_id === sel.id)} payouts={rep.payouts.filter(p => p.driver_id === sel.id)}
        onClose={() => setOpen(null)}
        onChanged={patch => { setRep(r => (r ? patch(r) : r)); setTimeout(() => void load(), 2500); }} />}
    </div>
  );
}

function DriverSheet({ boot, locale, staff, d, rule, rate, from, to, orders, payouts, onClose, onChanged }: { boot: Booted; locale: L; staff: Staff; d: Drv; rule: string; rate: number; from: string; to: string; orders: DrvOrder[]; payouts: Payout[]; onClose: () => void; onChanged: (patch: (r: Rep) => Rep) => void }) {
  const payOpen = (o: DrvOrder) => o.status === 'delivered' && !o.paid_at && o.pay_cents > 0;
  const cashOpen = (o: DrvOrder) => o.status === 'delivered' && ((o.cash_usd_cents ?? 0) !== 0 || (o.cash_lbp ?? 0) !== 0) && !o.cash_settled_at;   // collected by him, not handed over yet
  const openList = orders.filter(o => payOpen(o) || cashOpen(o));
  const out = orders.filter(o => o.status === 'out_for_delivery');
  const done = orders.filter(o => o.status === 'delivered');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(openList.map(o => o.id)));
  const [settle, setSettle] = useState(false); const [edit, setEdit] = useState<DrvOrder | null>(null); const [editCash, setEditCash] = useState<DrvOrder | null>(null);
  const chosen = openList.filter(o => picked.has(o.id) && payOpen(o)); const chosenCents = chosen.reduce((s, o) => s + o.pay_cents, 0);
  const chosenCash = openList.filter(o => picked.has(o.id) && cashOpen(o)); const chosenCashCents = chosenCash.reduce((s, o) => s + (o.cash_cents ?? 0), 0);
  const chosenUsd = chosenCash.reduce((s, o) => s + (o.cash_usd_cents ?? 0), 0), chosenLbp = chosenCash.reduce((s, o) => s + (o.cash_lbp ?? 0), 0);
  const chosenNet = chosenCashCents - chosenCents;
  const cash = d.cash_cents ?? 0;
  const net = cash - d.owed_cents;
  const step = boot.shop.lbp_rounding_step ?? 5000;
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const statementText = () => [
    `${pt('drvStatement', locale)} — ${d.name} — ${text(boot.shop.name, locale)} (${from} → ${to})`,
    `${pt('drvDeliveries', locale)}: ${d.deliveries} · ${pt('drvValue', locale)}: ${fmtUsd(d.value_cents)}`,
    `${pt('drvEarned', locale)}: ${fmtUsd(d.earned_cents)}`,
    `${pt('drvCash', locale)}: ${cashText(d.cash_usd_cents ?? 0, d.cash_lbp ?? 0, locale)}`,
    `${pt('drvOwed', locale)}: ${fmtUsd(d.owed_cents)}`,
    `${pt(net >= 0 ? 'drvNet' : 'drvNetWeOwe', locale)}: ${fmtUsd(Math.abs(net))}`,
  ].join('\n');
  const state = (o: DrvOrder) => o.status === 'out_for_delivery' ? (o.handed_at ? pt('drvHandedNotPaid', locale) : pt('drvOnRoad', locale)) : o.due_cents > 0 ? pt('unpaid', locale) : pt('customerPaid', locale);
  return (
    <Modal open onClose={onClose} wide title={`🛵 ${d.name}`}
      footer={<><button className="btn" onClick={() => doPrint(driverStatementHtml(d.name, { from, to, deliveries: d.deliveries, value_cents: d.value_cents, earned_cents: d.earned_cents, holding_cents: cash + d.holding_cents, owed_cents: d.owed_cents }, done.map(o => ({ at: o.at, number: o.number ?? '', total_cents: o.total_cents, pay_cents: o.pay_cents, settled: !!o.paid_at })), boot.shop, locale, loadPrintSettings()))}>🖨 {pt('drvStatement', locale)}</button>
        <a className="btn" href={`https://wa.me/${waDigits(d.phone)}?text=${encodeURIComponent(statementText())}`} target="_blank" rel="noreferrer">💬 WhatsApp</a>
        <span style={{ flex: 1 }} /><button className="btn primary" disabled={!chosen.length && !chosenCash.length} onClick={() => setSettle(true)}>💵 {pt('settleSelected', locale)} · {chosenCash.length ? `${pt(chosenNet >= 0 ? 'drvNet' : 'drvNetWeOwe', locale)} ${fmtUsd(Math.abs(chosenNet))}` : fmtUsd(chosenCents)}</button></>}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted" dir="ltr">{fmtPhone(d.phone)}</span><a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`tel:+${waDigits(d.phone)}`}>📞</a>
        <span className="pill">{rule}</span>
      </div>
      <div className="kpis" style={{ marginTop: 10 }}>
        <div className="kpi"><span>{pt('drvCash', locale)}</span><strong dir="ltr" style={{ fontSize: (d.cash_lbp ?? 0) ? 16 : undefined }}>{cashText(d.cash_usd_cents ?? 0, d.cash_lbp ?? 0, locale)}</strong><small>{out.length ? `${pt('drvOut', locale)} ${out.length} · ${fmtUsd(d.holding_cents)}` : `${d.cash_count ?? 0} ${pt('drvDeliveries', locale)}`}</small></div>
        <div className="kpi"><span>{pt('drvOwed', locale)}</span><strong className={d.owed_cents > 0 ? 'bad' : ''}>{fmtUsd(d.owed_cents)}</strong><small>{d.owed_count} {pt('drvDeliveries', locale)}</small></div>
        <div className="kpi"><span>{pt(net >= 0 ? 'drvNet' : 'drvNetWeOwe', locale)}</span><strong>{fmtUsd(Math.abs(net))}</strong><small>{fmtLbp(roundLbp(usdToLbp(Math.abs(net), rate), step), locale)}</small></div>
      </div>
      {out.length > 0 && <>
        <h4 style={{ margin: '14px 0 4px' }}>{pt('drvOut', locale)}</h4>
        <table className="table"><tbody>{out.map(o => <tr key={o.id}><td><strong dir="ltr">{o.number}</strong> <span className="muted">{o.customer}</span></td><td className="muted">{state(o)}</td><td className="num">{fmtUsd(o.due_cents)}</td></tr>)}</tbody></table>
      </>}
      <h4 style={{ margin: '14px 0 4px' }}>{pt('drvDeliveries', locale)} ({done.length})</h4>
      <table className="table"><tbody>
        <tr><th /><th style={{ textAlign: 'start' }}>{pt('when', locale)}</th><th style={{ textAlign: 'start' }}>{pt('orderNo', locale)}</th><th>{pt('total', locale)}</th><th style={{ textAlign: 'start' }} /><th>{pt('drvCashCol', locale)}</th><th>{pt('driverPay', locale)}</th><th /></tr>
        {done.map(o => { const owed = payOpen(o) || cashOpen(o); return <tr key={o.id}>
          <td>{owed && <input type="checkbox" checked={picked.has(o.id)} onChange={() => toggle(o.id)} />}</td>
          <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(o.at, locale)}</td>
          <td><strong dir="ltr">{o.number}</strong> <span className="muted">{o.customer}</span></td>
          <td className="num">{fmtUsd(o.total_cents)}</td>
          <td className={o.due_cents > 0 ? 'bad' : 'muted'} style={{ fontSize: 12 }}>{state(o)}</td>
          <td className="num" style={{ whiteSpace: 'nowrap' }}>{o.cash_cents != null ? <><strong dir="ltr" className={o.cash_settled_at ? 'muted' : ''}>{cashText(o.cash_usd_cents ?? 0, o.cash_lbp ?? 0, locale)}</strong>{o.cash_settled_at ? <span className="ok" style={{ fontSize: 12 }}> ✓</span> : <button className="link-btn" style={{ marginInlineStart: 6 }} title={pt('edit', locale)} onClick={() => setEditCash(o)}>✎</button>}</> : o.due_cents > 0 ? <button className="link-btn" title={pt('drvCashFix', locale)} onClick={() => setEditCash(o)}>＋</button> : <span className="muted">—</span>}</td>
          <td className="num"><strong>{fmtUsd(o.pay_cents)}</strong>{!o.paid_at && <button className="link-btn" style={{ marginInlineStart: 6 }} title={pt('edit', locale)} onClick={() => setEdit(o)}>✎</button>}</td>
          <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{o.paid_at ? <span className="ok">✓ {pt('settled', locale)} {fmtTime(o.paid_at, locale)}</span> : o.pay_cents > 0 ? <span className="bad">{pt('notSettled', locale)}</span> : <span className="muted">—</span>}</td>
        </tr>; })}
        {!done.length && <tr><td className="muted" colSpan={8}>—</td></tr>}
      </tbody></table>
      {payouts.length > 0 && <>
        <h4 style={{ margin: '14px 0 4px' }}>{pt('pastPayouts', locale)}</h4>
        <table className="table"><tbody>{payouts.map(p => <tr key={p.id}><td className="muted">{fmtTime(p.at, locale)}</td><td>{p.orders_count} {pt('drvDeliveries', locale)}</td><td className="muted">{pt(p.from_drawer ? 'settleFromDrawer' : 'settleOutside', locale)}{p.note ? ` · ${p.note}` : ''}</td><td className="num">{((p.cash_cents ?? 0) !== 0 || (p.cash_lbp ?? 0) !== 0) && <div className="muted" style={{ fontSize: 12 }}>{pt('drvCashIn', locale)} <span dir="ltr">{cashText(p.cash_cents ?? 0, p.cash_lbp ?? 0, locale)}</span></div>}<strong>{pt('driverPay', locale)} {fmtUsd(p.amount_cents)}</strong>{p.currency === 'lbp' && p.amount > 0 && <div className="muted" style={{ fontSize: 12 }}>{fmtLbp(p.amount, locale)}</div>}</td></tr>)}</tbody></table>
      </>}
      {settle && <SettleDialog boot={boot} locale={locale} staff={staff} d={d} orders={chosen} cents={chosenCents} cashOrders={chosenCash} cashCents={chosenCashCents} cashUsd={chosenUsd} cashLbp={chosenLbp} rate={rate} onClose={() => setSettle(false)}
        onDone={(ids, cashIds, at, payout) => { setSettle(false); setPicked(new Set()); onChanged(r => ({ ...r, payouts: [payout, ...r.payouts],
          orders: r.orders.map(o => ({ ...o, ...(ids.includes(o.id) ? { paid_at: at, payout_id: payout.id } : {}), ...(cashIds.includes(o.id) ? { cash_settled_at: at } : {}) })),
          drivers: r.drivers.map(x => (x.id === d.id ? { ...x, owed_cents: Math.max(0, x.owed_cents - payout.amount_cents), owed_count: Math.max(0, x.owed_count - ids.length), cash_cents: (x.cash_cents ?? 0) - chosenCashCents, cash_usd_cents: (x.cash_usd_cents ?? 0) - (payout.cash_cents ?? 0), cash_lbp: (x.cash_lbp ?? 0) - (payout.cash_lbp ?? 0), cash_count: Math.max(0, (x.cash_count ?? 0) - cashIds.length) } : x)) })); }} />}
      {editCash && <EditCash locale={locale} o={editCash} rate={editCash.rate || rate} onClose={() => setEditCash(null)} onSave={async (usd, lbp, value) => {
        await setOrderDriverCash(boot.db, editCash.id, usd, lbp); boot.engine.poke();   // the server checks: owner only, not settled, never more than the order
        const dv = value - (editCash.cash_cents ?? 0), du = usd - (editCash.cash_usd_cents ?? 0), dl = lbp - (editCash.cash_lbp ?? 0); setEditCash(null);
        onChanged(r => ({ ...r, orders: r.orders.map(o => (o.id === editCash.id ? { ...o, cash_cents: value, cash_usd_cents: usd, cash_lbp: lbp, due_cents: Math.max(0, o.due_cents - dv) } : o)), drivers: r.drivers.map(x => (x.id === d.id ? { ...x, cash_cents: (x.cash_cents ?? 0) + dv, cash_usd_cents: (x.cash_usd_cents ?? 0) + du, cash_lbp: (x.cash_lbp ?? 0) + dl } : x)) }));
      }} />}
      {edit && <EditPay locale={locale} o={edit} onClose={() => setEdit(null)} onSave={async cents => {
        await setOrderDriverPay(boot.db, edit.id, cents); boot.engine.poke();   // the till may not hold an old order: the change still goes to the server
        const delta = cents - edit.pay_cents; setEdit(null);
        onChanged(r => ({ ...r, orders: r.orders.map(o => (o.id === edit.id ? { ...o, pay_cents: cents } : o)), drivers: r.drivers.map(x => (x.id === d.id ? { ...x, owed_cents: Math.max(0, x.owed_cents + delta), earned_cents: Math.max(0, x.earned_cents + delta) } : x)) }));
      }} />}
    </Modal>
  );
}

function EditPay({ locale, o, onSave, onClose }: { locale: L; o: DrvOrder; onSave: (cents: number) => void; onClose: () => void }) {
  const [v, setV] = useState((o.pay_cents / 100).toFixed(2));
  const cents = Math.round((Number(v) || 0) * 100);
  return <Modal open onClose={onClose} title={`${pt('driverPay', locale)} · ${o.number ?? ''}`} footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" disabled={cents === o.pay_cents || cents < 0} onClick={() => onSave(cents)}>{pt('save', locale)}</button></>}>
    <label className="label">{pt('driverPay', locale)} ($)<input className="input" dir="ltr" inputMode="decimal" autoFocus value={v} onFocus={e => e.target.select()} onChange={e => setV(e.target.value.replace(/[^0-9.]/g, ''))} onKeyDown={e => { if (e.key === 'Enter' && cents !== o.pay_cents) onSave(cents); }} /></label>
  </Modal>;
}

/** The owner corrects the cash the driver recorded on one delivery: dollars and lira (0 and 0 = he holds nothing for it). */
function EditCash({ locale, o, rate, onSave, onClose }: { locale: L; o: DrvOrder; rate: number; onSave: (usd: number, lbp: number, value: number) => void; onClose: () => void }) {
  const cur = o.cash_cents ?? 0; const max = cur + o.due_cents;
  const [u, setU] = useState(((o.cash_usd_cents ?? 0) / 100).toFixed(2)); const [l, setL] = useState(String(o.cash_lbp ?? 0));
  const usd = Math.round((Number(u) || 0) * 100), lbp = Math.round(Number(l) || 0); const value = usd + Math.round((lbp * 100) / rate);
  const tol = Math.ceil(500000 / rate) + 1;
  const ok = (usd !== (o.cash_usd_cents ?? 0) || lbp !== (o.cash_lbp ?? 0)) && usd >= 0 && lbp >= 0 && value <= max + tol;
  return <Modal open onClose={onClose} title={`${pt('drvCashFix', locale)} · ${o.number ?? ''}`} footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" disabled={!ok} onClick={() => onSave(usd, lbp, value)}>{pt('save', locale)}</button></>}>
    <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{pt('drvCashFixHint', locale)} · {pt('total', locale)} {fmtUsd(o.total_cents)}</p>
    <label className="label">{pt('drvCashCol', locale)} ($)<input className="input" dir="ltr" inputMode="decimal" autoFocus value={u} onFocus={e => e.target.select()} onChange={e => setU(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
    <label className="label">{pt('drvCashCol', locale)} (ل.ل.)<input className="input" dir="ltr" inputMode="numeric" value={l} onFocus={e => e.target.select()} onChange={e => setL(e.target.value.replace(/[^0-9]/g, ''))} /></label>
    {value > max + tol && <small className="bad">{pt('drvCashTooMuch', locale)} {fmtUsd(max)}</small>}
  </Modal>;
}

function SettleDialog({ boot, locale, staff, d, orders, cents, cashOrders, cashCents, cashUsd, cashLbp, rate, onClose, onDone }: { boot: Booted; locale: L; staff: Staff; d: Drv; orders: DrvOrder[]; cents: number; cashOrders: DrvOrder[]; cashCents: number; cashUsd: number; cashLbp: number; rate: number; onClose: () => void; onDone: (ids: string[], cashIds: string[], at: string, payout: Payout) => void }) {
  const [shift, setShift] = useState<Shift | null>(null); const [drawer, setDrawer] = useState(false); const [cur, setCur] = useState<Currency>('usd'); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { currentShift(boot.db).then(s => { setShift(s); setDrawer(!!s); }); }, [boot]);
  const step = boot.shop.lbp_rounding_step ?? 5000;
  const amount = cur === 'lbp' ? roundLbp(usdToLbp(cents, rate), step) : cents;          // his pay, in the currency it is paid in
  const net = cashCents - cents;                                                           // value: > 0 he hands the shop the difference
  // what really changes hands, per currency: the cash he brings minus his pay in the chosen currency
  const netUsd = cashUsd - (cur === 'usd' ? amount : 0), netLbp = cashLbp - (cur === 'lbp' ? amount : 0);
  const side = (n: number, txt: string) => <div className="row spread"><span>{pt(n >= 0 ? 'drvHandsIn' : 'drvWePay', locale)}</span><strong dir="ltr">{txt}</strong></div>;
  const go = async () => {
    if (busy) return; setBusy(true); setErr(null);
    try {
      const r = await payDriver(boot.db, { driver: { id: d.id, name: d.name }, orders: orders.map(o => ({ id: o.id, courier_fee_cents: o.pay_cents })), cash_orders: cashOrders.map(o => ({ id: o.id, usd_cents: o.cash_usd_cents ?? 0, lbp: o.cash_lbp ?? 0 })),
        currency: cur, amount, rate, from_drawer: drawer, shift, note: note.trim() || null, user_id: staff.user_id,
        label: `${pt(cashOrders.length ? 'settleTitle' : 'driverPay', locale)} · ${d.name} · ${Math.max(orders.length, cashOrders.length)}` });
      boot.engine.poke();
      const at = new Date().toISOString();
      onDone(orders.map(o => o.id), cashOrders.map(o => o.id), at, { id: r?.id ?? at, driver_id: d.id, orders_count: orders.length, amount_cents: cents, cash_cents: cashUsd, cash_lbp: cashLbp, currency: cur, amount, from_drawer: drawer && !!shift, collected_cents: orders.reduce((s, o) => s + o.total_cents, 0), note: note.trim() || null, at });
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`💵 ${pt('settleTitle', locale)} · ${d.name}`}
      footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary big" style={{ width: 'auto', minWidth: 200 }} disabled={busy || (!orders.length && !cashOrders.length)} onClick={go}>{pt('settle', locale)}</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{pt('settleHint', locale)}</p>
        {cashOrders.length > 0 && <div className="row spread"><span>{pt('drvCashIn', locale)} <small className="muted">({cashOrders.length})</small></span><strong dir="ltr">{cashText(cashUsd, cashLbp, locale)}</strong></div>}
        <div className="row spread"><span>{pt('driverPay', locale)} <small className="muted">({orders.length})</small></span><strong dir="ltr">{cashOrders.length ? '− ' : ''}{cur === 'lbp' ? fmtLbp(amount, locale) : fmtUsd(amount)}</strong></div>
        <div className="stack" style={{ gap: 4, padding: '8px 10px', background: net >= 0 ? '#ecfdf5' : '#fff8e6', borderRadius: 10 }}>
          {netUsd !== 0 && side(netUsd, fmtUsd(Math.abs(netUsd)))}
          {netLbp !== 0 && side(netLbp, fmtLbp(Math.abs(netLbp), locale))}
          {netUsd === 0 && netLbp === 0 && <div className="row spread"><span>{pt('drvNet', locale)}</span><strong>{fmtUsd(0)}</strong></div>}
          {(cashLbp !== 0 || cur === 'lbp') && <small className="muted">{pt(net >= 0 ? 'drvNet' : 'drvNetWeOwe', locale)} ≈ {fmtUsd(Math.abs(net))}</small>}
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="seg"><button className={drawer ? 'active' : ''} disabled={!shift} onClick={() => setDrawer(true)}>{pt(net >= 0 ? 'settleToDrawer' : 'settleFromDrawer', locale)}</button><button className={!drawer ? 'active' : ''} onClick={() => setDrawer(false)}>{pt('settleOutside', locale)}</button></div>
          {orders.length > 0 && <div className="row" style={{ gap: 6, alignItems: 'center' }}><small className="muted">{pt('drvPayIn', locale)}</small><div className="seg"><button className={cur === 'usd' ? 'active' : ''} onClick={() => setCur('usd')}>$</button><button className={cur === 'lbp' ? 'active' : ''} onClick={() => setCur('lbp')}>ل.ل.</button></div></div>}
        </div>
        {!shift && <small className="muted">{pt('settleNoShift', locale)}</small>}
        <input className="input" placeholder={pt('note', locale)} value={note} maxLength={200} onChange={e => setNote(e.target.value)} />
        {err && <div className="bad">{err}</div>}
      </div>
    </Modal>
  );
}
