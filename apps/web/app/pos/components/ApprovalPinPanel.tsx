'use client';
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hashPin, isValidPin, verifyPin, type ApprovalPin, type Staff } from '@suqa/pos-core';
import Modal from './Modal';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { fmtTime } from '../lib/boot';
import { getApproval, onApprovalChange, refreshApproval, storeApproval } from '../lib/approval';
import { useConfirm } from '@/components/ConfirmProvider';

/**
 * Settings → the shop's approval PIN (owner only). Same style as a login PIN: 4 digits, hashed on this device, never shown —
 * it can only be replaced or removed, and both ask for the owner's own login PIN first (the owner's tile may have been left open).
 */
export default function ApprovalPinPanel({ boot, sb, locale, me, online }: { boot: Booted; sb: SupabaseClient; locale: L; me: Staff; online: boolean }) {
  const [cur, setCur] = useState<ApprovalPin>(() => getApproval());
  const [dlg, setDlg] = useState<null | 'set' | 'remove'>(null);
  const [login, setLogin] = useState(''); const [a, setA] = useState(''); const [b, setB] = useState('');
  const [msg, setMsg] = useState<string | null>(null); const [note, setNote] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  useEffect(() => onApprovalChange(() => setCur(getApproval())), []);
  useEffect(() => { if (online) void refreshApproval(); }, [online]);
  const start = (what: 'set' | 'remove') => { setLogin(''); setA(''); setB(''); setMsg(null); setNote(null); setDlg(what); };
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 4);

  const loginOk = async () => !!me.pin_hash && !!me.pin_salt && await verifyPin(login, me.pin_hash, me.pin_salt);
  const save = async () => {
    setMsg(null);
    if (!(await loginOk())) { setMsg(pt('wrongPin', locale)); setLogin(''); return; }
    if (dlg === 'remove') {
      if (!(await confirm(pt('approvalPinRemoveAsk', locale), { danger: true }))) return;
      setBusy(true);
      const { error } = await sb.rpc('pos_set_approval_pin', { p_shop: boot.shop.id, p_hash: null, p_salt: null });
      setBusy(false);
      if (error) { setMsg(error.message); return; }
      await storeApproval(null); setDlg(null); setNote(pt('approvalPinRemoved', locale)); return;
    }
    if (!isValidPin(a)) { setMsg(pt('newApprovalPin', locale)); return; }
    if (a !== b) { setMsg(pt('pinMismatch', locale)); return; }
    // must not be anyone's login PIN: a cashier who knows the approval PIN would otherwise hold a key to that tile
    const staff = await boot.db.staff.toArray();
    for (const s of staff) if (s.pin_hash && s.pin_salt && await verifyPin(a, s.pin_hash, s.pin_salt)) { setMsg(pt('approvalSameAsLogin', locale)); return; }
    setBusy(true);
    const { hash, salt } = await hashPin(a);
    const { data, error } = await sb.rpc('pos_set_approval_pin', { p_shop: boot.shop.id, p_hash: hash, p_salt: salt });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    await storeApproval({ hash, salt, set_at: (data as { set_at?: string } | null)?.set_at ?? new Date().toISOString() });
    setDlg(null); setNote(pt('approvalPinSaved', locale));
  };

  const pinInput = (label: string, v: string, set: (s: string) => void, auto = false) => (
    <label className="label">{label}<input className="input" dir="ltr" inputMode="numeric" type="password" autoComplete="off" maxLength={4} autoFocus={auto} value={v} onChange={e => { setMsg(null); set(digits(e.target.value)); }} onKeyDown={e => { if (e.key === 'Enter') void save(); }} /></label>
  );
  const ready = login.length === 4 && (dlg === 'remove' || (a.length === 4 && b.length === 4));
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>🔑 {pt('approvalPinTitle', locale)}</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{pt('approvalPinDesc', locale)}</p>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`pill ${cur ? 'ok' : 'warn'}`}>{cur ? `✓ ${pt('approvalPinSet', locale)} ${cur.set_at ? fmtTime(cur.set_at, locale) : ''}` : pt('approvalPinNone', locale)}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={!online} onClick={() => start('set')}>{pt(cur ? 'approvalPinChangeBtn' : 'approvalPinSetBtn', locale)}</button>
        {cur && <button className="btn ghost danger" disabled={!online} onClick={() => start('remove')}>{pt('approvalPinRemoveBtn', locale)}</button>}
      </div>
      {!online && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{pt('needOnline', locale)}</p>}
      {note && <p className="muted" style={{ marginBottom: 0 }}>✓ {note}</p>}
      {dlg && <Modal open onClose={() => setDlg(null)} title={`🔑 ${pt(dlg === 'remove' ? 'approvalPinRemoveBtn' : cur ? 'approvalPinChangeBtn' : 'approvalPinSetBtn', locale)}`}
        footer={<><button className="btn ghost" onClick={() => setDlg(null)}>{pt('cancel', locale)}</button><span style={{ flex: 1 }} /><button className={`btn ${dlg === 'remove' ? 'danger' : 'primary'}`} disabled={!ready || busy} onClick={save}>{pt(dlg === 'remove' ? 'approvalPinRemoveBtn' : 'save', locale)}</button></>}>
        <div className="stack" style={{ gap: 10 }}>
          {pinInput(pt('yourLoginPin', locale), login, setLogin, true)}
          {dlg === 'set' && pinInput(pt('newApprovalPin', locale), a, setA)}
          {dlg === 'set' && pinInput(pt('repeatApprovalPin', locale), b, setB)}
          {msg && <div className="bad">{msg}</div>}
        </div>
      </Modal>}
    </section>
  );
}
