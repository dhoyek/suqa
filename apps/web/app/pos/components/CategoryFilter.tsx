'use client';
import { useMemo, useState } from 'react';
import { text, type Category } from '@suqa/pos-core';
import Modal from './Modal';
import { pt, type L } from '../i18n';

/** Multi-select category filter: 🗂 button → sheet with type-ahead + checkboxes; selected categories shown as
 *  removable chips next to the button, with a "clear filter" chip. Same control in Sell and Items. */
export function CategoryFilter({ cats, selected, onChange, locale, big = false }: { cats: Category[]; selected: Set<string>; onChange: (s: Set<string>) => void; locale: L; big?: boolean }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState('');
  const toggle = (id: string) => { const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); onChange(n); };
  const matches = useMemo(() => { const n = q.trim().toLowerCase(); return cats.filter(c => !n || text(c.name, locale).toLowerCase().includes(n) || (c.name?.ar ?? '').toLowerCase().includes(n) || (c.name?.en ?? '').toLowerCase().includes(n)); }, [cats, q, locale]);
  if (!cats.length) return null;
  return (
    <>
      <button className={`btn ${big ? 'big' : ''} cat-btn ${selected.size ? 'primary' : ''}`} style={{ width: 'auto' }} title={pt('categories', locale)} onClick={() => setOpen(true)}>🗂{selected.size ? ` ${selected.size}` : ''}</button>
      {open && <Modal open onClose={() => setOpen(false)} title={`${pt('categories', locale)}${selected.size ? ` (${selected.size})` : ''}`}
        footer={<><button className="btn" onClick={() => onChange(new Set())}>✕ {pt('clearFilter', locale)}</button><span style={{ flex: 1 }} /><button className="btn primary" onClick={() => setOpen(false)}>{pt('ok', locale)}</button></>}>
        <input className="input" autoFocus={typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches} placeholder={pt('filterCategories', locale)} value={q} onChange={e => setQ(e.target.value)} />
        <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>{pt('multiCatHint', locale)}</p>
        <div className="cat-list">
          {matches.map(c => <label key={c.id} className={`cat-row ${selected.has(c.id) ? 'active' : ''}`}><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} /> <span>{text(c.name, locale)}</span></label>)}
          {!matches.length && <p className="muted">—</p>}
        </div>
      </Modal>}
    </>
  );
}

/** The chips under the toolbar: one per selected category (tap = remove) + clear. */
export function CategoryChips({ cats, selected, onChange, locale }: { cats: Category[]; selected: Set<string>; onChange: (s: Set<string>) => void; locale: L }) {
  if (!selected.size) return null;
  const remove = (id: string) => { const n = new Set(selected); n.delete(id); onChange(n); };
  return (
    <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {[...selected].map(id => <button key={id} className="chip active" onClick={() => remove(id)}>{text(cats.find(c => c.id === id)?.name ?? {}, locale)} ✕</button>)}
      <button className="chip" onClick={() => onChange(new Set())}>{pt('clearFilter', locale)}</button>
    </div>
  );
}
