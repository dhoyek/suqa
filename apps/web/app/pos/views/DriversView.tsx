'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currentShift, dayKey, driverPayRule, fmtLbp, fmtPhone, fmtUsd, payDriver, roundLbp, setOrderDriverPay, text, usdToLbp, waDigits, type Currency, type DriverPayMode, type Rate, type Shift, type Staff, type SyncStatus } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import Modal from '../components/Modal';
import { doPrint, driverStatementHtml, loadPrintSettings } from '../lib/print';

type Drv = { id: string; name: string; phone: string; vehicle: string | null; active: boolean; pay_mode: DriverPayMode | null; pay_cents: number | null;
  deliveries: number; value_cents: number; earned_cents: number; avg_minutes: number | null; acked: number; owed_cents: number; owed_count: number; out_count: number; holding_cents: number };
export type DrvOrder = { id: string; number: string | null; driver_id: string; status: string; customer: string | null; total_cents: number; delivery_fee_cents: number; pay_cents: number;
  paid_at: string | null; payout_id: string | null; at: string; placed_at: string; ack_at: string | null; picked_at: string | null; handed_at: string | null; due_cents: number };
export type Payout = { id: string; driver_id: string; orders_count: number; amount_cents: number; currency: Currency; amount: number; from_drawer: boolean; collected_cents: number; note: string | null; at: string };
type Rep = { default: { mode: DriverPayMode; cents: number }; drivers: Drv[]; orders: DrvOrder[]; payouts: Payout[] };
type Preset = 'today' | 'week' | 'month' | 'lastMonth';

function range(p: Preset): [string, string] {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (p === 'week') { const s = new Date(d); s.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return [dayKey(s), dayKey(d)]; }
  if (p === 'month') return [dayKey(new Date(d.getFullYear(), d.getMonth(), 1)), dayKey(d)];
  if (p === 'lastMonth') return [dayKey(new Date(d.getFullYear(), d.getMonth() - 1, 1)), dayKey(new Date(d.getFullYear(), d.getMonth(), 0))];
  return [dayKey(d), dayKey(d)];
}

/**
 * السائقون (owner): what each driver did in the period, the cash he is holding, what he has earned and what is still owed to him —
 * and settling with him. Two separate records keep the books straight: the customers' money is each order's own payment
 * (Orders screen); the driver's pay is a payout that covers a delivery once. Read from the server (needs a connection).
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
    if (error) { setErr(error.message); return; }
    setErr(null); setRep(data as Rep);
  }, [sb, boot, from, to, online]);
  useEffect(() => { void load(); }, [load, tick]);
  useEffect(() => { boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { if (r) setRate(r.lbp_per_usd); }); }, [boot, tick]);

  const ruleLabel = (d: Drv) => { const r = driverPayRule({ driver_pay_mode: rep?.default.mode, driver_pay_cents: rep?.default.cents }, d); return (r.mode === 'per_delivery' ? `${fmtUsd(r.cents)} · ${pt('pay_per_delivery', locale)}` : pt(`pay_${r.mode}` as 'pay_none', locale)) + (r.own ? ` (${pt('payOwn', locale)})` : ''); };
  const drivers = rep?.drivers ?? [];
  const shown = drivers.filter(d => d.active || d.deliveries || d.owed_cents || d.out_count);
  const tot = shown.reduce((s, d) => ({ deliveries: s.deliveries + d.deliveries, owed: s.owed + d.owed_cents, holding: s.holding + d.holding_cents, earned: s.earned + d.earned_cents }), { deliveries: 0, owed: 0, holding: 0, earned: 0 });
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
              <span>{pt('drvHolding', locale)} <b>{fmtUsd(d.holding_cents)}</b></span>
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
  const owedList = orders.filter(o => o.status === 'delivered' && !o.paid_at && o.pay_cents > 0);
  const out = orders.filter(o => o.status === 'out_for_delivery');
  const done = orders.filter(o => o.status === 'delivered');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(owedList.map(o => o.id)));
  const [settle, setSettle] = useState(false); const [edit, setEdit] = useState<DrvOrder | null>(null);
  const chosen = owedList.filter(o => picked.has(o.id)); const chosenCents = chosen.reduce((s, o) => s + o.pay_cents, 0);
  const net = d.holding_cents - d.owed_cents;
  const step = boot.shop.lbp_rounding_step ?? 5000;
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const statementText = () => [
    `${pt('drvStatement', locale)} — ${d.name} — ${text(boot.shop.name, locale)} (${from} → ${to})`,
    `${pt('drvDeliveries', locale)}: ${d.deliveries} · ${pt('drvValue', locale)}: ${fmtUsd(d.value_cents)}`,
    `${pt('drvEarned', locale)}: ${fmtUsd(d.earned_cents)}`,
    `${pt('drvHolding', locale)}: ${fmtUsd(d.holding_cents)}`,
    `${pt('drvOwed', locale)}: ${fmtUsd(d.owed_cents)}`,
    `${pt(net >= 0 ? 'drvNet' : 'drvNetWeOwe', locale)}: ${fmtUsd(Math.abs(net))}`,
  ].join('\n');
  const state = (o: DrvOrder) => o.status === 'out_for_delivery' ? (o.handed_at ? pt('drvHandedNotPaid', locale) : pt('drvOnRoad', locale)) : o.due_cents > 0 ? pt('unpaid', locale) : pt('customerPaid', locale);
  return (
    <Modal open onClose={onClose} wide title={`🛵 ${d.name}`}
      footer={<><button className="btn" onClick={() => doPrint(driverStatementHtml(d.name, { from, to, deliveries: d.deliveries, value_cents: d.value_cents, earned_cents: d.earned_cents, holding_cents: d.holding_cents, owed_cents: d.owed_cents }, done.map(o => ({ at: o.at, number: o.number ?? '', total_cents: o.total_cents, pay_cents: o.pay_cents, settled: !!o.paid_at })), boot.shop, locale, loadPrintSettings()))}>🖨 {pt('drvStatement', locale)}</button>
        <a className="btn" href={`https://wa.me/${waDigits(d.phone)}?text=${encodeURIComponent(statementText())}`} target="_blank" rel="noreferrer">💬 WhatsApp</a>
        <span style={{ flex: 1 }} /><button className="btn primary" disabled={!chosen.length} onClick={() => setSettle(true)}>💵 {pt('settleSelected', locale)} · {fmtUsd(chosenCents)}</button></>}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted" dir="ltr">{fmtPhone(d.phone)}</span><a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`tel:+${waDigits(d.phone)}`}>📞</a>
        <span className="pill">{rule}</span>
      </div>
      <div className="kpis" style={{ marginTop: 10 }}>
        <div className="kpi"><span>{pt('drvHolding', locale)}</span><strong>{fmtUsd(d.holding_cents)}</strong><small>{out.length} {pt('drvOut', locale)}</small></div>
        <div className="kpi"><span>{pt('drvOwed', locale)}</span><strong className={d.owed_cents > 0 ? 'bad' : ''}>{fmtUsd(d.owed_cents)}</strong><small>{d.owed_count} {pt('drvDeliveries', locale)}</small></div>
        <div className="kpi"><span>{pt(net >= 0 ? 'drvNet' : 'drvNetWeOwe', locale)}</span><strong>{fmtUsd(Math.abs(net))}</strong><small>{fmtLbp(roundLbp(usdToLbp(Math.abs(net), rate), step), locale)}</small></div>
      </div>
      {out.length > 0 && <>
        <h4 style={{ margin: '14px 0 4px' }}>{pt('drvOut', locale)}</h4>
        <table className="table"><tbody>{out.map(o => <tr key={o.id}><td><strong dir="ltr">{o.number}</strong> <span className="muted">{o.customer}</span></td><td className="muted">{state(o)}</td><td className="num">{fmtUsd(o.due_cents)}</td></tr>)}</tbody></table>
      </>}
      <h4 style={{ margin: '14px 0 4px' }}>{pt('drvDeliveries', locale)} ({done.length})</h4>
      <table className="table"><tbody>
        <tr><th /><th style={{ textAlign: 'start' }}>{pt('when', locale)}</th><th style={{ textAlign: 'start' }}>{pt('orderNo', locale)}</th><th>{pt('total', locale)}</th><th style={{ textAlign: 'start' }} /><th>{pt('driverPay', locale)}</th><th /></tr>
        {done.map(o => { const owed = !o.paid_at && o.pay_cents > 0; return <tr key={o.id}>
          <td>{owed && <input type="checkbox" checked={picked.has(o.id)} onChange={() => toggle(o.id)} />}</td>
          <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(o.at, locale)}</td>
          <td><strong dir="ltr">{o.number}</strong> <span className="muted">{o.customer}</span></td>
          <td className="num">{fmtUsd(o.total_cents)}</td>
          <td className={o.due_cents > 0 ? 'bad' : 'muted'} style={{ fontSize: 12 }}>{state(o)}</td>
          <td className="num"><strong>{fmtUsd(o.pay_cents)}</strong>{!o.paid_at && <button className="link-btn" style={{ marginInlineStart: 6 }} title={pt('edit', locale)} onClick={() => setEdit(o)}>✎</button>}</td>
          <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{o.paid_at ? <span className="ok">✓ {pt('settled', locale)} {fmtTime(o.paid_at, locale)}</span> : o.pay_cents > 0 ? <span className="bad">{pt('notSettled', locale)}</span> : <span className="muted">—</span>}</td>
        </tr>; })}
        {!done.length && <tr><td className="muted" colSpan={7}>—</td></tr>}
      </tbody></table>
      {payouts.length > 0 && <>
        <h4 style={{ margin: '14px 0 4px' }}>{pt('pastPayouts', locale)}</h4>
        <table className="table"><tbody>{payouts.map(p => <tr key={p.id}><td className="muted">{fmtTime(p.at, locale)}</td><td>{p.orders_count} {pt('drvDeliveries', locale)}</td><td className="muted">{pt(p.from_drawer ? 'settleFromDrawer' : 'settleOutside', locale)}{p.note ? ` · ${p.note}` : ''}</td><td className="num"><strong>{fmtUsd(p.amount_cents)}</strong>{p.currency === 'lbp' && <div className="muted" style={{ fontSize: 12 }}>{fmtLbp(p.amount, locale)}</div>}</td></tr>)}</tbody></table>
      </>}
      {settle && <SettleDialog boot={boot} locale={locale} staff={staff} d={d} orders={chosen} cents={chosenCents} holding={d.holding_cents} rate={rate} onClose={() => setSettle(false)}
        onDone={(ids, at, payout) => { setSettle(false); setPicked(new Set()); onChanged(r => ({ ...r, payouts: [payout, ...r.payouts],
          orders: r.orders.map(o => (ids.includes(o.id) ? { ...o, paid_at: at, payout_id: payout.id } : o)),
          drivers: r.drivers.map(x => (x.id === d.id ? { ...x, owed_cents: Math.max(0, x.owed_cents - payout.amount_cents), owed_count: Math.max(0, x.owed_count - ids.length) } : x)) })); }} />}
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

function SettleDialog({ boot, locale, staff, d, orders, cents, holding, rate, onClose, onDone }: { boot: Booted; locale: L; staff: Staff; d: Drv; orders: DrvOrder[]; cents: number; holding: number; rate: number; onClose: () => void; onDone: (ids: string[], at: string, payout: Payout) => void }) {
  const [shift, setShift] = useState<Shift | null>(null); const [drawer, setDrawer] = useState(false); const [cur, setCur] = useState<Currency>('usd'); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { currentShift(boot.db).then(s => { setShift(s); setDrawer(!!s); }); }, [boot]);
  const step = boot.shop.lbp_rounding_step ?? 5000;
  const amount = cur === 'lbp' ? roundLbp(usdToLbp(cents, rate), step) : cents;
  const net = holding - cents;
  const go = async () => {
    if (busy) return; setBusy(true); setErr(null);
    try {
      const r = await payDriver(boot.db, { driver: { id: d.id, name: d.name }, orders: orders.map(o => ({ id: o.id, courier_fee_cents: o.pay_cents })), currency: cur, amount, rate, from_drawer: drawer, shift, note: note.trim() || null, user_id: staff.user_id, label: `${pt('driverPay', locale)} · ${d.name} · ${orders.length}` });
      boot.engine.poke();
      const at = new Date().toISOString();
      onDone(orders.map(o => o.id), at, { id: r?.id ?? at, driver_id: d.id, orders_count: orders.length, amount_cents: cents, currency: cur, amount, from_drawer: drawer && !!shift, collected_cents: orders.reduce((s, o) => s + o.total_cents, 0), note: note.trim() || null, at });
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`💵 ${pt('settleTitle', locale)} · ${d.name}`}
      footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary big" style={{ width: 'auto', minWidth: 200 }} disabled={busy || !orders.length} onClick={go}>{pt('settle', locale)} · {cur === 'lbp' ? fmtLbp(amount, locale) : fmtUsd(amount)}</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{pt('settleHint', locale)}</p>
        <div className="row spread"><span>{pt('drvDeliveries', locale)}</span><strong>{orders.length}</strong></div>
        <div className="row spread"><span>{pt('driverPay', locale)}</span><strong dir="ltr">{fmtUsd(cents)} <small className="muted">≈ {fmtLbp(roundLbp(usdToLbp(cents, rate), step), locale)}</small></strong></div>
        {holding > 0 && <div className="row spread" style={{ padding: '8px 10px', background: '#fff8e6', borderRadius: 10 }}><span>{pt('drvHolding', locale)} {fmtUsd(holding)} − {pt('driverPay', locale)} {fmtUsd(cents)}</span><strong>{pt(net >= 0 ? 'drvNet' : 'drvNetWeOwe', locale)} {fmtUsd(Math.abs(net))}</strong></div>}
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="seg"><button className={drawer ? 'active' : ''} disabled={!shift} onClick={() => setDrawer(true)}>{pt('settleFromDrawer', locale)}</button><button className={!drawer ? 'active' : ''} onClick={() => setDrawer(false)}>{pt('settleOutside', locale)}</button></div>
          <div className="seg"><button className={cur === 'usd' ? 'active' : ''} onClick={() => setCur('usd')}>$</button><button className={cur === 'lbp' ? 'active' : ''} onClick={() => setCur('lbp')}>ل.ل.</button></div>
        </div>
        {!shift && <small className="muted">{pt('settleNoShift', locale)}</small>}
        <input className="input" placeholder={pt('note', locale)} value={note} maxLength={200} onChange={e => setNote(e.target.value)} />
        {err && <div className="bad">{err}</div>}
      </div>
    </Modal>
  );
}
