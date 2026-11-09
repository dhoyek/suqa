'use client';
import { useMemo, useState } from 'react';
import { t as tr, type LocalizedText } from '@suqa/shared';

export type Account = {
  id: string; name: string | null; phone: string | null; email: string | null; created_at: string; last_sign_in_at: string | null;
  tenant_role: string | null; shops: { shop_id: string; name: LocalizedText; role: string; active: boolean }[]; driver_for: LocalizedText[]; courier: boolean; orders: number; pending_requests: number;
};
type Labels = Record<'accounts' | 'search' | 'all' | 'admins' | 'staff' | 'drivers' | 'customers' | 'lastSeen' | 'orders' | 'pending' | 'noRole' | 'count', string>;
type Kind = 'all' | 'admins' | 'staff' | 'drivers' | 'customers';

export default function AccountsList({ initial, locale: L, labels }: { initial: Account[]; locale: 'ar' | 'en'; labels: Labels }) {
  const [q, setQ] = useState(''); const [kind, setKind] = useState<Kind>('all');
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
    return initial.filter(a => (kind === 'all' || kindOf(a).includes(kind))
      && (!n || (a.name ?? '').toLowerCase().includes(n) || (a.email ?? '').toLowerCase().includes(n) || (d.length >= 3 && (a.phone ?? '').includes(d))));
  }, [initial, q, kind]);
  const when = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(L === 'ar' ? 'ar-LB' : 'en-GB', { day: 'numeric', month: 'short' }) : '—';
  const roleAr: Record<string, string> = { owner: L === 'ar' ? 'صاحب' : 'owner', cashier: L === 'ar' ? 'كاشير' : 'cashier', staff: L === 'ar' ? 'كاشير' : 'cashier', stock: L === 'ar' ? 'مخزون' : 'stock', admin: L === 'ar' ? 'مدير' : 'admin', viewer: L === 'ar' ? 'مشاهد' : 'viewer' };
  const KINDS: Kind[] = ['all', 'admins', 'staff', 'drivers', 'customers'];
  return (
    <section className="card stack">
      <div className="row spread" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>{labels.accounts} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>· {rows.length} {labels.count}</span></h2>
        <input className="input" style={{ maxWidth: 320 }} placeholder={labels.search} value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <nav className="row chips">{KINDS.map(k => <button type="button" key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{labels[k]} ({k === 'all' ? initial.length : initial.filter(a => kindOf(a).includes(k)).length})</button>)}</nav>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th style={{ textAlign: 'start' }}>{L === 'ar' ? 'الاسم' : 'Name'}</th><th style={{ textAlign: 'start' }}>{L === 'ar' ? 'الرقم' : 'Phone'}</th><th style={{ textAlign: 'start' }}>{L === 'ar' ? 'الأدوار' : 'Roles'}</th><th>{labels.orders}</th><th>{labels.lastSeen}</th></tr></thead>
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
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="muted">—</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
