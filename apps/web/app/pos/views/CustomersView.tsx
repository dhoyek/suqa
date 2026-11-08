'use client';
import { useEffect, useMemo, useState } from 'react';
import { coordsFrom, debtLines, fmtPhone, fmtUsd, mapUrlFor, normPhone, num, searchCustomers, upsertCustomer, type CustomerAddress, type Order, type ShopCustomer, type SyncStatus } from '@suqa/pos-core';
import { pt, type L, type Key } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import MapPicker from '../components/MapPicker';

/** الزبائن — everyone who ever ordered: search, edit (name / address / pin / notes), balance, order history, WhatsApp, new order. */
export default function CustomersView({ boot, locale, tick, status, onNewOrder }: { boot: Booted; locale: L; tick: number; status: SyncStatus | null; onNewOrder: (c: { phone: string; name: string }) => void }) {
  const online = status?.online ?? true;
  const [q, setQ] = useState(''); const [list, setList] = useState<ShopCustomer[]>([]); const [all, setAll] = useState<ShopCustomer[]>([]);
  const [sel, setSel] = useState<ShopCustomer | null>(null); const [debt, setDebt] = useState<Map<string, number>>(new Map());
  useEffect(() => { boot.db.shopCustomers.toArray().then(cs => setAll(cs.sort((a, b) => (b.last_order_at ?? '').localeCompare(a.last_order_at ?? '')))); debtLines(boot.db, { openOnly: true }).then(ls => { const m = new Map<string, number>(); for (const l of ls) m.set(l.phone, (m.get(l.phone) ?? 0) + l.outstanding_cents); setDebt(m); }); }, [boot, tick]);
  useEffect(() => { if (!q.trim()) { setList(all); return; } searchCustomers(boot.db, q, 50).then(setList); }, [q, all, boot]);
  useEffect(() => { if (sel) { const fresh = all.find(c => c.id === sel.id); if (fresh && fresh !== sel) setSel(fresh); } }, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalDebt = useMemo(() => [...debt.values()].reduce((a, b) => a + b, 0), [debt]);
  return (
    <div className="cust-page">
      <section className="cust-side">
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input className="input" placeholder={pt('searchPerson', locale)} value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1 }} autoFocus />
          <button className="btn primary" onClick={() => setSel({ id: '', shop_id: boot.shop.id, phone: '', phone_key: '', name: '', address: {}, orders_count: 0 })}>＋ {pt('newCustomer', locale)}</button>
        </div>
        <div className="muted" style={{ fontSize: 12, margin: '6px 2px' }}>{all.length} {pt('customersNav', locale)} · {pt('totalOutstanding', locale)} {fmtUsd(totalDebt)}</div>
        {!all.length && <p className="muted">{pt('noCustomers', locale)}</p>}
        <div className="cust-rows">
          {list.map(c => <button key={c.id} className={`cust-row ${sel?.id === c.id ? 'active' : ''}`} onClick={() => setSel(c)}>
            <div><strong>{c.name || '—'}</strong><div className="muted" dir="ltr" style={{ fontSize: 12 }}>{fmtPhone(c.phone)}</div></div>
            <div style={{ textAlign: 'end' }}><div className="muted" style={{ fontSize: 12 }}>{c.orders_count} {pt('ordersNav', locale)}</div>{debt.get(c.phone_key) ? <strong className="bad">{fmtUsd(debt.get(c.phone_key)!)}</strong> : <span className="muted" style={{ fontSize: 12 }}>{c.last_order_at ? fmtTime(c.last_order_at, locale) : ''}</span>}</div>
          </button>)}
        </div>
      </section>
      <section className="cust-main">
        {sel ? <CustomerCard key={sel.id || 'new'} boot={boot} locale={locale} c={sel} online={online} debtCents={debt.get(sel.phone_key) ?? 0} onSaved={c => setSel(c)} onNewOrder={() => onNewOrder({ phone: sel.phone, name: sel.name })} />
          : <p className="muted" style={{ padding: 16 }}>{pt('customersNav', locale)}</p>}
      </section>
    </div>
  );
}

function CustomerCard({ boot, locale, c, online, debtCents, onSaved, onNewOrder }: { boot: Booted; locale: L; c: ShopCustomer; online: boolean; debtCents: number; onSaved: (c: ShopCustomer) => void; onNewOrder: () => void }) {
  const [phone, setPhone] = useState(c.phone); const [name, setName] = useState(c.name); const [line1, setLine1] = useState(c.address?.line1 ?? ''); const [map, setMap] = useState(c.address?.map_url ?? '');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(c.address?.lat != null && c.address?.lng != null ? { lat: c.address.lat, lng: c.address.lng } : null);
  const [notes, setNotes] = useState(c.notes ?? ''); const [pickMap, setPickMap] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [asking, setAsking] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  useEffect(() => { if (!c.phone_key) return; boot.db.orders.toArray().then(os => setOrders(os.filter(o => !o.parked && normPhone(o.customer_phone) === c.phone_key).sort((a, b) => b.placed_at.localeCompare(a.placed_at)).slice(0, 30))); }, [boot, c.phone_key]);
  const dirty = phone !== c.phone || name !== c.name || line1 !== (c.address?.line1 ?? '') || map !== (c.address?.map_url ?? '') || notes !== (c.notes ?? '') || JSON.stringify(coords) !== JSON.stringify(c.address?.lat != null ? { lat: c.address.lat, lng: c.address.lng } : null);
  const save = async () => {
    const address: CustomerAddress = { ...(line1.trim() ? { line1: line1.trim() } : {}), ...(map.trim() ? { map_url: map.trim() } : {}), ...(coords ? { lat: coords.lat, lng: coords.lng } : {}) };
    try { const row = await upsertCustomer(boot.db, boot.shop.id, { phone, name, address, notes: notes.trim() || null }); boot.engine.poke(); setMsg(pt('saved', locale)); onSaved(row); }
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
        </div>
        <div className="stack">
          <label className="label">{pt('address', locale)}</label><input className="input" value={line1} placeholder={pt('addressHint', locale)} onChange={e => setLine1(e.target.value)} />
          <label className="label">{pt('mapPin', locale)}</label>
          <div className="row" style={{ gap: 6 }}><input className="input" dir="ltr" value={map} onChange={e => { setMap(e.target.value); const p = coordsFrom(e.target.value); if (p) setCoords(p); }} style={{ flex: 1 }} /><button className="btn" onClick={() => setPickMap(true)}>🗺 {pt('pickOnMap', locale)}</button></div>
          {coords && <small className="muted" dir="ltr">📍 {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)} · <a href={mapUrlFor(coords.lat, coords.lng)} target="_blank" rel="noreferrer">{pt('openMap', locale)}</a></small>}
          <div className="row" style={{ gap: 8, alignItems: 'center' }}><button className="btn ghost" disabled={!online || normPhone(phone).length < 6 || asking === '…'} onClick={askLocation}>💬 {pt('askLocation', locale)}</button>{asking && asking !== '…' && <small className="muted">{asking}</small>}</div>
        </div>
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}><button className="btn primary" disabled={!dirty || normPhone(phone).length < 6} onClick={save}>{pt('save', locale)}</button>{msg && <span className="muted">{msg}</span>}</div>
      {!!orders.length && <div className="card">
        <strong>{pt('history', locale)}</strong>
        <table className="table" style={{ marginTop: 6 }}><tbody>
          {orders.map(o => <tr key={o.id}><td className="muted">{fmtTime(o.placed_at, locale)}</td><td>{o.number ?? o.local_number}</td><td className="muted">{pt(o.channel as Key, locale)}</td><td><span className={`pill st-${o.status}`}>{pt(`st_${o.status}` as Key, locale)}</span></td><td className="num">{fmtUsd(num(o.total_cents))}</td></tr>)}
        </tbody></table>
      </div>}
      {pickMap && <MapPicker locale={locale} initial={coords} onDone={p => { setCoords(p); setMap(mapUrlFor(p.lat, p.lng)); setPickMap(false); }} onClose={() => setPickMap(false)} />}
    </div>
  );
}
