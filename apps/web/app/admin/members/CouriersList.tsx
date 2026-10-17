'use client';
import { useMemo, useState } from 'react';
import { useConfirm, useNotify } from '@/components/ConfirmProvider';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import type { Locale } from '@suqa/shared';

type Courier = { user_id: string; full_name: string | null; email: string; phone: string | null; is_active: boolean; vehicle: string | null; active_deliveries: number };
type Labels = Record<'couriers' | 'addByEmail' | 'userNotFound' | 'remove' | 'active' | 'activeDeliveries', string>;

export default function CouriersList({ tenantId, canEdit, initial, locale: L, labels }: { tenantId: string; canEdit: boolean; initial: Courier[]; locale: Locale; labels: Labels }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const notify = useNotify();
  const ask = useConfirm();
  const [list, setList] = useState(initial);
  const [email, setEmail] = useState('');

  async function reload() { const { data } = await sb.rpc('tenant_couriers', { p_tenant: tenantId }); if (data) setList(data as Courier[]); }
  async function add() {
    const { data } = await sb.rpc('find_user_by_email', { p_tenant: tenantId, p_email: email });
    const u = Array.isArray(data) ? data[0] : data;
    if (!u) { notify(labels.userNotFound); return; }
    const { error } = await sb.from('couriers').upsert({ tenant_id: tenantId, user_id: u.user_id, is_active: true });
    if (error) { notify(friendlyError(error, L)); return; }
    setEmail(''); reload();
  }
  async function toggle(c: Courier) {
    const { error } = await sb.from('couriers').update({ is_active: !c.is_active }).eq('tenant_id', tenantId).eq('user_id', c.user_id);
    if (error) notify(friendlyError(error, L)); else reload();
  }
  async function remove(c: Courier) {
    if (!(await ask(`${labels.remove} ${c.email}?`, { danger: true }))) return;
    const { error } = await sb.from('couriers').delete().eq('tenant_id', tenantId).eq('user_id', c.user_id);
    if (error) notify(friendlyError(error, L)); else reload();
  }

  return (
    <section className="card stack">
      <strong>🛵 {labels.couriers}</strong>
      {list.map(c => (
        <div className="row spread" key={c.user_id}>
          <span>{c.full_name || '—'} <span className="muted" style={{ fontSize: 13 }}>{c.email}{c.phone ? ` · ${c.phone}` : ''}</span>
            {c.active_deliveries > 0 && <span className="badge out_for_delivery" style={{ marginInlineStart: 6 }}>{c.active_deliveries} {labels.activeDeliveries}</span>}</span>
          <span className="row" style={{ gap: 6 }}>
            <button className={`switch ${c.is_active ? 'on' : ''}`} aria-pressed={c.is_active} aria-label={labels.active} disabled={!canEdit} onClick={() => toggle(c)} />
            {canEdit && <button className="btn ghost muted" onClick={() => remove(c)}>✕</button>}
          </span>
        </div>
      ))}
      {canEdit && (
        <div className="row">
          <input className="input" style={{ flex: 1 }} dir="ltr" type="email" placeholder={labels.addByEmail} value={email} onChange={e => setEmail(e.target.value)} />
          <button className="btn" disabled={!email.trim()} onClick={add}>+</button>
        </div>
      )}
    </section>
  );
}
