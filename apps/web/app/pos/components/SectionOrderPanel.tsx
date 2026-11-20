'use client';
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { text, type CatalogIndex } from '@suqa/pos-core';
import { pt, type L } from '../i18n';
import type { Booted } from '../lib/boot';
import { cachedSectionOrder, saveSectionOrder } from '../lib/itemCats';

/**
 * Settings → ترتيب الأقسام: the shop puts ITS sections (the categories its items use) in the order it wants — on its store page
 * and on the chips of this till. Without a saved order they follow the association's shared order. Needs a connection to save.
 */
export default function SectionOrderPanel({ boot, sb, locale, index, online, onSaved }: { boot: Booted; sb: SupabaseClient; locale: L; index: CatalogIndex; online: boolean; onSaved: () => void }) {
  const current = () => [...index.categories.values()].sort((a, b) => a.sort_order - b.sort_order).map(c => c.id);
  const [keys, setKeys] = useState<string[]>(current); const [own, setOwn] = useState(() => cachedSectionOrder(boot.shop.id).length > 0);
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (!dirty) { setKeys(current()); setOwn(cachedSectionOrder(boot.shop.id).length > 0); } }, [index.categories.size, dirty]);   // eslint-disable-line react-hooks/exhaustive-deps
  const name = (k: string) => { const c = index.categories.get(k); return c ? text(c.name, locale) : k; };
  const move = (i: number, by: number) => { const j = i + by; if (j < 0 || j >= keys.length) return; const n = [...keys]; [n[i], n[j]] = [n[j], n[i]]; setKeys(n); setDirty(true); setMsg(null); };
  const save = async (list: string[]) => {
    setBusy(true); setMsg(null);
    try { await saveSectionOrder(sb, boot.shop.id, boot.shop.tenant_id, index, list); setDirty(false); setOwn(list.length > 0); setKeys(current()); onSaved(); setMsg(pt('saved', locale)); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  if (keys.length < 2) return null;
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>↕ {pt('sectionOrder', locale)}</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{pt('sectionOrderHint', locale)}</p>
      <div className="stack" style={{ gap: 4, maxWidth: 460 }}>
        {keys.map((k, i) => <div key={k} className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="muted" style={{ width: 24, textAlign: 'end' }}>{i + 1}</span>
          <span style={{ flex: 1 }}>{name(k)}</span>
          <button className="btn icon" disabled={i === 0 || busy} aria-label="▲" onClick={() => move(i, -1)}>▲</button>
          <button className="btn icon" disabled={i === keys.length - 1 || busy} aria-label="▼" onClick={() => move(i, 1)}>▼</button>
        </div>)}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={!dirty || busy || !online} onClick={() => void save(keys)}>{pt('save', locale)}</button>
        {own && <button className="btn ghost" disabled={busy || !online} onClick={() => void save([])}>{pt('sectionOrderReset', locale)}</button>}
        {!online && <span className="muted" style={{ fontSize: 13 }}>{pt('needsInternet', locale)}</span>}
        {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
      </div>
    </section>
  );
}
