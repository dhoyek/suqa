'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { t as tr, type LocalizedText } from '@suqa/shared';

export type Account = {
  id: string; name: string | null; phone: string | null; email: string | null; created_at: string; last_sign_in_at: string | null;
  tenant_role: string | null; shops: { shop_id: string; name: LocalizedText; role: string; active: boolean }[]; driver_for: LocalizedText[]; courier: boolean; orders: number; pending_requests: number;
  blocked?: boolean; deleted?: boolean;
};
export type ShopBrief = { id: string; name: LocalizedText; pos: boolean };
type Labels = Record<'accounts' | 'search' | 'all' | 'admins' | 'staff' | 'drivers' | 'customers' | 'lastSeen' | 'orders' | 'pending' | 'noRole' | 'count' | 'edit' | 'name' | 'phone' | 'save' | 'cancel' | 'phoneTaken' | 'saved'
  | 'roles' | 'assocRole' | 'none' | 'tenantAdmin' | 'tenantOps' | 'block' | 'unblock' | 'blocked' | 'deleted' | 'delete' | 'merge' | 'mergeInto' | 'confirmDelete' | 'confirmMerge' | 'confirmBlock' | 'roleOwner' | 'roleCashier' | 'roleStock' | 'shopRoles' | 'mergeHint' | 'deleteHint'
  | 'signoutAll' | 'resetPin' | 'activity' | 'exportCsv' | 'inviteAccount' | 'inviteHint' | 'pendingInvites' | 'invited' | 'applied' | 'confirmSignout' | 'confirmResetPin' | 'add', string>;
type Kind = 'all' | 'admins' | 'staff' | 'drivers' | 'customers';

type Invite = { id: string; kind: 'tenant' | 'shop'; phone: string; name: string | null; role: string; shop?: LocalizedText; created_at: string };
export default function AccountsList({ initial, locale: L, labels, tenantId, canEdit, shops, invites: invites0 }: { initial: Account[]; locale: 'ar' | 'en'; labels: Labels; tenantId: string; canEdit: boolean; shops: ShopBrief[]; invites: Invite[] }) {
  const [invites, setInvites] = useState<Invite[]>(invites0);
  const [inv, setInv] = useState(false); const [iPhone, setIPhone] = useState(''); const [iName, setIName] = useState(''); const [iTenant, setITenant] = useState(''); const [iShop, setIShop] = useState(''); const [iShopRole, setIShopRole] = useState('cashier'); const [iMsg, setIMsg] = useState<string | null>(null);
  const sb = useMemo(() => supabaseBrowser(), []);
  const [list, setList] = useState<Account[]>(initial);
  const [roles, setRoles] = useState<Account | null>(null);
  const [q, setQ] = useState(''); const [kind, setKind] = useState<Kind>('all');
  const [edit, setEdit] = useState<Account | null>(null); const [eName, setEName] = useState(''); const [ePhone, setEPhone] = useState(''); const [eErr, setEErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [mergeFrom, setMergeFrom] = useState<Account | null>(null); const [mergeTo, setMergeTo] = useState<string>('');
  const [confirm, setConfirm] = useState<{ text: string; run: () => Promise<void> } | null>(null);
  const reload = async () => { const { data } = await sb.rpc('tenant_accounts', { p_tenant: tenantId }); if (data) setList(data as Account[]); };
  const call = async (fn: string, args: Record<string, unknown>) => { setBusy(true); setEErr(null); const { error } = await sb.rpc(fn, args); setBusy(false); if (error) { setMsg(null); setEErr(error.message); return false; } await reload(); setMsg(labels.saved); setTimeout(() => setMsg(null), 2500); return true; };
  const reloadInvites = async () => { const { data } = await sb.rpc('admin_account_invites', { p_tenant: tenantId }); if (data) setInvites(data as Invite[]); };
  const sendInvite = async () => {
    setBusy(true); setIMsg(null); setEErr(null);
    const { data, error } = await sb.rpc('admin_account_invite', { p_tenant: tenantId, p_phone: iPhone, p_name: iName || null, p_tenant_role: iTenant || null, p_shop: iShop || null, p_shop_role: iShop ? iShopRole : null });
    setBusy(false);
    if (error) { setEErr(error.message); return; }
    setIMsg((data as { status: string }).status === 'applied' ? labels.applied : labels.invited); setIPhone(''); setIName(''); setITenant(''); setIShop('');
    await Promise.all([reload(), reloadInvites()]);
  };
  const signout = (a: Account) => setConfirm({ text: `${labels.signoutAll}: ${a.name || a.phone || ''}? ${labels.confirmSignout}`, run: async () => { await call('admin_account_signout', { p_tenant: tenantId, p_user: a.id }); } });
  const resetPin = (a: Account) => setConfirm({ text: `${labels.resetPin}: ${a.name || a.phone || ''}? ${labels.confirmResetPin}`, run: async () => { await call('admin_account_reset_pin', { p_tenant: tenantId, p_user: a.id }); } });
  const block = (a: Account) => setConfirm({ text: `${a.blocked ? labels.unblock : labels.block}: ${a.name || a.phone || ''}?${a.blocked ? '' : ' ' + labels.confirmBlock}`, run: async () => { await call('admin_account_block', { p_tenant: tenantId, p_user: a.id, p_block: !a.blocked }); } });
  const del = (a: Account) => setConfirm({ text: `${labels.delete}: ${a.name || a.phone || ''}? ${labels.confirmDelete}`, run: async () => { await call('admin_account_delete', { p_tenant: tenantId, p_user: a.id }); } });
  const doMerge = () => { if (!mergeFrom || !mergeTo) return; const keep = list.find(x => x.id === mergeTo); setConfirm({ text: `${labels.merge}: ${mergeFrom.name || mergeFrom.phone} → ${keep?.name || keep?.phone}? ${labels.confirmMerge}`, run: async () => { if (await call('admin_account_merge', { p_tenant: tenantId, p_keep: mergeTo, p_dup: mergeFrom.id })) { setMergeFrom(null); setMergeTo(''); } } }); };
  const openEdit = (a: Account) => { setEdit(a); setEName(a.name ?? ''); setEPhone(a.phone ? `+${a.phone.replace(/^\+/, '')}` : ''); setEErr(null); };
  const save = async () => {
    if (!edit || busy) return; setBusy(true); setEErr(null);
    const phoneChanged = ePhone.replace(/\D/g, '') !== (edit.phone ?? '').replace(/\D/g, '');
    const { data, error } = await sb.rpc('admin_account_update', { p_tenant: tenantId, p_user: edit.id, p_name: eName, p_phone: phoneChanged ? ePhone : null });
    setBusy(false);
    if (error) { setEErr(/phone_taken/.test(error.message) ? labels.phoneTaken : error.message); return; }
    const np = (data as { phone?: string | null })?.phone ?? edit.phone;
    setList(l => l.map(a => a.id === edit.id ? { ...a, name: eName.trim() || null, phone: np ? np.replace(/^\+/, '') : a.phone } : a));
    setEdit(null); setMsg(labels.saved); setTimeout(() => setMsg(null), 2500);
  };
  const kindOf = (a: Account): Kind[] => {
    const k: Kind[] = [];
    if (a.tenant_role) k.push('admins');
    if (a.shops.some(s => s.active)) k.push('staff');
    if (a.driver_for.length || a.courier) k.push('drivers');
    if (!k.length) k.push('customers');
    return k;
  };
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase(); const d = q.replace(/\D/g, '');
    return list.filter(a => (kind === 'all' || kindOf(a).includes(kind))
      && (!n || (a.name ?? '').toLowerCase().includes(n) || (a.email ?? '').toLowerCase().includes(n) || (d.length >= 3 && (a.phone ?? '').includes(d))));
  }, [list, q, kind]);
  const when = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(L === 'ar' ? 'ar-LB' : 'en-GB', { day: 'numeric', month: 'short' }) : '—';
  const roleAr: Record<string, string> = { owner: L === 'ar' ? 'صاحب' : 'owner', cashier: L === 'ar' ? 'كاشير' : 'cashier', staff: L === 'ar' ? 'كاشير' : 'cashier', stock: L === 'ar' ? 'مخزون' : 'stock', admin: L === 'ar' ? 'مدير' : 'admin', viewer: L === 'ar' ? 'مشاهد' : 'viewer' };
  const KINDS: Kind[] = ['all', 'admins', 'staff', 'drivers', 'customers'];
  return (
    <section className="card stack">
      <div className="row spread" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>{labels.accounts} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>· {rows.length} {labels.count}</span></h2>
        <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input" style={{ maxWidth: 320 }} placeholder={labels.search} value={q} onChange={e => setQ(e.target.value)} />
          {canEdit && <button type="button" className="btn" onClick={() => setInv(v => !v)}>➕ {labels.inviteAccount}</button>}
          {canEdit && <a className="btn" href="/api/admin/accounts.csv">⬇ {labels.exportCsv}</a>}
        </div>
      </div>
      {inv && canEdit && (
        <div className="card stack" style={{ background: '#f8fafc' }}>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{labels.inviteHint}</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input className="input" style={{ flex: 1, minWidth: 160 }} dir="ltr" inputMode="tel" placeholder="+961 70 000 000" value={iPhone} onChange={e => setIPhone(e.target.value)} />
            <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder={labels.name} value={iName} onChange={e => setIName(e.target.value)} />
            <select className="input" style={{ width: 'auto' }} value={iTenant} onChange={e => setITenant(e.target.value)}><option value="">{labels.assocRole}: {labels.none}</option><option value="ops">{labels.tenantOps}</option><option value="admin">{labels.tenantAdmin}</option></select>
            <select className="input" style={{ width: 'auto' }} value={iShop} onChange={e => setIShop(e.target.value)}><option value="">{labels.shopRoles}: {labels.none}</option>{shops.filter(s => s.pos).map(s => <option key={s.id} value={s.id}>{tr(s.name, L)}</option>)}</select>
            {iShop && <select className="input" style={{ width: 'auto' }} value={iShopRole} onChange={e => setIShopRole(e.target.value)}><option value="owner">{labels.roleOwner}</option><option value="cashier">{labels.roleCashier}</option><option value="stock">{labels.roleStock}</option></select>}
            <button type="button" className="btn primary" disabled={busy || iPhone.replace(/\D/g, '').length < 8 || (!iTenant && !iShop)} onClick={sendInvite}>{labels.add}</button>
          </div>
          {iMsg && <p className="muted" style={{ margin: 0 }}>✓ {iMsg}</p>}
          {invites.length > 0 && <div className="stack" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 12 }}>{labels.pendingInvites} ({invites.length})</span>
            {invites.map(i => <div key={i.id} className="row spread" style={{ alignItems: 'center', fontSize: 13 }}>
              <span><strong dir="ltr">+{i.phone}</strong> {i.name ? `· ${i.name}` : ''} · {i.kind === 'tenant' ? `🛠️ ${i.role}` : `🏪 ${i.shop ? tr(i.shop, L) : ''} · ${i.role}`}</span>
              <button type="button" className="btn ghost" disabled={busy} onClick={async () => { await sb.rpc('admin_account_invite_cancel', { p_tenant: tenantId, p_kind: i.kind, p_id: i.id }); await reloadInvites(); }}>✕</button>
            </div>)}
          </div>}
        </div>
      )}
      <nav className="row chips">{KINDS.map(k => <button type="button" key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{labels[k]} ({k === 'all' ? list.length : list.filter(a => kindOf(a).includes(k)).length})</button>)}</nav>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th style={{ textAlign: 'start' }}>{L === 'ar' ? 'الاسم' : 'Name'}</th><th style={{ textAlign: 'start' }}>{L === 'ar' ? 'الرقم' : 'Phone'}</th><th style={{ textAlign: 'start' }}>{L === 'ar' ? 'الأدوار' : 'Roles'}</th><th>{labels.orders}</th><th>{labels.lastSeen}</th>{canEdit && <th />}</tr></thead>
          <tbody>
            {rows.map(a => (
              <tr key={a.id}>
                <td><strong>{a.name || '—'}</strong>{a.email && <div className="muted" dir="ltr" style={{ fontSize: 12 }}>{a.email}</div>}</td>
                <td dir="ltr">{a.phone ? `+${a.phone.replace(/^\+/, '')}` : '—'}</td>
                <td>
                  <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    {a.tenant_role && <span className="badge">🛠️ {roleAr[a.tenant_role] ?? a.tenant_role}</span>}
                    {a.shops.filter(s => s.active).map(s => <span key={s.shop_id} className="badge">🏪 {tr(s.name, L)} · {roleAr[s.role] ?? s.role}</span>)}
                    {a.driver_for.map((n, i) => <span key={i} className="badge">🛵 {tr(n, L)}</span>)}
                    {a.courier && <span className="badge">🛵 {L === 'ar' ? 'موصّل الجمعية' : 'association courier'}</span>}
                    {a.pending_requests > 0 && <span className="badge pending">⏳ {labels.pending}</span>}
                    {a.blocked && !a.deleted && <span className="badge" style={{ background: '#fee2e2', color: '#991b1b' }}>⛔ {labels.blocked}</span>}
                    {a.deleted && <span className="badge" style={{ background: '#e5e7eb' }}>🗑 {labels.deleted}</span>}
                    {!a.tenant_role && !a.shops.some(s => s.active) && !a.driver_for.length && !a.courier && <span className="muted" style={{ fontSize: 12 }}>{labels.noRole}</span>}
                  </div>
                </td>
                <td className="num">{a.orders || ''}</td>
                <td className="muted" style={{ textAlign: 'center' }}>{when(a.last_sign_in_at)}</td>
                {canEdit && <td style={{ whiteSpace: 'nowrap' }}>{!a.deleted && <>
                  <button type="button" className="btn ghost" title={labels.edit} onClick={() => openEdit(a)}>✎</button>
                  <Link href={`/admin/accounts/${a.id}`} className="btn ghost" title={labels.activity}>📋</Link>
                  <button type="button" className="btn ghost" title={labels.roles} onClick={() => setRoles(a)}>🎖️</button>
                  <button type="button" className="btn ghost" title={labels.signoutAll} onClick={() => signout(a)}>⎋</button>
                  {a.shops.some(s => s.active) && <button type="button" className="btn ghost" title={labels.resetPin} onClick={() => resetPin(a)}>🔢</button>}
                  <button type="button" className="btn ghost" title={a.blocked ? labels.unblock : labels.block} onClick={() => block(a)}>{a.blocked ? '🔓' : '⛔'}</button>
                  <button type="button" className="btn ghost" title={labels.merge} onClick={() => { setMergeFrom(a); setMergeTo(''); }}>⇄</button>
                  <button type="button" className="btn ghost" title={labels.delete} onClick={() => del(a)}>🗑</button>
                </>}</td>}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="muted">—</td></tr>}
          </tbody>
        </table>
      </div>
      {msg && <p className="muted" style={{ margin: 0 }}>✓ {msg}</p>}
      {eErr && !edit && <p className="bad" style={{ margin: 0 }}>{eErr}</p>}
      {roles && (
        <div className="sheet-backdrop" onClick={e => { if (e.target === e.currentTarget) setRoles(null); }}>
          <div className="sheet card" role="dialog">
            <div className="row spread" style={{ alignItems: 'center' }}><strong>🎖️ {labels.roles} — {roles.name || roles.phone}</strong><button type="button" className="btn ghost" onClick={() => setRoles(null)}>✕</button></div>
            <label className="label">{labels.assocRole}
              <select className="input" value={roles.tenant_role ?? ''} disabled={busy} onChange={async e => { const v = e.target.value || null; if (await call('admin_account_set_tenant_role', { p_tenant: tenantId, p_user: roles.id, p_role: v })) setRoles(r => r && { ...r, tenant_role: v }); }}>
                <option value="">{labels.none}</option><option value="ops">{labels.tenantOps}</option><option value="admin">{labels.tenantAdmin}</option>
              </select></label>
            <div className="label">{labels.shopRoles}</div>
            <div className="stack" style={{ gap: 6 }}>
              {shops.filter(s => s.pos).map(s => { const m = roles.shops.find(x => x.shop_id === s.id && x.active); return (
                <div key={s.id} className="row spread" style={{ alignItems: 'center', gap: 8 }}>
                  <span>🏪 {tr(s.name, L)}</span>
                  <select className="input" style={{ width: 'auto' }} value={m?.role === 'staff' ? 'cashier' : (m?.role ?? '')} disabled={busy} onChange={async e => { const v = e.target.value || null; if (await call('admin_account_set_shop_role', { p_tenant: tenantId, p_user: roles.id, p_shop: s.id, p_role: v })) setRoles(r => r && { ...r, shops: [...r.shops.filter(x => x.shop_id !== s.id), ...(v ? [{ shop_id: s.id, name: s.name, role: v, active: true }] : [])] }); }}>
                    <option value="">{labels.none}</option><option value="owner">{labels.roleOwner}</option><option value="cashier">{labels.roleCashier}</option><option value="stock">{labels.roleStock}</option>
                  </select>
                </div>); })}
            </div>
            {eErr && <p className="bad" style={{ margin: 0 }}>{eErr}</p>}
          </div>
        </div>
      )}
      {mergeFrom && (
        <div className="sheet-backdrop" onClick={e => { if (e.target === e.currentTarget) setMergeFrom(null); }}>
          <div className="sheet card" role="dialog">
            <div className="row spread" style={{ alignItems: 'center' }}><strong>⇄ {labels.merge}: {mergeFrom.name || mergeFrom.phone}</strong><button type="button" className="btn ghost" onClick={() => setMergeFrom(null)}>✕</button></div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{labels.mergeHint}</p>
            <label className="label">{labels.mergeInto}
              <select className="input" value={mergeTo} onChange={e => setMergeTo(e.target.value)}>
                <option value="">—</option>
                {list.filter(x => x.id !== mergeFrom.id && !x.deleted).map(x => <option key={x.id} value={x.id}>{x.name || '—'} {x.phone ? `+${x.phone}` : x.email ?? ''}</option>)}
              </select></label>
            <div className="row spread"><button type="button" className="btn" onClick={() => setMergeFrom(null)}>{labels.cancel}</button><button type="button" className="btn primary" disabled={!mergeTo || busy} onClick={doMerge}>{labels.merge}</button></div>
          </div>
        </div>
      )}
      {confirm && (
        <div className="sheet-backdrop" onClick={e => { if (e.target === e.currentTarget) setConfirm(null); }}>
          <div className="sheet card" role="dialog">
            <p style={{ margin: 0 }}>{confirm.text}</p>
            <div className="row spread"><button type="button" className="btn" onClick={() => setConfirm(null)}>{labels.cancel}</button><button type="button" className="btn primary" disabled={busy} onClick={async () => { await confirm.run(); setConfirm(null); }}>{labels.save}</button></div>
          </div>
        </div>
      )}
      {edit && (
        <div className="sheet-backdrop" onClick={e => { if (e.target === e.currentTarget) setEdit(null); }}>
          <div className="sheet card" role="dialog">
            <div className="row spread" style={{ alignItems: 'center' }}><strong>✎ {edit.name || edit.phone || ''}</strong><button type="button" className="btn ghost" onClick={() => setEdit(null)}>✕</button></div>
            <label className="label">{labels.name}<input className="input" value={eName} onChange={e => setEName(e.target.value)} autoFocus /></label>
            <label className="label">{labels.phone}<input className="input" dir="ltr" inputMode="tel" value={ePhone} onChange={e => setEPhone(e.target.value)} placeholder="+961 70 000 000" /></label>
            {edit.email && <p className="muted" dir="ltr" style={{ margin: 0, fontSize: 12 }}>{edit.email}</p>}
            {eErr && <p className="bad" style={{ margin: 0 }}>{eErr}</p>}
            <div className="row spread"><button type="button" className="btn" onClick={() => setEdit(null)}>{labels.cancel}</button><button type="button" className="btn primary" disabled={busy || (!eName.trim() && !ePhone.trim())} onClick={save}>{labels.save}</button></div>
          </div>
        </div>
      )}
    </section>
  );
}
