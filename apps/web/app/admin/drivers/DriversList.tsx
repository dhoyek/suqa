'use client';
import { useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { t as tr, type LocalizedText } from '@suqa/shared';

export type DriverRow = { id: string; shop_id: string; shop: LocalizedText; name: string; phone: string | null; phone_key: string | null; vehicle: string | null; active: boolean; scope: 'shop' | 'association'; has_account: boolean; last_used_at: string | null };
export type CourierRow = { user_id: string; name: string | null; phone: string | null; vehicle: string | null; active: boolean };
type Filter = 'all' | 'association' | 'shop';

const TXT = {
  title: { ar: 'السائقون', en: 'Drivers' },
  hint: { ar: 'كل سائقي المحلات. «للمحل فقط» = يعمل لمحله فقط. «للجمعية» = يظهر للمحلات الأخرى في «دليل الجمعية» ويمكنها إضافته.', en: 'Every shop\'s drivers. "Shop only" = works for his shop only. "Association" = other shops see him in the association directory and can add him.' },
  search: { ar: 'ابحث بالاسم أو الرقم أو المحل…', en: 'Search by name, number or shop…' },
  all: { ar: 'الكل', en: 'All' }, shared: { ar: 'للجمعية', en: 'Association' }, shopOnly: { ar: 'للمحل فقط', en: 'Shop only' },
  inactive: { ar: 'متوقف', en: 'Inactive' }, account: { ar: 'له حساب', en: 'Has an account' }, none: { ar: 'لا يوجد سائقون', en: 'No drivers' },
  couriers: { ar: 'مندوبو الجمعية', en: 'Association couriers' }, couriersHint: { ar: 'يعملون للجمعية كلها ويُدارون من «الأعضاء».', en: 'They work for the whole association and are managed in Members.' },
  readOnly: { ar: 'للمشاهدة فقط — التغيير لمدير الجمعية.', en: 'View only — changes are for the association admin.' },
  alsoAt: { ar: 'أيضاً في', en: 'Also at' }, failed: { ar: 'لم يتم الحفظ', en: 'Not saved' },
} as const;

export default function DriversList({ initial, couriers, locale: L, canEdit }: { initial: DriverRow[]; couriers: CourierRow[]; locale: 'ar' | 'en'; canEdit: boolean }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const x = (k: keyof typeof TXT) => TXT[k][L];
  const [list, setList] = useState<DriverRow[]>(initial);
  const [q, setQ] = useState(''); const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);

  const setScope = async (d: DriverRow, scope: 'shop' | 'association') => {
    if (!canEdit || d.scope === scope || busy) return;
    setBusy(d.id); setMsg(null);
    const { error } = await sb.rpc('admin_driver_scope', { p_driver: d.id, p_scope: scope });
    if (error) setMsg(`${x('failed')}: ${error.message}`);
    else setList(l => l.map(r => r.id === d.id ? { ...r, scope } : r));
    setBusy(null);
  };

  const needle = q.trim().toLowerCase(); const digits = needle.replace(/\D/g, '');
  const shown = list.filter(d => (filter === 'all' || d.scope === filter)
    && (!needle || d.name.toLowerCase().includes(needle) || tr(d.shop, L).toLowerCase().includes(needle) || (digits.length >= 3 && (d.phone ?? '').replace(/\D/g, '').includes(digits))));
  const count = (f: Filter) => f === 'all' ? list.length : list.filter(d => d.scope === f).length;
  // the same person (same number) with other shops
  const others = (d: DriverRow) => d.phone_key ? list.filter(o => o.id !== d.id && o.phone_key === d.phone_key).map(o => tr(o.shop, L)) : [];

  return (
    <div className="stack" style={{ display: 'grid', gap: 12 }}>
      <h2 style={{ margin: 0 }}>🛵 {x('title')} <small className="muted">({list.length})</small></h2>
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
      {shown.map(d => { const o = others(d); return (
        <div key={d.id} className="card drv-row" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', opacity: d.active ? 1 : .6 }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{d.name} {!d.active && <span className="badge cancelled">{x('inactive')}</span>} {d.has_account && <span title={x('account')}>👤</span>}</div>
            <div className="muted" style={{ fontSize: 14 }}>🏪 {tr(d.shop, L)}{d.phone && <> · <bdi dir="ltr">{d.phone}</bdi></>}{d.vehicle && <> · {d.vehicle}</>}</div>
            {o.length > 0 && <div className="muted" style={{ fontSize: 13 }}>{x('alsoAt')}: {o.join('، ')}</div>}
          </div>
          <div className="seg" style={{ opacity: busy === d.id ? .5 : 1 }}>
            <button type="button" className={d.scope === 'shop' ? 'active' : ''} disabled={!canEdit || !!busy} onClick={() => void setScope(d, 'shop')}>{x('shopOnly')}</button>
            <button type="button" className={d.scope === 'association' ? 'active' : ''} disabled={!canEdit || !!busy} onClick={() => void setScope(d, 'association')}>{x('shared')}</button>
          </div>
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
    </div>
  );
}
