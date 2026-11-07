'use client';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { text, type Staff } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { useConfirm } from '@/components/ConfirmProvider';

type Member = { user_id: string; role: 'owner' | 'cashier' | 'stock' | 'staff'; display_name: string | null; full_name: string | null; phone: string | null; active: boolean; pin: boolean };
type Invite = { id: string; phone: string; display_name: string | null; role: string; created_at: string };
const ROLES = ['owner', 'cashier', 'stock'] as const;

/** Owner view of the team: add by WhatsApp number (membership now, or an invite claimed at first sign-in), change role, deactivate. */
export default function StaffPanel({ boot, sb, locale, staff, online }: { boot: Booted; sb: SupabaseClient; locale: L; staff: Staff; online: boolean }) {
  const [members, setMembers] = useState<Member[]>([]); const [invites, setInvites] = useState<Invite[]>([]);
  const [phone, setPhone] = useState(''); const [name, setName] = useState(''); const [role, setRole] = useState<typeof ROLES[number]>('cashier');
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [lastInvite, setLastInvite] = useState<{ phone: string; name: string } | null>(null);
  const confirm = useConfirm();
  const load = useCallback(async () => {
    if (!online) { const local = await boot.db.staff.toArray(); setMembers(local.map(m => ({ user_id: m.user_id, role: m.role, display_name: m.display_name ?? null, full_name: m.full_name ?? null, phone: null, active: m.active, pin: !!m.pin_hash }))); return; }
    const { data, error } = await sb.rpc('pos_staff_list', { p_shop: boot.shop.id });
    if (error) { setMsg(error.message); return; }
    const d = data as { members: Member[]; invites: Invite[] }; setMembers(d.members); setInvites(d.invites);
  }, [sb, boot, online]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (busy) return; setBusy(true); setMsg(null);
    try {
      const { data, error } = await sb.rpc('pos_staff_invite', { p_shop: boot.shop.id, p_phone: phone, p_name: name, p_role: role });
      if (error) { setMsg(error.message); return; }
      const r = data as { status: 'member' | 'invited'; phone?: string };
      setMsg(r.status === 'member' ? pt('staffAdded', locale) : pt('invited', locale));
      setLastInvite({ phone: r.phone ?? phone.replace(/\D/g, ''), name }); setPhone(''); setName(''); boot.engine.poke(); await load();
    } finally { setBusy(false); }
  };
  const set = async (m: Member, patch: { p_role?: string; p_active?: boolean; p_name?: string }) => {
    if (patch.p_active === false && !(await confirm(`${pt('deactivate', locale)} ${m.display_name || m.full_name || m.phone}?`))) return;
    const { error } = await sb.rpc('pos_staff_set', { p_shop: boot.shop.id, p_user: m.user_id, ...patch });
    if (error) { setMsg(/last_owner/.test(error.message) ? pt('lastOwner', locale) : error.message); return; }
    boot.engine.poke(); await load();
  };
  const resetPin = async (m: Member) => {
    if (!(await confirm(`${pt('resetPin', locale)} — ${m.display_name || m.full_name || ''}?`))) return;
    const { error } = await sb.rpc('pos_set_pin', { p_shop: boot.shop.id, p_user: m.user_id, p_hash: null, p_salt: null });
    if (error) { setMsg(error.message); return; }
    boot.engine.poke(); await load();
  };
  const cancelInvite = async (i: Invite) => { await sb.from('staff_invites').delete().eq('id', i.id); await load(); };
  const waLink = (to: string, n: string) => {
    const shop = text(boot.shop.name, locale); const url = `${location.origin}/login`;
    const body = pt('inviteMsg', locale).replace('{name}', n || '').replace('{shop}', shop).replace('{url}', url);
    return `https://wa.me/${to}?text=${encodeURIComponent(body)}`;
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      <table className="table"><tbody>
        {members.map(m => <tr key={m.user_id} className={m.active ? '' : 'muted'}>
          <td><strong style={{ cursor: online ? 'pointer' : 'default' }} title={pt('staffName', locale)} onClick={() => { if (!online) return; const v = prompt(pt('staffName', locale), m.display_name || m.full_name || ''); if (v != null && v.trim()) void set(m, { p_name: v.trim() }); }}>{m.display_name || m.full_name || '—'} ✎</strong>{m.user_id === staff.user_id ? ` (${pt('you', locale)})` : ''}<div className="muted" dir="ltr" style={{ fontSize: 12 }}>{m.phone ? '+' + m.phone : ''}</div></td>
          <td>{online ? <select className="input" value={m.role === 'staff' ? 'cashier' : m.role} onChange={e => set(m, { p_role: e.target.value })} style={{ width: 'auto', minHeight: 36 }}>{ROLES.map(r => <option key={r} value={r}>{pt(`role_${r}` as 'role_owner', locale)}</option>)}</select> : pt(`role_${m.role}` as 'role_owner', locale)}</td>
          <td className="muted">{m.pin ? 'PIN ✓' : pt('noPin', locale)}</td>
          <td style={{ whiteSpace: 'nowrap' }}>
            {online && m.pin && <button className="btn ghost" onClick={() => resetPin(m)}>{pt('resetPin', locale)}</button>}{' '}
            {online && m.user_id !== staff.user_id && (m.active ? <button className="btn ghost" onClick={() => set(m, { p_active: false })}>{pt('deactivate', locale)}</button> : <button className="btn" onClick={() => set(m, { p_active: true })}>{pt('activate', locale)}</button>)}
          </td>
        </tr>)}
        {invites.map(i => <tr key={i.id} className="muted">
          <td><strong>{i.display_name || '—'}</strong><div dir="ltr" style={{ fontSize: 12 }}>+{i.phone}</div></td>
          <td>{pt(`role_${i.role}` as 'role_owner', locale)}</td>
          <td><span className="pill warn">{pt('invited', locale)}</span></td>
          <td style={{ whiteSpace: 'nowrap' }}><a className="btn ghost" href={waLink(i.phone, i.display_name ?? '')} target="_blank" rel="noreferrer">💬</a> <button className="btn ghost" onClick={() => cancelInvite(i)}>{pt('cancelInvite', locale)}</button></td>
        </tr>)}
      </tbody></table>
      {online ? (
        <div className="card" style={{ background: '#fafafa' }}>
          <strong>{pt('addStaff', locale)}</strong>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 170 }}><label className="label">{pt('staffPhone', locale)}</label><input className="input" dir="ltr" inputMode="tel" placeholder="+961 70 000 000" value={phone} onChange={e => setPhone(e.target.value)} /></div>
            <div style={{ flex: 1, minWidth: 150 }}><label className="label">{pt('staffName', locale)}</label><input className="input" value={name} onChange={e => setName(e.target.value)} /></div>
            <div><label className="label">{pt('role', locale)}</label><div className="seg">{ROLES.map(r => <button key={r} className={role === r ? 'active' : ''} onClick={() => setRole(r)}>{pt(`role_${r}` as 'role_owner', locale)}</button>)}</div></div>
            <button className="btn primary" disabled={busy || phone.replace(/\D/g, '').length < 8} onClick={add}>{pt('add', locale)}</button>
          </div>
          {msg && <p className="muted" style={{ margin: '8px 0 0' }}>{msg}{lastInvite && <> · <a href={waLink(lastInvite.phone, lastInvite.name)} target="_blank" rel="noreferrer">💬 {pt('sendInvite', locale)}</a></>}</p>}
        </div>
      ) : <p className="muted" style={{ fontSize: 12 }}>{pt('needOnline', locale)}</p>}
    </div>
  );
}
