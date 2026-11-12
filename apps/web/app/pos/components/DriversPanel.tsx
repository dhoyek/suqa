'use client';
import { useEffect, useState } from 'react';
import { deleteDriver, driverPayRule, fmtPhone, fmtUsd, getMeta, setMeta, META, upsertDriver, waDigits, type Driver, type DriverPayMode, type Shop } from '@suqa/pos-core';
import { useConfirm } from '@/components/ConfirmProvider';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import type { SupabaseClient } from '@supabase/supabase-js';
import Modal from './Modal';

/** الإعدادات → السائقون: the shop's contracted drivers, availability toggle, call / WhatsApp. */
type DirRow = { name: string; phone: string; vehicle: string | null; has_account: boolean; used_by: string | null };
export default function DriversPanel({ boot, locale, tick, sb, online = true }: { boot: Booted; locale: L; tick: number; sb?: SupabaseClient; online?: boolean }) {
  const [dir, setDir] = useState<DirRow[] | null>(null); const [dirOpen, setDirOpen] = useState(false);
  const openDir = async () => { setDirOpen(true); if (!sb) return; const { data, error } = await sb.rpc('pos_driver_directory', { p_shop: boot.shop.id }); setDir(error ? [] : ((data as DirRow[]) ?? [])); };
  const [rows, setRows] = useState<Driver[]>([]); const [edit, setEdit] = useState<Partial<Driver> | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const confirm = useConfirm();
  const remove = async (d: Driver) => {
    if (!(await confirm(`${pt('removeDriver', locale)}: ${d.name}? ${pt('removeDriverHint', locale)}`, { danger: true }))) return;
    await deleteDriver(boot.db, d.id); await load(); boot.engine.poke();
  };
  // pay rule: the shop default and each driver's own (schema 60). Saved online through pos_set_driver_pay; the feed brings it to the other tills.
  const [shop, setShop] = useState<Shop>(boot.shop); const [rule, setRule] = useState<null | { driver: Driver | null }>(null);
  useEffect(() => { getMeta<Shop>(boot.db, META.shop).then(s => { if (s) setShop(s); }); }, [boot, tick]);
  const ruleLabel = (mode: DriverPayMode, cents: number) => mode === 'per_delivery' ? `${fmtUsd(cents)} · ${pt('pay_per_delivery', locale)}` : pt(`pay_${mode}` as 'pay_none', locale);
  const saveRule = async (driver: Driver | null, mode: DriverPayMode | null, cents: number) => {
    if (!sb) return;
    const { error } = await sb.rpc('pos_set_driver_pay', { p_shop: boot.shop.id, p_driver: driver?.id ?? null, p_mode: mode, p_cents: mode === 'per_delivery' ? cents : null });
    if (error) { setMsg(error.message); return; }
    if (driver) await boot.db.drivers.update(driver.id, { pay_mode: mode, pay_cents: mode === 'per_delivery' ? cents : null });
    else { const next = { ...shop, driver_pay_mode: mode ?? 'none', driver_pay_cents: mode === 'per_delivery' ? cents : 0 }; await setMeta(boot.db, META.shop, next); setShop(next); }
    setRule(null); setMsg(pt('saved', locale)); await load(); boot.engine.poke();
  };
  const load = () => boot.db.drivers.toArray().then(r => setRows(r.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))));
  useEffect(() => { load(); }, [boot, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (patch: Partial<Driver> & { name: string; phone: string }) => {
    try { await upsertDriver(boot.db, boot.shop.id, patch); boot.engine.poke(); setEdit(null); setMsg(pt('saved', locale)); await load(); }
    catch (e) { setMsg((e as Error).message === 'bad_phone' ? pt('customerPhone', locale) + ' ?' : (e as Error).message); }
  };
  return (
    <section className="card">
      <div className="row spread" style={{ alignItems: 'center' }}><h3 style={{ margin: 0 }}>🛵 {pt('drivers', locale)}</h3><div className="row" style={{ gap: 6 }}>{sb && online && <button className="btn" onClick={openDir}>📇 {pt('fromDirectory', locale)}</button>}<button className="btn primary" onClick={() => setEdit({ name: '', phone: '', vehicle: '' })}>＋ {pt('newDriver', locale)}</button></div></div>
      <p className="muted" style={{ fontSize: 13 }}>{pt('driversHint', locale)}</p>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', background: '#f6f7f9', borderRadius: 10, marginBottom: 8 }}>
        <span>💵 <strong>{pt('payRule', locale)}</strong> — {pt('payRuleDefault', locale)}: {ruleLabel(shop.driver_pay_mode ?? 'none', Number(shop.driver_pay_cents) || 0)}</span>
        <span style={{ flex: 1 }} />
        {sb && <button className="btn" disabled={!online} onClick={() => setRule({ driver: null })}>✎ {pt('edit', locale)}</button>}
      </div>
      {rows.length ? <table className="table"><tbody>
        {rows.map(d => <tr key={d.id} className={d.active ? '' : 'muted'}>
          <td><strong>{d.name}</strong>{d.vehicle ? <span className="muted"> · {d.vehicle}</span> : null}{d.user_id ? <span className="pill ok" style={{ marginInlineStart: 6 }}>👤</span> : null}</td>
          <td dir="ltr">{fmtPhone(d.phone)} <a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`tel:+${waDigits(d.phone)}`}>📞</a><a className="btn ghost" style={{ minHeight: 0, padding: '2px 8px' }} href={`https://wa.me/${waDigits(d.phone)}`} target="_blank" rel="noreferrer">💬</a></td>
          <td><label className="row" style={{ gap: 6, alignItems: 'center' }}><input type="checkbox" checked={d.available} onChange={e => save({ id: d.id, name: d.name, phone: d.phone, available: e.target.checked })} /> {pt('availableToday', locale)}</label></td>
          <td>{(() => { const r = driverPayRule(shop, d); return <button className="btn ghost" style={{ minHeight: 0, padding: '2px 8px', fontSize: 13 }} disabled={!sb || !online} title={pt('payRule', locale)} onClick={() => setRule({ driver: d })}>💵 {ruleLabel(r.mode, r.cents)}{r.own ? <span className="pill warn" style={{ marginInlineStart: 6 }}>{pt('payOwn', locale)}</span> : null}</button>; })()}</td>
          <td style={{ whiteSpace: 'nowrap' }}><button className="btn ghost" title={pt('edit', locale)} onClick={() => setEdit(d)}>✎</button><button className="btn ghost" title={pt('removeDriver', locale)} onClick={() => remove(d)}>🗑</button></td>
        </tr>)}
      </tbody></table> : <p className="muted">—</p>}
      {msg && <small className="muted">{msg}</small>}
      {rule && <PayRuleDialog locale={locale} driver={rule.driver} shop={shop} label={ruleLabel} onSave={(m, c) => saveRule(rule.driver, m, c)} onClose={() => setRule(null)} />}
      {edit && <DriverForm locale={locale} d={edit} onSave={save} onClose={() => setEdit(null)} />}
      {dirOpen && <Modal open onClose={() => setDirOpen(false)} title={`📇 ${pt('fromDirectory', locale)}`} footer={<><span style={{ flex: 1 }} /><button className="btn primary" onClick={() => setDirOpen(false)}>{pt('ok', locale)}</button></>}>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>{pt('directoryHint', locale)}</p>
        {dir === null ? <p className="muted">{pt('loading', locale)}</p> : !dir.length ? <p className="muted">—</p> : (
          <div className="stack" style={{ gap: 4 }}>
            {dir.map(r => <button key={r.phone} className="btn ghost" style={{ justifyContent: 'space-between' }} onClick={async () => { await save({ name: r.name, phone: r.phone, vehicle: r.vehicle ?? undefined }); setDir(d => (d ?? []).filter(x => x.phone !== r.phone)); }}>
              <span>🛵 {r.name}{r.vehicle ? <span className="muted"> · {r.vehicle}</span> : null}{r.has_account ? ' 👤' : ''}<div className="muted" style={{ fontSize: 12 }}>{r.used_by}</div></span><span className="muted" dir="ltr">{fmtPhone(r.phone)}</span></button>)}
          </div>
        )}
      </Modal>}
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

/** The shop default (driver = null) or one driver's own rule; for a driver, "follow the shop" clears his override. */
function PayRuleDialog({ locale, driver, shop, label, onSave, onClose }: { locale: L; driver: Driver | null; shop: Shop; label: (m: DriverPayMode, c: number) => string; onSave: (mode: DriverPayMode | null, cents: number) => void; onClose: () => void }) {
  const cur = driver ? driver.pay_mode ?? null : shop.driver_pay_mode ?? 'none';
  const [mode, setMode] = useState<DriverPayMode | null>(cur);
  const [amt, setAmt] = useState(() => { const c = driver ? Number(driver.pay_cents) || 0 : Number(shop.driver_pay_cents) || 0; return c ? (c / 100).toFixed(2) : ''; });
  const cents = Math.round((Number(amt) || 0) * 100);
  const opts: (DriverPayMode | null)[] = driver ? [null, 'none', 'per_delivery', 'delivery_fee'] : ['none', 'per_delivery', 'delivery_fee'];
  return (
    <Modal open onClose={onClose} title={`💵 ${pt('payRule', locale)}${driver ? ' · ' + driver.name : ''}`}
      footer={<><button className="btn ghost" onClick={onClose}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" disabled={mode === 'per_delivery' && cents <= 0} onClick={() => onSave(mode, cents)}>{pt('save', locale)}</button></>}>
      <div className="stack" style={{ gap: 8 }}>
        {!driver && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{pt('payRuleHint', locale)}</p>}
        {opts.map(o => <label key={o ?? 'shop'} className="row" style={{ gap: 10, alignItems: 'center', cursor: 'pointer', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 10, background: mode === o ? '#eef6f8' : '#fff' }}>
          <input type="radio" name="payrule" checked={mode === o} onChange={() => setMode(o)} />
          <span>{o === null ? <>{pt('payFollowShop', locale)} <span className="muted">({label(shop.driver_pay_mode ?? 'none', Number(shop.driver_pay_cents) || 0)})</span></> : pt(`pay_${o}` as 'pay_none', locale)}</span>
        </label>)}
        {mode === 'per_delivery' && <label className="label">{pt('perDeliveryAmount', locale)}<input className="input" dir="ltr" inputMode="decimal" autoFocus value={amt} onChange={e => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="1.50" /></label>}
      </div>
    </Modal>
  );
}
