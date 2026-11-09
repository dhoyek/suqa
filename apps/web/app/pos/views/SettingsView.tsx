'use client';
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hashPin, isValidPin, type Conflict, type Device, type OutboxOp, type Staff, type SyncStatus } from '@suqa/pos-core';
import StaffPanel from '../components/StaffPanel';
import DriversPanel from '../components/DriversPanel';
import ShopSettings from '../components/ShopSettings';
import { pt, type L, type Key } from '../i18n';
import { APP_VERSION, fmtTime, type Booted } from '../lib/boot';
import { useConfirm } from '@/components/ConfirmProvider';
import { doPrint, loadPrintSettings, savePrintSettings, testPrintHtml, type PrintSettings } from '../lib/print';

export default function SettingsView({ boot, sb, locale, status, staff, tick, setLocale }: { boot: Booted; sb: SupabaseClient; locale: L; status: SyncStatus | null; staff: Staff; tick: number; setLocale: (l: L) => void }) {
  const [big, setBig] = useState(() => { try { return localStorage.getItem('suqa-pos-big') === '1'; } catch { return false; } });
  const toggleBig = (v: boolean) => { setBig(v); try { localStorage.setItem('suqa-pos-big', v ? '1' : '0'); } catch {} document.documentElement.classList.toggle('pos-big', v); };
  const [devices, setDevices] = useState<Device[]>([]);
  const [members, setMembers] = useState<Staff[]>([]);
  const [persist, setPersist] = useState<boolean | null>(null);
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [ps, setPs] = useState<PrintSettings>(() => loadPrintSettings());
  const upd = (patch: Partial<PrintSettings>) => { const n = { ...ps, ...patch }; setPs(n); savePrintSettings(n); };
  const confirm = useConfirm();
  const owner = boot.role === 'owner';
  const online = status?.online ?? true;
  const [conflicts, setConflicts] = useState<Conflict[]>([]); const [rejected, setRejected] = useState<OutboxOp[]>([]);
  const loadRejected = () => boot.db.outbox.where('state').equals('rejected').toArray().then(r => setRejected(r.sort((a, b) => b.created_at.localeCompare(a.created_at))));
  const dropRejected = async (seq?: number) => { if (seq == null) await boot.db.outbox.where('state').equals('rejected').delete(); else await boot.db.outbox.delete(seq); await loadRejected(); boot.engine.poke(); };
  type Audit = { id: number; at: string; user_id: string | null; action: string; ref_tbl: string | null; ref_id: string | null; after: Record<string, unknown> | null };
  const [audit, setAudit] = useState<Audit[] | null>(null); const [auditN, setAuditN] = useState(50);
  useEffect(() => { boot.db.conflicts.orderBy('at').reverse().limit(100).toArray().then(setConflicts); loadRejected(); }, [boot, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!owner || !online) return;
    sb.from('audit_log').select('id, at, user_id, action, ref_tbl, ref_id, after').eq('shop_id', boot.shop.id).order('at', { ascending: false }).limit(auditN).then(({ data }) => setAudit((data as Audit[]) ?? []));
  }, [sb, boot, owner, online, auditN, tick]);
  const who = (id: string | null) => { const m = members.find(x => x.user_id === id); return m?.display_name || m?.full_name || (id ? id.slice(0, 8) : '—'); };
  const actionLabel = (a: string) => { const k = `a_${a.replace('.', '_')}`; const t = pt(k as 'a_sale_commit', locale); return t === k || !t ? a : t; };
  const markSeen = async () => { await boot.db.conflicts.filter(c => !c.seen).modify({ seen: true }); setConflicts(await boot.db.conflicts.orderBy('at').reverse().limit(100).toArray()); };

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
        {owner ? <StaffPanel boot={boot} sb={sb} locale={locale} staff={staff} online={online} /> : <ul style={{ margin: 0, paddingInlineStart: 18 }}>
          {members.filter(m => m.active).map(m => <li key={m.user_id}>{m.display_name || m.full_name || m.user_id.slice(0, 8)} <span className="muted">· {pt((`role_${m.role}` as 'role_owner'), locale)}</span></li>)}
        </ul>}
        <div className="row" style={{ marginTop: 10, gap: 10, alignItems: 'center' }}>
          <button className="btn" onClick={changePin}>{pt('changePin', locale)}</button>{pinMsg && <span className="muted">{pinMsg}</span>}
        </div>
      </section>
      {owner && <ShopSettings boot={boot} sb={sb} locale={locale} online={online} />}
      {owner && <DriversPanel boot={boot} locale={locale} tick={tick} />}
      <section className="card">
        <h3 style={{ marginTop: 0 }}>🏬 {pt('onlineShop', locale)}</h3>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{pt('onlineShopHint', locale)}</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <a className="btn" href={`/s/${boot.shop.slug}`} target="_blank" rel="noreferrer">👁 {pt('viewAsCustomer', locale)}</a>
          {owner && <a className="btn" href="/shop/settings" target="_blank" rel="noreferrer">⚙ {pt('shopDashboard', locale)}</a>}
          <a className="btn ghost" href="/" target="_blank" rel="noreferrer">🏠 {pt('homePage', locale)}</a>
        </div>
      </section>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>🌐 {pt('language', locale)}</h3>
        <div className="row" style={{ gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="seg"><button className={locale === 'ar' ? 'active' : ''} onClick={() => setLocale('ar')}>العربية</button><button className={locale === 'en' ? 'active' : ''} onClick={() => setLocale('en')}>English</button></div>
          <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="checkbox" checked={big} onChange={e => toggleBig(e.target.checked)} /> {pt('bigButtons', locale)}</label>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>{pt('perDevice', locale)}</p>
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
      <section className="card" id="rejected-ops">
        <div className="row spread" style={{ alignItems: 'center' }}><h3 style={{ margin: 0 }}>{pt('rejectedOps', locale)}{rejected.length ? <span className="pill bad" style={{ marginInlineStart: 8 }}>{rejected.length}</span> : null}</h3>{rejected.length > 0 && <button className="btn ghost" onClick={() => dropRejected()}>{pt('clearAll', locale)}</button>}</div>
        <p className="muted" style={{ fontSize: 13 }}>{pt('rejectedOpsHint', locale)}</p>
        {rejected.length ? <table className="table"><tbody>
          {rejected.map(op => <tr key={op.seq}><td className="muted">{fmtTime(op.created_at, locale)}</td><td>{pt(`a_${op.kind.replace('.', '_')}` as Key, locale)}</td><td className="muted" style={{ whiteSpace: 'normal' }}>{op.last_error}</td><td><button className="btn ghost" onClick={() => dropRejected(op.seq)}>✕</button></td></tr>)}
        </tbody></table> : <p className="muted">—</p>}
      </section>
      {owner && <section className="card">
        <div className="row spread" style={{ alignItems: 'center' }}><h3 style={{ margin: 0 }}>{pt('conflicts', locale)}{conflicts.some(c => !c.seen) ? <span className="pill bad" style={{ marginInlineStart: 8 }}>{conflicts.filter(c => !c.seen).length}</span> : null}</h3>{conflicts.some(c => !c.seen) && <button className="btn ghost" onClick={markSeen}>{pt('markSeen', locale)}</button>}</div>
        <p className="muted" style={{ fontSize: 12 }}>{pt('conflictHint', locale)}</p>
        {conflicts.length ? <table className="table"><tbody>
          {conflicts.map(c => <tr key={c.id} className={c.seen ? 'muted' : ''}><td className="muted">{fmtTime(c.at, locale)}</td><td>{c.tbl} · {c.field}</td><td dir="ltr" style={{ fontSize: 12 }}>{JSON.stringify(c.old_value)} → <strong>{JSON.stringify(c.new_value)}</strong></td><td className="muted" style={{ fontSize: 12 }}>{devices.find(d => d.id === c.by_device)?.name ?? ''}</td></tr>)}
        </tbody></table> : <p className="muted">{pt('noConflicts', locale)}</p>}
      </section>}
      {owner && <section className="card">
        <h3 style={{ marginTop: 0 }}>{pt('auditLog', locale)}</h3>
        {!online ? <p className="muted">{pt('needOnline', locale)}</p> : audit === null ? <p className="muted">…</p> : <>
          <table className="table"><tbody>
            <tr><th style={{ textAlign: 'start' }}>{pt('when', locale)}</th><th style={{ textAlign: 'start' }}>{pt('who', locale)}</th><th style={{ textAlign: 'start' }}>{pt('what', locale)}</th><th></th></tr>
            {audit.map(a => <tr key={a.id}><td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtTime(a.at, locale)}</td><td>{who(a.user_id)}</td><td>{actionLabel(a.action)}</td><td className="muted" dir="ltr" style={{ fontSize: 12, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.ref_id ? a.ref_id.slice(0, 12) : ''}{a.after ? ' ' + JSON.stringify(a.after).slice(0, 120) : ''}</td></tr>)}
          </tbody></table>
          {audit.length >= auditN && <button className="btn ghost" onClick={() => setAuditN(n => n + 100)}>{pt('loadMore', locale)}</button>}
        </>}
      </section>}
      <section className="card muted" style={{ fontSize: 13 }}>
        <div>{pt('version', locale)}: {APP_VERSION} · {pt('lastSync', locale)}: {fmtTime(status?.lastSyncAt, locale)} · cursor {status?.cursor ?? 0}</div>
        <div>{pt('storage', locale)}: {persist === null ? '—' : persist ? pt('persistent', locale) : pt('notPersistent', locale)}</div>
      </section>
      <form action="/auth/signout" method="post"><button className="btn ghost muted" type="submit">{pt('signOut', locale)}</button></form>
    </div>
  );
}
