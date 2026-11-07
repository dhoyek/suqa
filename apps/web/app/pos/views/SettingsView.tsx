'use client';
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hashPin, isValidPin, type Device, type Staff, type SyncStatus } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import { APP_VERSION, fmtTime, type Booted } from '../lib/boot';
import { useConfirm } from '@/components/ConfirmProvider';
import { doPrint, loadPrintSettings, savePrintSettings, testPrintHtml, type PrintSettings } from '../lib/print';

export default function SettingsView({ boot, sb, locale, status, staff, tick }: { boot: Booted; sb: SupabaseClient; locale: L; status: SyncStatus | null; staff: Staff; tick: number }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [members, setMembers] = useState<Staff[]>([]);
  const [persist, setPersist] = useState<boolean | null>(null);
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [ps, setPs] = useState<PrintSettings>(() => loadPrintSettings());
  const upd = (patch: Partial<PrintSettings>) => { const n = { ...ps, ...patch }; setPs(n); savePrintSettings(n); };
  const confirm = useConfirm();
  const owner = boot.role === 'owner';

  useEffect(() => {
    boot.db.devices.toArray().then(setDevices); boot.db.staff.toArray().then(setMembers);
    navigator.storage?.persisted?.().then(setPersist).catch(() => setPersist(null));
  }, [boot, tick]);

  const revoke = async (d: Device) => {
    if (!(await confirm(pt('revokeConfirm', locale)))) return;
    const { error } = await sb.rpc('pos_revoke_device', { p_id: d.id });
    if (error) alert(error.message); else boot.engine.poke();
  };
  const changePin = async () => {
    const a = prompt(pt('setPin', locale)); if (a === null) return;
    if (!isValidPin(a)) { setPinMsg(pt('enterPin', locale)); return; }
    const b = prompt(pt('confirmPin', locale)); if (b !== a) { setPinMsg(pt('pinMismatch', locale)); return; }
    const { hash, salt } = await hashPin(a);
    const { error } = await sb.rpc('pos_set_pin', { p_shop: boot.shop.id, p_user: staff.user_id, p_hash: hash, p_salt: salt });
    if (error) { setPinMsg(error.message); return; }
    await boot.db.staff.update(staff.user_id, { pin_hash: hash, pin_salt: salt });
    setPinMsg(pt('pinSaved', locale));
  };

  return (
    <div className="stack" style={{ padding: 16, maxWidth: 760 }}>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>{pt('devices', locale)}</h3>
        <table className="table">
          <tbody>
            {devices.map(d => (
              <tr key={d.id} className={d.revoked_at ? 'muted' : ''}>
                <td><strong>{d.prefix}</strong></td>
                <td>{d.name}{d.id === boot.deviceId ? ` (${pt('thisDevice', locale)})` : ''}</td>
                <td className="muted">{pt('lastSync', locale)}: {fmtTime(d.last_sync_at, locale)}{d.pending_count ? ` · ${d.pending_count} ${pt('pending', locale)}` : ''}</td>
                <td>{d.revoked_at ? <span className="pill bad">{pt('revokedAt', locale)}</span> : owner && d.id !== boot.deviceId ? <button className="btn danger" onClick={() => revoke(d)}>{pt('revoke', locale)}</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>{pt('staff', locale)}</h3>
        <ul style={{ margin: 0, paddingInlineStart: 18 }}>
          {members.map(m => <li key={m.user_id}>{m.display_name || m.full_name || m.user_id.slice(0, 8)} <span className="muted">· {pt((`role_${m.role}` as 'role_owner'), locale)}{m.pin_hash ? '' : ' · ' + pt('setPin', locale).split(' ').slice(0, 2).join(' ')}</span></li>)}
        </ul>
        <div className="row" style={{ marginTop: 10, gap: 10, alignItems: 'center' }}>
          <button className="btn" onClick={changePin}>{pt('changePin', locale)}</button>{pinMsg && <span className="muted">{pinMsg}</span>}
        </div>
      </section>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>🖨 {pt('printer', locale)}</h3>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}><span style={{ minWidth: 160 }}>{pt('paper', locale)}</span>
            <div className="seg"><button className={ps.paper === 58 ? 'active' : ''} onClick={() => upd({ paper: 58 })}>58 mm</button><button className={ps.paper === 80 ? 'active' : ''} onClick={() => upd({ paper: 80 })}>80 mm</button></div></div>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}><span style={{ minWidth: 160 }}>{pt('feedLines', locale)}</span>
            <div className="seg">{[0, 1, 2, 3, 4, 5].map(n => <button key={n} className={ps.feed === n ? 'active' : ''} onClick={() => upd({ feed: n })}>{n}</button>)}</div></div>
          <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="checkbox" checked={ps.cutMark} onChange={e => upd({ cutMark: e.target.checked })} /> {pt('cutMark', locale)}</label>
          <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="checkbox" checked={ps.autoPrint} onChange={e => upd({ autoPrint: e.target.checked })} /> {pt('autoPrint', locale)}</label>
          <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="checkbox" checked={ps.showLbp} onChange={e => upd({ showLbp: e.target.checked })} /> {pt('showLbpOnReceipt', locale)}</label>
          <div><button className="btn" onClick={() => doPrint(testPrintHtml(boot.shop, locale, ps), ps)}>🖨 {pt('testPrint', locale)}</button></div>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>{pt('printerHint', locale)}</p>
        </div>
      </section>
      <section className="card muted" style={{ fontSize: 13 }}>
        <div>{pt('version', locale)}: {APP_VERSION} · {pt('lastSync', locale)}: {fmtTime(status?.lastSyncAt, locale)} · cursor {status?.cursor ?? 0}</div>
        <div>{pt('storage', locale)}: {persist === null ? '—' : persist ? pt('persistent', locale) : pt('notPersistent', locale)}</div>
        <div>{pt('rate', locale)} / {pt('shift', locale)} / {pt('reports', locale)}: {pt('comingSoon', locale)}</div>
      </section>
      <form action="/auth/signout" method="post"><button className="btn ghost muted" type="submit">{pt('signOut', locale)}</button></form>
    </div>
  );
}
