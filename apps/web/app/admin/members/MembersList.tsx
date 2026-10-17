'use client';
import { useConfirm } from '@/components/ConfirmProvider';
import { useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

type Person = { user_id: string; full_name: string | null; email: string; phone: string | null; tenant_role: 'admin' | 'ops' | null; shop_id: string | null; shop_role: 'owner' | 'staff' | null; shop_name: string | null };
type Labels = Record<'members' | 'addByEmail' | 'userNotFound' | 'tenantAdmin' | 'tenantOps' | 'owner' | 'staff' | 'remove', string>;

export default function MembersList({ tenantId, canEdit, initial, labels }: { tenantId: string; canEdit: boolean; initial: Person[]; labels: Labels }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [people, setPeople] = useState(initial);
  const ask = useConfirm();
  const [email, setEmail] = useState(''); const [role, setRole] = useState<'admin' | 'ops'>('ops');
  const staff = people.filter(p => p.tenant_role);
  const shopPeople = people.filter(p => p.shop_id);

  async function reload() { const { data } = await sb.rpc('tenant_people', { p_tenant: tenantId }); if (data) setPeople((data as any[]).map(p => ({ ...p, shop_name: people.find(x => x.shop_id === p.shop_id)?.shop_name ?? null }))); }
  async function add() {
    const { data } = await sb.rpc('find_user_by_email', { p_tenant: tenantId, p_email: email });
    const u = Array.isArray(data) ? data[0] : data;
    if (!u) { alert(labels.userNotFound); return; }
    const { error } = await sb.from('tenant_members').upsert({ tenant_id: tenantId, user_id: u.user_id, role });
    if (error) { alert(error.message); return; }
    setEmail(''); reload();
  }
  async function remove(p: Person) {
    if (!(await ask(`${labels.remove} ${p.email}?`, { danger: true }))) return;
    const { error } = await sb.from('tenant_members').delete().eq('tenant_id', tenantId).eq('user_id', p.user_id);
    if (error) { alert(error.message); return; }
    reload();
  }

  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{labels.members}</h1>
      <section className="card stack">
        {staff.map(p => (
          <div className="row spread" key={p.user_id}>
            <span>{p.full_name || '—'} <span className="muted" style={{ fontSize: 13 }}>{p.email}{p.phone ? ` · ${p.phone}` : ''}</span></span>
            <span className="row"><span className="badge">{p.tenant_role === 'admin' ? labels.tenantAdmin : labels.tenantOps}</span>{canEdit && <button className="btn ghost muted" onClick={() => remove(p)}>✕</button>}</span>
          </div>
        ))}
        {canEdit && (
          <div className="row">
            <input className="input" style={{ flex: 1 }} dir="ltr" type="email" placeholder={labels.addByEmail} value={email} onChange={e => setEmail(e.target.value)} />
            <select className="input" style={{ width: 'auto' }} value={role} onChange={e => setRole(e.target.value as any)}><option value="ops">{labels.tenantOps}</option><option value="admin">{labels.tenantAdmin}</option></select>
            <button className="btn" disabled={!email.trim()} onClick={add}>+</button>
          </div>
        )}
      </section>
      <section className="card">
        {shopPeople.map(p => (
          <div className="product" key={`${p.user_id}-${p.shop_id}`}>
            <div style={{ flex: 1 }}><div className="name">{p.full_name || '—'}</div><div className="muted" style={{ fontSize: 13 }}>{p.email}{p.phone ? ` · ${p.phone}` : ''}</div></div>
            <span className="muted" style={{ fontSize: 13 }}>{p.shop_name}</span>
            <span className="badge">{p.shop_role === 'owner' ? labels.owner : labels.staff}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
