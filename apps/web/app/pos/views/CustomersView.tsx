'use client';
import { useEffect, useMemo, useState } from 'react';
import { coordsFrom, customerHasHistory, debtLines, groupByPerson, fmtLbp, waDigits, text, type DebtLine, type DebtPerson, type Rate, deleteCustomer, fmtPhone, fmtUsd, mapUrlFor, mergeCustomers, normPhone, num, searchCustomers, upsertCustomer, type CustomerAddress, type Order, type ShopCustomer, type Staff, type SyncStatus } from '@suqa/pos-core';
import { pt, type L, type Key } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import MapPicker from '../components/MapPicker';
import Modal from '../components/Modal';
import { useConfirm } from '@/components/ConfirmProvider';
import OrderDetail from '../components/OrderDetail';
import { useOrderItems } from '../lib/useOrderItems';
import { CollectDialog, statementText } from './DebtsView';
import { debtReceiptHtml, debtStatementHtml, doPrint, loadPrintSettings } from '../lib/print';

/** الزبائن — everyone who ever ordered: search, edit (name / address / pin / notes), balance, order history, WhatsApp, new order. */
export default function CustomersView({ boot, locale, tick, status, staff, onNewOrder, focus }: { boot: Booted; locale: L; tick: number; status: SyncStatus | null; staff: Staff; onNewOrder: (c: { phone: string; name: string }) => void; focus?: { phone: string; name: string; n: number } | null }) {
  const online = status?.online ?? true;
  const [q, setQ] = useState(''); const [list, setList] = useState<ShopCustomer[]>([]); const [all, setAll] = useState<ShopCustomer[]>([]);
  const [sel, setSel] = useState<ShopCustomer | null>(null); const [debt, setDebt] = useState<Map<string, number>>(new Map()); const [showInactive, setShowInactive] = useState(false); const [reload, setReload] = useState(0);
  useEffect(() => { boot.db.shopCustomers.toArray().then(cs => setAll(cs.sort((a, b) => (b.last_order_at ?? '').localeCompare(a.last_order_at ?? '')))); debtLines(boot.db, { openOnly: true }).then(ls => { const m = new Map<string, number>(); for (const l of ls) m.set(l.phone, (m.get(l.phone) ?? 0) + l.outstanding_cents); setDebt(m); }); }, [boot, tick, reload]);
  useEffect(() => { const vis = showInactive ? all : all.filter(c => c.active !== false); if (!q.trim()) { setList(vis); return; } const digits = normPhone(q), text = q.trim().toLowerCase(); setList(vis.filter(c => (digits && c.phone_key.includes(digits)) || (text && c.name.toLowerCase().includes(text)))); }, [q, all, boot, showInactive]);
  useEffect(() => { if (sel) { const fresh = all.find(c => c.id === sel.id); if (fresh && fresh !== sel) setSel(fresh); } }, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalDebt = useMemo(() => [...debt.values()].reduce((a, b) => a + b, 0), [debt]);
  // opened from another screen (debts, order detail): search for that person and select them when found
  useEffect(() => { if (!focus) return; setQ(focus.phone || focus.name); const k = normPhone(focus.phone); const c = all.find(x => (k && x.phone_key === k) || (!k && x.name === focus.name)); if (c) setSel(c); }, [focus, all]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="cust-page">
      <section className="cust-side">
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input className="input" placeholder={pt('searchPerson', locale)} value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1 }} autoFocus />
          <button className="btn primary" onClick={() => setSel({ id: '', shop_id: boot.shop.id, phone: '', phone_key: '', name: '', address: {}, orders_count: 0 })}>＋ {pt('newCustomer', locale)}</button>
        </div>
        <div className="muted row spread" style={{ fontSize: 12, margin: '6px 2px', alignItems: 'center' }}><span>{all.length} {pt('customersNav', locale)} · {pt('totalOutstanding', locale)} {fmtUsd(totalDebt)}</span>{all.some(c => c.active === false) && <label className="row" style={{ gap: 4, alignItems: 'center' }}><input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> {pt('showInactive', locale)}</label>}</div>
        {!all.length && <p className="muted">{pt('noCustomers', locale)}</p>}
        <div className="cust-rows">
          {list.map(c => <button key={c.id} className={`cust-row ${sel?.id === c.id ? 'active' : ''}`} onClick={() => setSel(c)}>
            <div><strong className={c.active === false ? 'muted' : ''}>{c.name || '—'}{c.active === false ? ` · ${pt('inactive', locale)}` : ''}</strong><div className="muted" dir="ltr" style={{ fontSize: 12 }}>{fmtPhone(c.phone)}</div></div>
            <div style={{ textAlign: 'end' }}><div className="muted" style={{ fontSize: 12 }}>{c.orders_count} {pt('ordersNav', locale)}</div>{debt.get(c.phone_key) ? <strong className="bad">{fmtUsd(debt.get(c.phone_key)!)}</strong> : <span className="muted" style={{ fontSize: 12 }}>{c.last_order_at ? fmtTime(c.last_order_at, locale) : ''}</span>}</div>
          </button>)}
        </div>
      </section>
      <section className="cust-main">
        {sel ? <CustomerCard key={sel.id || 'new'} boot={boot} locale={locale} c={sel} all={all} owner={staff.role === 'owner'} online={online} debtCents={debt.get(sel.phone_key) ?? 0} staff={staff} onDebtChanged={() => setReload(n => n + 1)} onSaved={c => setSel(c)} onGone={() => { setSel(null); setReload(n => n + 1); }} onNewOrder={() => onNewOrder({ phone: sel.phone, name: sel.name })} />
          : <p className="muted" style={{ padding: 16 }}>{pt('customersNav', locale)}</p>}
      </section>
    </div>
  );
}

function CustomerCard({ boot, locale, c, all, owner, online, debtCents, staff, onDebtChanged, onSaved, onGone, onNewOrder }: { boot: Booted; locale: L; c: ShopCustomer; all: ShopCustomer[]; owner: boolean; online: boolean; debtCents: number; staff: Staff; onDebtChanged: () => void; onSaved: (c: ShopCustomer) => void; onGone: () => void; onNewOrder: () => void }) {
  const confirm = useConfirm(); const [merge, setMerge] = useState(false); const [hasHistory, setHasHistory] = useState(true);
  useEffect(() => { if (c.id) customerHasHistory(boot.db, c).then(setHasHistory); }, [boot, c]);
  const [phone, setPhone] = useState(c.phone); const [name, setName] = useState(c.name); const [line1, setLine1] = useState(c.address?.line1 ?? ''); const [map, setMap] = useState(c.address?.map_url ?? '');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(c.address?.lat != null && c.address?.lng != null ? { lat: c.address.lat, lng: c.address.lng } : null);
  const [notes, setNotes] = useState(c.notes ?? ''); const [pickMap, setPickMap] = useState(false);
  const [limit, setLimit] = useState(c.credit_limit_cents != null ? String(c.credit_limit_cents / 100) : ''); const [disc, setDisc] = useState(String(Number(c.discount_pct) || '')); const [msg, setMsg] = useState<string | null>(null); const [asking, setAsking] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]); const [active, setActive] = useState(c.active !== false);
  const [detail, setDetail] = useState<Order | null>(null); const [showItems, setShowItems] = useState(true);
  const items = useOrderItems(boot.db, orders.map(o => o.id), locale, showItems);
  // this customer's debt lines (open and settled): what is still owed per order, and the person to collect from
  const [dl, setDl] = useState<DebtLine[]>([]); const [rate, setRate] = useState(89500); const [collect, setCollect] = useState(false); const [collected, setCollected] = useState<Parameters<Parameters<typeof CollectDialog>[0]['onDone']>[0] | null>(null);
  const step = boot.shop.lbp_rounding_step ?? 5000;
  useEffect(() => { if (!c.phone_key) { setDl([]); return; } debtLines(boot.db, { phones: [c.phone] }).then(ls => setDl(ls.map(l => ({ ...l, name: l.name || c.name })))); boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { if (r) setRate(r.lbp_per_usd); }); }, [boot, c.phone_key, c.phone, c.name, debtCents, collected]);
  const person: DebtPerson | null = useMemo(() => groupByPerson(dl.filter(l => !l.closed))[0] ?? null, [dl]);
  const owedOf = useMemo(() => new Map(dl.map(l => [l.order.id, l])), [dl]);
  useEffect(() => { if (!c.phone_key) return; boot.db.orders.toArray().then(os => setOrders(os.filter(o => !o.parked && normPhone(o.customer_phone) === c.phone_key).sort((a, b) => b.placed_at.localeCompare(a.placed_at)).slice(0, 30))); }, [boot, c.phone_key]);
  const dirty = active !== (c.active !== false) || limit !== (c.credit_limit_cents != null ? String(c.credit_limit_cents / 100) : '') || disc !== String(Number(c.discount_pct) || '') || phone !== c.phone || name !== c.name || line1 !== (c.address?.line1 ?? '') || map !== (c.address?.map_url ?? '') || notes !== (c.notes ?? '') || JSON.stringify(coords) !== JSON.stringify(c.address?.lat != null ? { lat: c.address.lat, lng: c.address.lng } : null);
  const save = async () => {
    const address: CustomerAddress = { ...(line1.trim() ? { line1: line1.trim() } : {}), ...(map.trim() ? { map_url: map.trim() } : {}), ...(coords ? { lat: coords.lat, lng: coords.lng } : {}) };
    try { const row = await upsertCustomer(boot.db, boot.shop.id, { phone, name, address, notes: notes.trim() || null, credit_limit_cents: limit.trim() === '' ? null : Math.round(Number(limit) * 100), discount_pct: Number(disc) || 0, active }); boot.engine.poke(); setMsg(pt('saved', locale)); onSaved(row); }
    catch (e) { setMsg((e as Error).message === 'bad_phone' ? pt('customerPhone', locale) + ' ?' : (e as Error).message); }
  };
  const askLocation = async () => {
    setAsking('…');
    try { const r = await fetch('/api/pos/ask-location', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shop_id: boot.shop.id, phone, name }) }); setAsking(r.ok ? pt('locationAsked', locale) : pt('sendFailed', locale)); }
    catch { setAsking(pt('sendFailed', locale)); }
  };
  const wa = normPhone(phone) ? `https://wa.me/961${normPhone(phone)}` : null;
  return (
    <div className="stack" style={{ padding: 12 }}>
      <div className="row spread" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{c.id ? (c.name || fmtPhone(c.phone)) : pt('newCustomer', locale)}</h3>
        <div className="row" style={{ gap: 6 }}>
          {wa && <a className="btn" href={wa} target="_blank" rel="noreferrer">💬 WhatsApp</a>}
          {person && <button className="btn" title={pt('printStatement', locale)} onClick={() => doPrint(debtStatementHtml(person.lines, boot.shop, locale, loadPrintSettings(), { person: { name: person.name, phone: person.phone }, rate, lbpStep: step }))}>🖨 {pt('statementBtn', locale)}</button>}
          {person && <button className="btn" title={pt('waStatement', locale)} onClick={() => window.open(`https://wa.me/${waDigits(person.phone)}?text=${encodeURIComponent(statementText(person, text(boot.shop.name, locale), locale, rate, step))}`, '_blank')}>💬 {pt('statementBtn', locale)}</button>}
          {person && person.outstanding_cents > 0 && <button className="btn primary" onClick={() => setCollect(true)}>💵 {pt('collect', locale)} {fmtUsd(person.outstanding_cents)}</button>}
          {c.id && <button className="btn primary" onClick={onNewOrder}>＋ {pt('newOrderFor', locale)}</button>}
        </div>
      </div>
      {c.id && <div className="kpis">
        <div className="kpi"><span>{pt('ordersCount', locale)}</span><strong>{c.orders_count}</strong><small>{c.last_order_at ? fmtTime(c.last_order_at, locale) : ''}</small></div>
        <div className="kpi"><span>{pt('balance', locale)}</span><strong className={debtCents ? 'bad' : ''}>{fmtUsd(debtCents)}</strong></div>
      </div>}
      <div className="cust-grid">
        <div className="stack">
          <label className="label">{pt('customerPhone', locale)}</label><input className="input" dir="ltr" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} />
          <label className="label">{pt('customerName', locale)}</label><input className="input" value={name} onChange={e => setName(e.target.value)} />
          <label className="label">{pt('customerNotes', locale)}</label><input className="input" value={notes} onChange={e => setNotes(e.target.value)} />
          <div className="row" style={{ gap: 8 }}>
            <div style={{ flex: 1 }}><label className="label">{pt('creditLimit', locale)}</label><input className="input" dir="ltr" inputMode="decimal" value={limit} onChange={e => setLimit(e.target.value)} placeholder="—" /></div>
            <div style={{ flex: 1 }}><label className="label">{pt('customerDiscount', locale)}</label><input className="input" dir="ltr" inputMode="decimal" value={disc} onChange={e => setDisc(e.target.value)} placeholder="0" /></div>
          </div>
        </div>
        <div className="stack">
          <label className="label">{pt('address', locale)}</label><input className="input" value={line1} placeholder={pt('addressHint', locale)} onChange={e => setLine1(e.target.value)} />
          <label className="label">{pt('mapPin', locale)}</label>
          <div className="row" style={{ gap: 6 }}><input className="input" dir="ltr" value={map} onChange={e => { setMap(e.target.value); const p = coordsFrom(e.target.value); if (p) setCoords(p); }} style={{ flex: 1 }} /><button className="btn" onClick={() => setPickMap(true)}>🗺 {pt('pickOnMap', locale)}</button></div>
          {coords && <small className="muted" dir="ltr">📍 {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)} · <a href={mapUrlFor(coords.lat, coords.lng)} target="_blank" rel="noreferrer">{pt('openMap', locale)}</a></small>}
          <div className="row" style={{ gap: 8, alignItems: 'center' }}><button className="btn ghost" disabled={!online || normPhone(phone).length < 6 || asking === '…'} onClick={askLocation}>💬 {pt('askLocation', locale)}</button>{asking && asking !== '…' && <small className="muted">{asking}</small>}</div>
        </div>
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={!dirty || normPhone(phone).length < 6} onClick={save}>{pt('save', locale)}</button>{msg && <span className="muted">{msg}</span>}
        {c.id && <label className="row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> {pt('active', locale)}</label>}
        <span style={{ flex: 1 }} />
        {c.id && owner && <button className="btn" onClick={() => setMerge(true)}>⇄ {pt('mergeCustomer', locale)}</button>}
        {c.id && owner && <button className="btn danger" disabled={hasHistory} title={hasHistory ? pt('hasHistoryHint', locale) : ''} onClick={async () => { if (!(await confirm(`${pt('deleteCustomer', locale)}: ${c.name || fmtPhone(c.phone)}?`, { danger: true }))) return; try { await deleteCustomer(boot.db, c); boot.engine.poke(); onGone(); } catch (e) { setMsg((e as Error).message === 'has_history' ? pt('hasHistoryHint', locale) : (e as Error).message); } }}>🗑 {pt('deleteCustomer', locale)}</button>}
      </div>
      {c.id && owner && hasHistory && <small className="muted">{pt('hasHistoryHint', locale)}</small>}
      {!!orders.length && <div className="card">
        <div className="row spread" style={{ alignItems: 'center' }}><strong>{pt('history', locale)} <span className="muted">{orders.length}</span></strong><button className={`chip ${showItems ? 'active' : ''}`} onClick={() => setShowItems(v => !v)}>📋 {pt('showItems', locale)}</button></div>
        <table className="table" style={{ marginTop: 6 }}><tbody>
          {orders.map(o => <tr key={o.id}><td className="muted" style={{ verticalAlign: 'top' }}>{fmtTime(o.placed_at, locale)}</td><td><button className="link-btn" title={pt('orderDetails', locale)} onClick={() => setDetail(o)}>{o.number ?? o.local_number} ↗</button>{showItems && items.get(o.id) && <div className="order-items-line">{items.get(o.id)}</div>}</td><td className="muted" style={{ verticalAlign: 'top' }}>{pt(o.channel as Key, locale)}</td><td style={{ verticalAlign: 'top' }}><span className={`pill st-${o.status}`}>{pt(`st_${o.status}` as Key, locale)}</span>{owedOf.get(o.id) && (owedOf.get(o.id)!.closed ? <span className="pill ok" style={{ marginInlineStart: 4 }}>✓ {pt('debtPaidPill', locale)}</span> : <span className="pill bad" style={{ marginInlineStart: 4 }}>{pt('debtShort', locale)} {fmtUsd(owedOf.get(o.id)!.outstanding_cents)}</span>)}</td><td className="num" style={{ verticalAlign: 'top' }}>{fmtUsd(num(o.total_cents))}</td></tr>)}
        </tbody></table>
      </div>}
      {detail && <OrderDetail boot={boot} locale={locale} order={detail} onClose={() => setDetail(null)} />}
      {collect && person && <CollectDialog boot={boot} locale={locale} person={person} rate={rate} step={step} staff={staff} onClose={() => setCollect(false)} onDone={d => { setCollect(false); setCollected(d); onDebtChanged(); }} />}
      {collected && <Modal open onClose={() => setCollected(null)} title={pt('collected', locale)} footer={<><button className="btn" onClick={() => doPrint(debtReceiptHtml(collected.s, collected.allocs, collected.remaining, boot.shop, locale, loadPrintSettings()))}>🖨 {pt('printReceipt', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" onClick={() => setCollected(null)}>{pt('ok', locale)}</button></>}>
        <div className="row spread"><strong>{collected.s.name}</strong><strong>{collected.s.currency === 'lbp' ? fmtLbp(num(collected.s.amount), locale) : fmtUsd(num(collected.s.amount))}</strong></div>
        <div className="row spread"><span>{pt('outstanding', locale)}</span><strong>{fmtUsd(Math.max(0, collected.remaining))}</strong></div>
      </Modal>}
      {pickMap && <MapPicker locale={locale} initial={coords} onDone={p => { setCoords(p); setMap(mapUrlFor(p.lat, p.lng)); setPickMap(false); }} onClose={() => setPickMap(false)} />}
      {merge && <MergeDialog locale={locale} keep={c} candidates={all.filter(x => x.id !== c.id)} label={x => `${x.name || '—'} · ${fmtPhone(x.phone)} · ${x.orders_count} ${pt('ordersNav', locale)}`} onClose={() => setMerge(false)}
        onPick={async drop => { if (!(await confirm(pt('mergeConfirm', locale).replace('{drop}', drop.name || fmtPhone(drop.phone)).replace('{keep}', c.name || fmtPhone(c.phone)), { danger: true }))) return; await mergeCustomers(boot.db, c, drop); boot.engine.poke(); setMerge(false); onGone(); }} />}
    </div>
  );
}

/** Pick the duplicate to fold into the kept record. */
export function MergeDialog<T extends { id: string }>({ locale, keep, candidates, label, onPick, onClose }: { locale: L; keep: T; candidates: T[]; label: (x: T) => string; onPick: (drop: T) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const rows = candidates.filter(x => !q.trim() || label(x).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 60);
  return (
    <Modal open onClose={onClose} title={pt('mergeInto', locale).replace('{keep}', label(keep))} footer={<><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button></>}>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{pt('mergeHint', locale)}</p>
      <input className="input" autoFocus placeholder={pt('searchPerson', locale)} value={q} onChange={e => setQ(e.target.value)} />
      <div className="cust-rows" style={{ marginTop: 8, maxHeight: '50dvh', overflow: 'auto' }}>
        {rows.map(x => <button key={x.id} className="cust-row" onClick={() => onPick(x)}><div>{label(x)}</div><div>⇄</div></button>)}
        {!rows.length && <p className="muted">—</p>}
      </div>
    </Modal>
  );
}
