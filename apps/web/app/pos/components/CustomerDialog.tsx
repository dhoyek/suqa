'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { coordsFrom, fmtPhone, fmtUsd, lastOrderOf, mapUrlFor, normPhone, num, openOrdersOf, searchCustomers, text, upsertCustomer, type CustomerAddress, type Draft, type OrderLine, type ShopCustomer } from '@suqa/pos-core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import Modal from './Modal';
import MapPicker from './MapPicker';

export type CustomerResult = { patch: Partial<Draft>; feeCents: number; repeat?: OrderLine[] };

/** Who is this sale/order for. Picks from the shop's customers (name or number), fills name / address / map pin, and saves edits back to the customer. */
export default function CustomerDialog({ boot, sb, locale, draft, fee, online, onDone, onClose }: { boot: Booted; sb: SupabaseClient; locale: L; draft: Draft; fee: number; online: boolean; onDone: (r: CustomerResult) => void; onClose: () => void }) {
  const [channel, setChannel] = useState<Draft['channel']>(draft.channel);
  const [phone, setPhone] = useState(draft.customer_phone ?? ''); const [name, setName] = useState(draft.customer_name ?? '');
  const [ful, setFul] = useState<'pickup' | 'delivery'>(draft.fulfillment ?? 'pickup');
  const a0 = (draft.address ?? {}) as CustomerAddress;
  const [line1, setLine1] = useState(a0.line1 ?? ''); const [map, setMap] = useState(a0.map_url ?? ''); const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(a0.lat != null && a0.lng != null ? { lat: a0.lat, lng: a0.lng } : null);
  const [notes, setNotes] = useState(draft.notes ?? ''); const [when, setWhen] = useState('');
  const defFee = Math.round(num(boot.shop.default_delivery_fee_usd) * 100);
  const [f, setF] = useState(fee ? (fee / 100).toString() : defFee ? (defFee / 100).toString() : '');
  const [matches, setMatches] = useState<ShopCustomer[]>([]); const [picked, setPicked] = useState<ShopCustomer | null>(null); const [showList, setShowList] = useState(false);
  const [openOrders, setOpenOrders] = useState(0); const [last, setLast] = useState<Awaited<ReturnType<typeof lastOrderOf>>>(null); const [pickMap, setPickMap] = useState(false);
  const phoneRef = useRef<HTMLInputElement>(null);
  const [zone, setZone] = useState<{ name?: Record<string, string>; fee_usd?: number; eta_minutes?: number | null; zone_id: string | null } | null>(null);
  const [asking, setAsking] = useState<string | null>(null); const [picker, setPicker] = useState(false);
  // delivery-zone fee from the pin (online only; outside the zones → keep the default/typed fee)
  useEffect(() => {
    if (!coords || !online || ful !== 'delivery') { setZone(null); return; }
    let on = true;
    sb.rpc('pos_delivery_fee', { p_shop: boot.shop.id, p_lat: coords.lat, p_lng: coords.lng }).then(({ data }) => {
      if (!on) return; const z = data as typeof zone; setZone(z);
      if (z?.zone_id && z.fee_usd != null && !feeTouched.current) setF(String(Number(z.fee_usd)));
    });
    return () => { on = false; };
  }, [coords, online, ful, sb, boot.shop.id]);
  const feeTouched = useRef(false);
  const askLocation = async () => {
    if (!online || key.length < 6) return; setAsking('…');
    try {
      const r = await fetch('/api/pos/ask-location', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shop_id: boot.shop.id, phone: phone.trim(), name: name.trim() }) });
      setAsking(r.ok ? pt('locationAsked', locale) : pt('sendFailed', locale));
    } catch { setAsking(pt('sendFailed', locale)); }
  };
  const isOrder = channel !== 'walkin';
  const key = normPhone(phone);

  // search as you type (number or name), recent customers when empty
  useEffect(() => { let on = true; searchCustomers(boot.db, phone || name, 8).then(m => { if (on) setMatches(m); }); return () => { on = false; }; }, [boot, phone, name]);
  useEffect(() => { if (key.length < 6) { setOpenOrders(0); setLast(null); return; } openOrdersOf(boot.db, key).then(o => setOpenOrders(o.filter(x => x.id !== draft.id).length)); lastOrderOf(boot.db, key).then(setLast); }, [boot, key, draft.id]);
  // exact number typed → auto-fill from the customer record
  useEffect(() => { if (picked && picked.phone_key === key) return; const c = matches.find(m => m.phone_key === key); if (c && key.length >= 7) pick(c, false); }, [key, matches]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (c: ShopCustomer, closeList = true, replace = false) => {
    setPicked(c); setPhone(c.phone); if (replace || !name || c.name) setName(c.name || (replace ? '' : name));
    const a = c.address ?? {};
    if (a.line1 && (replace || !line1)) setLine1(a.line1); if (a.map_url && (replace || !map)) setMap(a.map_url); if (a.lat != null && a.lng != null && (replace || !coords)) setCoords({ lat: a.lat, lng: a.lng });
    if (replace && isOrder && (a.line1 || a.lat != null)) setFul('delivery');
    if (closeList) setShowList(false); setPicker(false);
  };
  const onMapText = (v: string) => { setMap(v); const c = coordsFrom(v); if (c) setCoords(c); };
  const onPin = (p: { lat: number; lng: number }) => { setCoords(p); setMap(mapUrlFor(p.lat, p.lng)); setPickMap(false); };
  const address: CustomerAddress = useMemo(() => ({ ...(line1.trim() ? { line1: line1.trim() } : {}), ...(map.trim() ? { map_url: map.trim() } : {}), ...(coords ? { lat: coords.lat, lng: coords.lng } : {}) }), [line1, map, coords]);
  const ok = !isOrder || key.length >= 6;

  const submit = async (repeat?: OrderLine[]) => {
    if (!ok) return;
    const n = name.trim();
    if (key.length >= 6) {   // save the edits back to the customer record (name / address) — never clears a saved address with an empty one
      const changed = !picked || picked.name !== n || (ful === 'delivery' && JSON.stringify(picked.address ?? {}) !== JSON.stringify(address));
      if (changed) await upsertCustomer(boot.db, boot.shop.id, { phone: phone.trim(), name: n, ...(ful === 'delivery' && Object.keys(address).length ? { address } : {}) }).catch(() => undefined);
      boot.engine.poke();
    }
    const noteText = [when.trim() ? `⏰ ${when.trim()}` : '', notes.trim()].filter(Boolean).join(' · ') || null;
    onDone({ patch: { channel, customer_name: n, customer_phone: phone.trim(), discount_pct: picked?.discount_pct ? Number(picked.discount_pct) : null, fulfillment: isOrder ? ful : 'pickup', address: isOrder && ful === 'delivery' ? { ...address } as Record<string, unknown> : {}, notes: noteText },
      feeCents: isOrder && ful === 'delivery' ? Math.round((Number(f) || 0) * 100) : 0, repeat });
  };

  return (
    <>
      <Modal open onClose={onClose} title={pt('customer', locale)} wide
        footer={<><button className="btn ghost" onClick={() => onDone({ patch: { channel: 'walkin', customer_name: '', customer_phone: '', fulfillment: 'pickup', address: {}, notes: null }, feeCents: 0 })}>✕ {pt('walkin', locale)}</button>
          {last && isOrder && <button className="btn" onClick={() => submit(last.lines)}>🔁 {pt('repeatLast', locale)} ({last.lines.length})</button>}
          <span style={{ flex: 1 }} /><button className="btn primary" disabled={!ok} onClick={() => submit()}>{pt('ok', locale)}</button></>}>
        <div className="cust-grid">
          <div className="stack">
            <label className="label">{pt('channelLabel', locale)}</label>
            <div className="seg">{(['walkin', 'whatsapp', 'phone'] as Draft['channel'][]).map(c => <button key={c} className={channel === c ? 'active' : ''} onClick={() => setChannel(c)}>{pt(c as 'walkin', locale)}</button>)}</div>

            <label className="label">{pt('customerPhone', locale)}{isOrder ? ' *' : ''}</label>
            <div className="row" style={{ gap: 6 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <input ref={phoneRef} className="input" inputMode="tel" dir="ltr" value={phone} autoFocus={typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches} placeholder="70 123 456" onChange={e => { setPhone(e.target.value); setPicked(null); setShowList(true); }} onFocus={() => setShowList(true)} onBlur={() => setTimeout(() => setShowList(false), 150)} />
              {showList && matches.length > 0 && (
                <div className="cust-list">
                  {matches.map(c => <button key={c.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => pick(c)}>
                    <strong>{c.name || '—'}</strong><span dir="ltr" className="muted">{fmtPhone(c.phone)}</span>{c.address?.line1 && <small className="muted">📍 {c.address.line1}</small>}
                  </button>)}
                </div>
              )}
            </div>
            <button className="btn" type="button" onClick={() => setPicker(true)} title={pt('pickCustomer', locale)}>👥 {pt('pickCustomer', locale)}</button>
            </div>
            {!phone && !name && matches.length > 0 && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{matches.slice(0, 5).map(c => <button key={c.id} className="chip" onClick={() => pick(c)}>{c.name || fmtPhone(c.phone)}</button>)}</div>}
            {openOrders > 0 && <p className="pill warn" style={{ margin: 0 }}>⚠ {pt('hasOpenOrder', locale).replace('{n}', String(openOrders))}</p>}

            <label className="label">{pt('customerName', locale)}</label>
            <input className="input" value={name} onChange={e => { setName(e.target.value); if (!phone) setShowList(true); }} />
            {!picked && key.length >= 6 && <small className="muted">🆕 {pt('newCustomerWillSave', locale)}</small>}
            {picked && <small className="muted">{picked.discount_pct && Number(picked.discount_pct) ? `${pt('discount', locale)} ${Number(picked.discount_pct)}% · ` : ''}{pt('ordersCount', locale)}: {picked.orders_count}{last ? ` · ${pt('lastOrder', locale)} ${fmtUsd(num(last.order.total_cents))}` : ''}</small>}

            {isOrder && <>
              <label className="label">{pt('fulfillment', locale)}</label>
              <div className="seg"><button className={ful === 'pickup' ? 'active' : ''} onClick={() => setFul('pickup')}>🛍 {pt('pickupBadge', locale)}</button><button className={ful === 'delivery' ? 'active' : ''} onClick={() => setFul('delivery')}>🛵 {pt('deliveryBadge', locale)}</button></div>
            </>}
          </div>

          <div className="stack">
            {isOrder && ful === 'delivery' && <>
              <label className="label">{pt('address', locale)}</label>
              <input className="input" value={line1} placeholder={pt('addressHint', locale)} onChange={e => setLine1(e.target.value)} />
              <label className="label">{pt('mapPin', locale)}</label>
              <div className="row" style={{ gap: 6 }}>
                <input className="input" dir="ltr" placeholder="https://maps.google.com/?q=…" value={map} onChange={e => onMapText(e.target.value)} style={{ flex: 1 }} />
                <button className="btn" onClick={() => setPickMap(true)}>🗺 {pt('pickOnMap', locale)}</button>
              </div>
              {channel === 'whatsapp' && <div className="row" style={{ gap: 8, alignItems: 'center' }}><button className="btn ghost" disabled={!online || key.length < 6 || asking === '…'} onClick={askLocation}>💬 {pt('askLocation', locale)}</button>{asking && asking !== '…' && <small className="muted">{asking}</small>}</div>}
              {coords && <small className="muted" dir="ltr">📍 {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)} · <a href={mapUrlFor(coords.lat, coords.lng)} target="_blank" rel="noreferrer">{pt('openMap', locale)}</a></small>}
              <label className="label">{pt('deliveryFee', locale)} ($)</label>
              <input className="input" dir="ltr" inputMode="decimal" value={f} onChange={e => { feeTouched.current = true; setF(e.target.value); }} />
              {zone && (zone.zone_id ? <small className="muted">🗺 {text(zone.name ?? {}, locale)} · ${Number(zone.fee_usd ?? 0)}{zone.eta_minutes ? ` · ~${zone.eta_minutes} ${pt('min', locale)}` : ''}</small> : <small className="pill warn">{pt('outsideZones', locale)}</small>)}
            </>}
            {isOrder && <>
              <label className="label">{pt('orderNotes', locale)}</label>
              <input className="input" value={notes} placeholder={pt('orderNotesHint', locale)} onChange={e => setNotes(e.target.value)} />
              <label className="label">{pt('neededAt', locale)}</label>
              <input className="input" value={when} placeholder={pt('neededAtHint', locale)} onChange={e => setWhen(e.target.value)} />
            </>}
            {last && isOrder && <div className="card" style={{ background: '#fafafa', fontSize: 13 }}>
              <strong>{pt('lastOrder', locale)}</strong> <span className="muted">{last.order.number ?? last.order.local_number}</span>
              <div className="muted">{last.lines.map(l => `${num(l.quantity)}${l.unit ? ' ' + l.unit : '×'} ${text(l.name, locale)}`).join(' · ')}</div>
            </div>}
          </div>
        </div>
      </Modal>
      {pickMap && <MapPicker locale={locale} initial={coords} onDone={onPin} onClose={() => setPickMap(false)} />}
      {picker && <CustomerPicker boot={boot} locale={locale} onPick={c => pick(c, true, true)} onNew={() => { setPicker(false); setPhone(''); setName(''); setPicked(null); setTimeout(() => phoneRef.current?.focus(), 50); }} onClose={() => setPicker(false)} />}
    </>
  );
}

/** Full-screen customer list (search by name or number) — the explicit way to choose on a phone, where the dropdown is easy to miss. */
function CustomerPicker({ boot, locale, onPick, onNew, onClose }: { boot: Booted; locale: L; onPick: (c: ShopCustomer) => void; onNew: () => void; onClose: () => void }) {
  const [q, setQ] = useState(''); const [rows, setRows] = useState<ShopCustomer[]>([]);
  useEffect(() => { let on = true; (q.trim() ? searchCustomers(boot.db, q, 40) : boot.db.shopCustomers.toArray().then(cs => cs.sort((a, b) => (b.last_order_at ?? '').localeCompare(a.last_order_at ?? '')).slice(0, 40))).then(r => { if (on) setRows(r); }); return () => { on = false; }; }, [boot, q]);
  return (
    <Modal open onClose={onClose} title={pt('pickCustomer', locale)} footer={<><button className="btn" onClick={onNew}>＋ {pt('newCustomer', locale)}</button><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button></>}>
      <input className="input" autoFocus placeholder={pt('searchPerson', locale)} value={q} onChange={e => setQ(e.target.value)} />
      <div className="cust-rows" style={{ marginTop: 8, maxHeight: '55dvh', overflow: 'auto' }}>
        {rows.map(c => <button key={c.id} className="cust-row" onClick={() => onPick(c)}>
          <div><strong>{c.name || '—'}</strong><div className="muted" dir="ltr" style={{ fontSize: 12 }}>{fmtPhone(c.phone)}</div>{c.address?.line1 && <small className="muted">📍 {c.address.line1}</small>}</div>
          <div className="muted" style={{ fontSize: 12, textAlign: 'end' }}>{c.orders_count} {pt('ordersNav', locale)}</div>
        </button>)}
        {!rows.length && <p className="muted">{pt('noCustomers', locale)}</p>}
      </div>
    </Modal>
  );
}
