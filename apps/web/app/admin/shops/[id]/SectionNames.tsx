'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { Locale } from '@suqa/shared';

type Names = Record<string, { ar?: string; en?: string }>;

/** Arabic / English display names for the shop's item sections (schema 74). The section itself — what is typed on each item —
 *  is the key and is not changed here; customers see the name in their language. Only sections that have items are listed. */
export default function SectionNames({ shopId, initial, locale }: { shopId: string; initial: Names | null; locale: Locale }) {
  const ar = locale === 'ar';
  const sb = useMemo(() => supabaseBrowser(), []);
  const [sections, setSections] = useState<{ key: string; n: number }[] | null>(null);
  const [names, setNames] = useState<Names>(initial ?? {});
  const [q, setQ] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    let on = true;
    (async () => {
      const count = new Map<string, number>();
      for (let from = 0; ; from += 1000) {
        const { data } = await sb.from('products').select('section').eq('shop_id', shopId).eq('is_active', true).range(from, from + 999);
        const rows = (data as { section: string | null }[] | null) ?? [];
        for (const r of rows) if (r.section) count.set(r.section, (count.get(r.section) ?? 0) + 1);
        if (rows.length < 1000) break;
      }
      if (on) setSections([...count].map(([key, n]) => ({ key, n })).sort((a, b) => a.key.localeCompare(b.key)));
    })();
    return () => { on = false; };
  }, [sb, shopId]);
  const set = (key: string, lang: 'ar' | 'en', v: string) => setNames(prev => ({ ...prev, [key]: { ...prev[key], [lang]: v } }));
  const save = async () => {
    setBusy(true); setMsg(null);
    const clean: Names = {};
    for (const [k, v] of Object.entries(names)) { const a = v.ar?.trim(), e = v.en?.trim(); if (a || e) clean[k] = { ...(a ? { ar: a } : {}), ...(e ? { en: e } : {}) }; }
    const { error } = await sb.from('shops').update({ section_names: clean } as never).eq('id', shopId);
    setBusy(false); setMsg(error ? { ok: false, text: error.message } : { ok: true, text: ar ? 'تم الحفظ' : 'Saved' });
  };
  const shown = (sections ?? []).filter(s => !q.trim() || `${s.key} ${names[s.key]?.ar ?? ''} ${names[s.key]?.en ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  if (sections && !sections.length) return null;
  return (
    <section className="card stack">
      <strong>🗂 {ar ? 'أسماء الأقسام (عربي / إنكليزي)' : 'Section names (Arabic / English)'}</strong>
      <span className="muted" style={{ fontSize: 13 }}>{ar ? 'ما يراه الزبون بدل رمز القسم. القسم بدون اسم يظهر برمزه كما هو.' : 'What customers see in place of the section code. A section left empty shows its code as is.'}</span>
      {sections && sections.length > 8 && <input className="input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={ar ? 'ابحث عن قسم…' : 'Find a section…'} />}
      {!sections && <span className="muted">…</span>}
      <div className="stack" style={{ gap: 6, maxHeight: 420, overflowY: 'auto' }}>
        {shown.map(s => (
          <div className="row" key={s.key} style={{ alignItems: 'center', gap: 8 }}>
            <span style={{ flex: '0 0 34%', minWidth: 0, fontSize: 13 }}><bdi>{s.key}</bdi> <span className="muted">({s.n})</span></span>
            <input className="input" dir="rtl" style={{ flex: 1, minWidth: 0 }} placeholder="عربي" value={names[s.key]?.ar ?? ''} onChange={e => set(s.key, 'ar', e.target.value)} />
            <input className="input" dir="ltr" style={{ flex: 1, minWidth: 0 }} placeholder="English" value={names[s.key]?.en ?? ''} onChange={e => set(s.key, 'en', e.target.value)} />
          </div>
        ))}
      </div>
      <div className="row spread" style={{ alignItems: 'center' }}>
        <span className={msg ? (msg.ok ? 'muted' : 'error') : 'muted'}>{msg ? (msg.ok ? '✓ ' : '') + msg.text : ''}</span>
        <button className="btn primary" disabled={busy || !sections} onClick={save}>{ar ? 'حفظ الأسماء' : 'Save names'}</button>
      </div>
    </section>
  );
}
