'use client';
import { useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { t as tr, type LocalizedText } from '@suqa/shared';
import { intlPhone } from '@suqa/pos-core';

export type DriverRow = { id: string; shop_id: string; shop: LocalizedText; name: string; phone: string | null; phone_key: string | null; vehicle: string | null; active: boolean; scope: 'shop' | 'association'; has_account: boolean; last_used_at: string | null };
export type CourierRow = { user_id: string; name: string | null; phone: string | null; vehicle: string | null; active: boolean };
type Filter = 'all' | 'association' | 'shop';
/** One person = one phone number; a line per shop he works for. */
type Person = { key: string; name: string; phone: string | null; vehicle: string | null; has_account: boolean; rows: DriverRow[] };

const TXT = {
  title: { ar: 'السائقون', en: 'Drivers' },
  hint: { ar: 'كل سائق مرة واحدة (حسب رقمه) مع المحلات التي يعمل لها. «للمحل فقط» = يعمل لذلك المحل فقط. «للجمعية» = يظهر للمحلات الأخرى في «دليل الجمعية» ويمكنها إضافته.', en: 'Each driver once (by his number) with the shops he works for. "Shop only" = works for that shop only. "Association" = other shops see him in the association directory and can add him.' },
  search: { ar: 'ابحث بالاسم أو الرقم أو المحل…', en: 'Search by name, number or shop…' },
  all: { ar: 'الكل', en: 'All' }, shared: { ar: 'للجمعية', en: 'Association' }, shopOnly: { ar: 'للمحل فقط', en: 'Shop only' },
  inactive: { ar: 'متوقف', en: 'Inactive' }, account: { ar: 'له حساب', en: 'Has an account' }, none: { ar: 'لا يوجد سائقون', en: 'No drivers' },
  couriers: { ar: 'مندوبو الجمعية', en: 'Association couriers' }, couriersHint: { ar: 'يعملون للجمعية كلها ويُدارون من «الأعضاء».', en: 'They work for the whole association and are managed in Members.' },
  readOnly: { ar: 'للمشاهدة فقط — التغيير لمدير الجمعية.', en: 'View only — changes are for the association admin.' },
  failed: { ar: 'لم يتم الحفظ', en: 'Not saved' }, edit: { ar: 'تعديل', en: 'Edit' }, editTitle: { ar: 'تعديل بيانات السائق', en: 'Edit driver' },
  editHint: { ar: 'يُحفظ التعديل في كل المحلات التي يعمل لها.', en: 'The change is saved in every shop he works for.' },
  name: { ar: 'الاسم', en: 'Name' }, phone: { ar: 'رقم الهاتف', en: 'Phone' }, vehicle: { ar: 'المركبة', en: 'Vehicle' }, save: { ar: 'حفظ', en: 'Save' }, cancel: { ar: 'إلغاء', en: 'Cancel' },
  phoneTaken: { ar: 'أحد محلاته لديه سائق آخر بهذا الرقم.', en: 'One of his shops already has another driver with this number.' },
  badPhone: { ar: 'رقم غير صالح.', en: 'Not a valid number.' }, badName: { ar: 'الاسم مطلوب.', en: 'A name is needed.' },
  notOn: { ar: 'التعديل غير مفعّل بعد (السكريبت 117).', en: 'Editing is not switched on yet (script 117).' },
  otherNames: { ar: 'مسجّل أيضاً باسم', en: 'Also saved as' },
} as const;

export default function DriversList({ initial, couriers, locale: L, canEdit, tenantId }: { initial: DriverRow[]; couriers: CourierRow[]; locale: 'ar' | 'en'; canEdit: boolean; tenantId: string }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const x = (k: keyof typeof TXT) => TXT[k][L];
  const [list, setList] = useState<DriverRow[]>(initial);
  const [q, setQ] = useState(''); const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const [edit, setEdit] = useState<Person | null>(null); const [eName, setEName] = useState(''); const [ePhone, setEPhone] = useState(''); const [eVehicle, setEVehicle] = useState(''); const [eErr, setEErr] = useState<string | null>(null); const [saving, setSaving] = useState(false);

  const people = useMemo(() => {
    const m = new Map<string, Person>();
    for (const d of list) {
      const key = d.phone_key || d.id;
      const p = m.get(key);
      if (p) { p.rows.push(d); p.has_account ||= d.has_account; p.vehicle ??= d.vehicle; }
      else m.set(key, { key, name: d.name, phone: d.phone, vehicle: d.vehicle, has_account: d.has_account, rows: [d] });
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [list]);

  const setScope = async (d: DriverRow, scope: 'shop' | 'association') => {
    if (!canEdit || d.scope === scope || busy) return;
    setBusy(d.id); setMsg(null);
    const { error } = await sb.rpc('admin_driver_scope', { p_driver: d.id, p_scope: scope });
    if (error) setMsg(`${x('failed')}: ${error.message}`);
    else setList(l => l.map(r => r.id === d.id ? { ...r, scope } : r));
    setBusy(null);
  };

  const openEdit = (p: Person) => { setEdit(p); setEName(p.name); setEPhone(p.phone ?? ''); setEVehicle(p.vehicle ?? ''); setEErr(null); };
  const saveEdit = async () => {
    if (!edit || saving) return;
    const name = eName.trim(); const phone = intlPhone(ePhone); const vehicle = eVehicle.trim();
    if (!name) { setEErr(x('badName')); return; }
    const patch: Record<string, string> = {};
    if (name !== edit.name || edit.rows.some(r => r.name !== name)) patch.name = name;
    if (phone !== (edit.phone ?? '')) patch.phone = phone;
    if (vehicle !== (edit.vehicle ?? '') || edit.rows.some(r => (r.vehicle ?? '') !== vehicle)) patch.vehicle = vehicle;
    if (!Object.keys(patch).length) { setEdit(null); return; }
    setSaving(true); setEErr(null);
    const { data, error } = await sb.rpc('admin_driver_update', { p_tenant: tenantId, p_phone_key: edit.key, p_patch: patch });
    setSaving(false);
    if (error) {
      const m = error.message;
      setEErr(/phone_taken/.test(m) ? x('phoneTaken') : /bad_phone/.test(m) ? x('badPhone') : /bad_name/.test(m) ? x('badName')
        : /PGRST202|schema cache|admin_driver_update/i.test(`${error.code ?? ''} ${m}`) ? x('notOn') : `${x('failed')}: ${m}`);
      return;
    }
    const newKey = (data as { phone_key?: string } | null)?.phone_key ?? edit.key;
    const ids = new Set(edit.rows.map(r => r.id));
    setList(l => l.map(r => ids.has(r.id) ? { ...r, ...(patch.name !== undefined ? { name } : {}), ...(patch.phone !== undefined ? { phone, phone_key: newKey } : {}), ...(patch.vehicle !== undefined ? { vehicle: vehicle || null } : {}) } : r));
    setEdit(null);
  };

  const needle = q.trim().toLowerCase(); const digits = needle.replace(/\D/g, '');
  const shown = people.filter(p => (filter === 'all' || p.rows.some(r => r.scope === filter))
    && (!needle || p.rows.some(r => r.name.toLowerCase().includes(needle) || tr(r.shop, L).toLowerCase().includes(needle)) || (digits.length >= 3 && (p.phone ?? '').replace(/\D/g, '').includes(digits))));
  const count = (f: Filter) => f === 'all' ? people.length : people.filter(p => p.rows.some(r => r.scope === f)).length;

  return (
    <div className="stack" style={{ display: 'grid', gap: 12 }}>
      <h2 style={{ margin: 0 }}>🛵 {x('title')} <small className="muted">({people.length})</small></h2>
      <small className="muted">{x('hint')}{!canEdit && <> {x('readOnly')}</>}</small>
      <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder={x('search')} />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {(['all', 'association', 'shop'] as Filter[]).map(f => (
          <button key={f} type="button" className="chip" style={filter === f ? { background: 'var(--brand-primary)', color: '#fff', borderColor: 'var(--brand-primary)' } : undefined} onClick={() => setFilter(f)}>
            {f === 'all' ? x('all') : f === 'association' ? x('shared') : x('shopOnly')} ({count(f)})
          </button>))}
      </div>
      {msg && <div className="card bad">{msg}</div>}
      {shown.length === 0 && <div className="card muted">{x('none')}</div>}
      {shown.map(p => { const other = [...new Set(p.rows.map(r => r.name).filter(n => n !== p.name))]; return (
        <div key={p.key} className="card drv-person" style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{p.name} {p.has_account && <span title={x('account')}>👤</span>}</div>
              <div className="muted" style={{ fontSize: 14 }}>{p.phone && <bdi dir="ltr">{p.phone}</bdi>}{p.vehicle && <> · {p.vehicle}</>}</div>
              {other.length > 0 && <div className="muted" style={{ fontSize: 13 }}>{x('otherNames')}: {other.join('، ')}</div>}
            </div>
            {canEdit && <button type="button" className="btn" onClick={() => openEdit(p)}>✎ {x('edit')}</button>}
          </div>
          {p.rows.map(d => (
            <div key={d.id} className="drv-row" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 8, opacity: d.active ? 1 : .6 }}>
              <div style={{ flex: '1 1 160px', minWidth: 0 }}>🏪 {tr(d.shop, L)} {!d.active && <span className="badge cancelled">{x('inactive')}</span>}</div>
              <div className="seg" style={{ opacity: busy === d.id ? .5 : 1 }}>
                <button type="button" className={d.scope === 'shop' ? 'active' : ''} disabled={!canEdit || !!busy} onClick={() => void setScope(d, 'shop')}>{x('shopOnly')}</button>
                <button type="button" className={d.scope === 'association' ? 'active' : ''} disabled={!canEdit || !!busy} onClick={() => void setScope(d, 'association')}>{x('shared')}</button>
              </div>
            </div>))}
        </div>); })}
      {couriers.length > 0 && <>
        <h3 style={{ margin: '8px 0 0' }}>{x('couriers')} <small className="muted">({couriers.length})</small></h3>
        <small className="muted">{x('couriersHint')}</small>
        {couriers.map(c => (
          <div key={c.user_id} className="card" style={{ opacity: c.active ? 1 : .6 }}>
            <div style={{ fontWeight: 600 }}>{c.name ?? '—'} {!c.active && <span className="badge cancelled">{x('inactive')}</span>}</div>
            <div className="muted" style={{ fontSize: 14 }}>{c.phone && <bdi dir="ltr">{c.phone}</bdi>}{c.vehicle && <> · {c.vehicle}</>}</div>
          </div>))}
      </>}
      {edit && (
        <div className="drv-edit-back" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }} onClick={e => { if (e.target === e.currentTarget && !saving) setEdit(null); }}>
          <div className="card drv-edit" style={{ width: '100%', maxWidth: 420, display: 'grid', gap: 10 }}>
            <h3 style={{ margin: 0 }}>✎ {x('editTitle')}</h3>
            <small className="muted">{x('editHint')} ({edit.rows.map(r => tr(r.shop, L)).join('، ')})</small>
            <label style={{ display: 'grid', gap: 4 }}><span>{x('name')}</span><input className="input" value={eName} onChange={e => setEName(e.target.value)} /></label>
            <label style={{ display: 'grid', gap: 4 }}><span>{x('phone')}</span><input className="input" dir="ltr" inputMode="tel" value={ePhone} onChange={e => setEPhone(e.target.value)} onBlur={() => setEPhone(v => intlPhone(v))} /></label>
            <label style={{ display: 'grid', gap: 4 }}><span>{x('vehicle')}</span><input className="input" value={eVehicle} onChange={e => setEVehicle(e.target.value)} /></label>
            {eErr && <div className="card bad">{eErr}</div>}
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost" disabled={saving} onClick={() => setEdit(null)}>{x('cancel')}</button>
              <button type="button" className="btn primary" disabled={saving} onClick={() => void saveEdit()}>{x('save')}</button>
            </div>
          </div>
        </div>)}
    </div>
  );
}
