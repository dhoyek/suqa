'use client';
import { useMemo, useState } from 'react';
import { text, type Category } from '@suqa/pos-core';
import Modal from './Modal';
import { pt, type L } from '../i18n';

export type PickItem = { id: string; label: string; extra?: string };

/** Generic multi-select filter: a button → sheet with type-ahead + checkboxes; the selection is shown as removable chips
 *  (PickChips). Used for categories (Sell, Items) and for people (Debts). */
export function PickFilter({ items, selected, onChange, locale, icon = '🗂', title, big = false }: { items: PickItem[]; selected: Set<string>; onChange: (s: Set<string>) => void; locale: L; icon?: string; title: string; big?: boolean }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState('');
  const toggle = (id: string) => { const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); onChange(n); };
  const matches = useMemo(() => { const n = q.trim().toLowerCase(); return items.filter(c => !n || c.label.toLowerCase().includes(n) || (c.extra ?? '').toLowerCase().includes(n)); }, [items, q]);
  if (!items.length) return null;
  return (
    <>
      <button className={`btn ${big ? 'big' : ''} cat-btn ${selected.size ? 'primary' : ''}`} style={{ width: 'auto' }} title={title} onClick={() => setOpen(true)}>{icon}{selected.size ? ` ${selected.size}` : ''}</button>
      {open && <Modal open onClose={() => setOpen(false)} title={`${title}${selected.size ? ` (${selected.size})` : ''}`}
        footer={<><button className="btn" onClick={() => onChange(new Set())}>✕ {pt('clearFilter', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" onClick={() => setOpen(false)}>{pt('ok', locale)}</button></>}>
        <input className="input" autoFocus={typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches} placeholder={pt('typeToFilter', locale)} value={q} onChange={e => setQ(e.target.value)} />
        <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>{pt('multiPickHint', locale)}</p>
        <div className="cat-list">
          {matches.map(c => <label key={c.id} className={`cat-row ${selected.has(c.id) ? 'active' : ''}`}><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} /> <span style={{ flex: 1 }}>{c.label}</span>{c.extra && <span className="muted" dir="ltr" style={{ fontSize: 12 }}>{c.extra}</span>}</label>)}
          {!matches.length && <p className="muted">—</p>}
        </div>
      </Modal>}
    </>
  );
}

export function PickChips({ items, selected, onChange, locale }: { items: PickItem[]; selected: Set<string>; onChange: (s: Set<string>) => void; locale: L }) {
  if (!selected.size) return null;
  const remove = (id: string) => { const n = new Set(selected); n.delete(id); onChange(n); };
  return (
    <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {[...selected].map(id => <button key={id} className="chip active" onClick={() => remove(id)}>{items.find(c => c.id === id)?.label ?? id} ✕</button>)}
      <button className="chip" onClick={() => onChange(new Set())}>{pt('clearFilter', locale)}</button>
    </div>
  );
}

const catItems = (cats: Category[], locale: L): PickItem[] => cats.map(c => ({ id: c.id, label: text(c.name, locale), extra: locale === 'ar' ? (c.name?.en ?? undefined) : (c.name?.ar ?? undefined) }));

export function CategoryFilter({ cats, selected, onChange, locale, big = false }: { cats: Category[]; selected: Set<string>; onChange: (s: Set<string>) => void; locale: L; big?: boolean }) {
  return <PickFilter items={catItems(cats, locale)} selected={selected} onChange={onChange} locale={locale} title={pt('categories', locale)} big={big} />;
}
export function CategoryChips({ cats, selected, onChange, locale }: { cats: Category[]; selected: Set<string>; onChange: (s: Set<string>) => void; locale: L }) {
  return <PickChips items={catItems(cats, locale)} selected={selected} onChange={onChange} locale={locale} />;
}
