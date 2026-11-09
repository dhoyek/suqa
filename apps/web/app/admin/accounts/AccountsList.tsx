'use client';
import { useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { t as tr, type LocalizedText } from '@suqa/shared';

export type Account = {
  id: string; name: string | null; phone: string | null; email: string | null; created_at: string; last_sign_in_at: string | null;
  tenant_role: string | null; shops: { shop_id: string; name: LocalizedText; role: string; active: boolean }[]; driver_for: LocalizedText[]; courier: boolean; orders: number; pending_requests: number;
};
type Labels = Record<'accounts' | 'search' | 'all' | 'admins' | 'staff' | 'drivers' | 'customers' | 'lastSeen' | 'orders' | 'pending' | 'noRole' | 'count' | 'edit' | 'name' | 'phone' | 'save' | 'cancel' | 'phoneTaken' | 'saved', string>;
type Kind = 'all' | 'admins' | 'staff' | 'drivers' | 'customers';

export default function AccountsList({ initial, locale: L, labels, tenantId, canEdit }: { initial: Account[]; locale: 'ar' | 'en'; labels: Labels; tenantId: string; canEdit: boolean }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [list, setList] = useState<Account[]>(initial);
  const [q, setQ] = useState(''); const [kind, setKind] = useState<Kind>('all');
  const [edit, setEdit] = useState<Account | null>(null); const [eName, setEName] = useState(''); const [ePhone, setEPhone] = useState(''); const [eErr, setEErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
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
        <input className="input" style={{ maxWidth: 320 }} placeholder={labels.search} value={q} onChange={e => setQ(e.target.value)} />
      </div>
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
                    {!a.tenant_role && !a.shops.some(s => s.active) && !a.driver_for.length && !a.courier && <span className="muted" style={{ fontSize: 12 }}>{labels.noRole}</span>}
                  </div>
                </td>
                <td className="num">{a.orders || ''}</td>
                <td className="muted" style={{ textAlign: 'center' }}>{when(a.last_sign_in_at)}</td>
                {canEdit && <td><button type="button" className="btn ghost" title={labels.edit} onClick={() => openEdit(a)}>✎</button></td>}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="muted">—</td></tr>}
          </tbody>
        </table>
      </div>
      {msg && <p className="muted" style={{ margin: 0 }}>✓ {msg}</p>}
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
