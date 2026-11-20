'use client';
import { useMemo, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { normText, text, type CatalogIndex } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import { addItemCat } from '../lib/itemCats';

/**
 * An item's category: picked from the association's shared list (87) — type to search in Arabic, Arabizi-free English or either
 * name — or added when it is missing (both names; it then serves every shop). Works offline for picking; adding needs a connection.
 */
export default function CategoryPicker({ index, shopId, tenantId, locale, value, onChange, online }: {
  index: CatalogIndex; shopId: string; tenantId: string; locale: L; value: string; onChange: (key: string) => void; online: boolean;
}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const [adding, setAdding] = useState<null | { en: string; ar: string }>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const box = useRef<HTMLDivElement>(null);
  // the shared list, plus this shop's own sections that are not in it yet (older items)
  const all = useMemo(() => { const m = new Map(index.shared.map(c => [c.id, c])); for (const c of index.categories.values()) if (!m.has(c.id)) m.set(c.id, c); return [...m.values()]; }, [index, index.shared, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = all.find(c => c.id === value);
  const nq = normText(q);
  const hits = nq ? all.filter(c => normText(`${c.id} ${c.name?.ar ?? ''} ${c.name?.en ?? ''}`).includes(nq)) : all;
  const exact = !!nq && all.some(c => [c.id, c.name?.ar, c.name?.en].some(n => normText(n ?? '') === nq));
  const pick = (k: string) => { onChange(k); setOpen(false); setQ(''); setAdding(null); setErr(null); };
  const save = async () => {
    if (!adding || !(adding.en.trim() || adding.ar.trim())) return;
    setBusy(true); setErr(null);
    try { pick(await addItemCat(sb, shopId, tenantId, index, adding.en, adding.ar)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const startAdd = () => { const arabic = /[\u0600-\u06FF]/.test(q); setAdding({ en: arabic ? '' : q.trim(), ar: arabic ? q.trim() : '' }); };
  return (
    <div className="cat-picker" ref={box}>
      <button type="button" className="input cat-picker-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span>{cur ? text(cur.name, locale) : value || <span className="muted">{pt('noCategory', locale)}</span>}</span>
        {cur && <span className="muted" style={{ fontSize: 12 }}>{locale === 'ar' ? cur.name?.en : cur.name?.ar}</span>}<span className="muted">▾</span>
      </button>
      {open && <div className="cat-picker-pop">
        <input className="input" autoFocus type="search" value={q} onChange={e => { setQ(e.target.value); setAdding(null); }} placeholder={pt('catSearch', locale)} />
        <div className="cat-picker-list">
          {value && <button type="button" className="cat-picker-row muted" onClick={() => pick('')}>✕ {pt('noCategory', locale)}</button>}
          {hits.map(c => <button type="button" key={c.id} className={`cat-picker-row ${c.id === value ? 'active' : ''}`} onClick={() => pick(c.id)}>
            <span>{text(c.name, locale)}</span><span className="muted" style={{ fontSize: 12 }}>{locale === 'ar' ? c.name?.en : c.name?.ar}</span></button>)}
          {!hits.length && <div className="muted" style={{ padding: 8 }}>{pt('catNone', locale)}</div>}
        </div>
        {!adding && !exact && (online
          ? <button type="button" className="btn" style={{ width: '100%' }} onClick={startAdd}>➕ {pt('catAdd', locale)}{q.trim() ? ` «${q.trim()}»` : ''}</button>
          : <div className="muted" style={{ fontSize: 12, padding: 6 }}>{pt('catAddOffline', locale)}</div>)}
        {adding && <div className="stack" style={{ gap: 6, marginTop: 6 }}>
          <input className="input" dir="ltr" placeholder={pt('nameEn', locale)} value={adding.en} onChange={e => setAdding({ ...adding, en: e.target.value })} />
          <input className="input" dir="rtl" placeholder={pt('nameAr', locale)} value={adding.ar} onChange={e => setAdding({ ...adding, ar: e.target.value })} />
          <div className="muted" style={{ fontSize: 12 }}>{pt('catAddNote', locale)}</div>
          {err && <div className="bad" style={{ fontSize: 12 }}>{err}</div>}
          <div className="row" style={{ gap: 6 }}><button type="button" className="btn primary" disabled={busy || !(adding.en.trim() || adding.ar.trim())} onClick={() => void save()}>✓ {pt('catAdd', locale)}</button><button type="button" className="btn ghost" onClick={() => setAdding(null)}>{pt('cancel', locale)}</button></div>
        </div>}
      </div>}
    </div>
  );
}
