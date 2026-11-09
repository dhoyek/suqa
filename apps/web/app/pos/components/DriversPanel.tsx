'use client';
import { useEffect, useState } from 'react';
import { fmtPhone, upsertDriver, waDigits, type Driver } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';

/** الإعدادات → السائقون: the shop's contracted drivers, availability toggle, call / WhatsApp. */
export default function DriversPanel({ boot, locale, tick }: { boot: Booted; locale: L; tick: number }) {
  const [rows, setRows] = useState<Driver[]>([]); const [edit, setEdit] = useState<Partial<Driver> | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const load = () => boot.db.drivers.toArray().then(r => setRows(r.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))));
  useEffect(() => { load(); }, [boot, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (patch: Partial<Driver> & { name: string; phone: string }) => {
    try { await upsertDriver(boot.db, boot.shop.id, patch); boot.engine.poke(); setEdit(null); setMsg(pt('saved', locale)); await load(); }
    catch (e) { setMsg((e as Error).message === 'bad_phone' ? pt('customerPhone', locale) + ' ?' : (e as Error).message); }
  };
  return (
    <section className="card">
      <div className="row spread" style={{ alignItems: 'center' }}><h3 style={{ margin: 0 }}>🛵 {pt('drivers', locale)}</h3><button className="btn primary" onClick={() => setEdit({ name: '', phone: '', vehicle: '' })}>＋ {pt('newDriver', locale)}</button></div>
      <p className="muted" style={{ fontSize: 13 }}>{pt('driversHint', locale)}</p>
      {rows.length ? <table className="table"><tbody>
        {rows.map(d => <tr key={d.id} className={d.active ? '' : 'muted'}>
          <td><strong>{d.name}</strong>{d.vehicle ? <span className="muted"> · {d.vehicle}</span> : null}{d.user_id ? <span className="pill ok" style={{ marginInlineStart: 6 }}>👤</span> : null}</td>
          <td dir="ltr">{fmtPhone(d.phone)} <a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`tel:+${waDigits(d.phone)}`}>📞</a><a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`https://wa.me/${waDigits(d.phone)}`} target="_blank" rel="noreferrer">💬</a></td>
          <td><label className="row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={d.available} onChange={e => save({ id: d.id, name: d.name, phone: d.phone, available: e.target.checked })} /> {pt('availableToday', locale)}</label></td>
          <td><button className="btn ghost" onClick={() => setEdit(d)}>✎</button></td>
        </tr>)}
      </tbody></table> : <p className="muted">—</p>}
      {msg && <small className="muted">{msg}</small>}
      {edit && <DriverForm locale={locale} d={edit} onSave={save} onClose={() => setEdit(null)} />}
    </section>
  );
}

function DriverForm({ locale, d, onSave, onClose }: { locale: L; d: Partial<Driver>; onSave: (p: Partial<Driver> & { name: string; phone: string }) => void; onClose: () => void }) {
  const [name, setName] = useState(d.name ?? ''); const [phone, setPhone] = useState(d.phone ?? ''); const [vehicle, setVehicle] = useState(d.vehicle ?? ''); const [active, setActive] = useState(d.active ?? true); const [notes, setNotes] = useState(d.notes ?? '');
  return (
    <div className="card stack" style={{ marginTop: 8, background: '#f8fafc' }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="label" style={{ flex: 1, minWidth: 140 }}>{pt('driverFullName', locale)}<input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus /></label>
        <label className="label" style={{ flex: 1, minWidth: 140 }}>{pt('customerPhone', locale)}<input className="input" dir="ltr" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="70 123 456" /></label>
        <label className="label" style={{ flex: 1, minWidth: 120 }}>{pt('vehicleKind', locale)}<input className="input" value={vehicle} onChange={e => setVehicle(e.target.value)} placeholder="موتو / سيارة" /></label>
      </div>
      <label className="label">{pt('customerNotes', locale)}<input className="input" value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn primary" disabled={!name.trim() || phone.replace(/\D/g, '').length < 6} onClick={() => onSave({ id: d.id, name, phone, vehicle: vehicle.trim() || null, active, notes: notes.trim() || null })}>{pt('save', locale)}</button>
        {d.id && <label className="row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> {pt('active', locale)}</label>}
        <span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button>
      </div>
    </div>
  );
}
