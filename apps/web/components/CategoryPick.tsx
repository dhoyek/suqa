'use client';
import { useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

type Cat = { id: string; name: string };

/** The shop's category, for association admins: a list, plus ➕ to create a category that does not exist yet. */
export default function CategoryPick({ tenantId, locale, categories, value, onChange, label }: {
  tenantId: string; locale: 'ar' | 'en'; categories: Cat[]; value: string; onChange: (id: string) => void; label: string;
}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const ar = locale === 'ar';
  const [cats, setCats] = useState<Cat[]>(categories);
  const [open, setOpen] = useState(false);
  const [n, setN] = useState({ ar: '', en: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);

  async function add() {
    const nameAr = n.ar.trim() || n.en.trim(), nameEn = n.en.trim() || n.ar.trim();
    if (!nameAr) return;
    setBusy(true); setErr(null);
    const base = nameEn.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = base || `cat-${Date.now().toString(36)}`;
    const { data, error } = await sb.from('categories').insert({ tenant_id: tenantId, slug, name: { ar: nameAr, en: nameEn }, sort_order: cats.length + 1 }).select('id').single();
    setBusy(false);
    if (error || !data) { setErr(error?.code === '23505' ? (ar ? 'هذه الفئة موجودة.' : 'This category already exists.') : (error?.message ?? 'error')); return; }
    const id = (data as { id: string }).id;
    setCats(c => [...c, { id, name: ar ? nameAr : nameEn }]); onChange(id);
    setN({ ar: '', en: '' }); setOpen(false);
  }

  return (
    <div>
      <label className="label">{label}</label>
      <div className="row" style={{ gap: 6 }}>
        <select className="input" style={{ flex: 1 }} value={value} onChange={e => onChange(e.target.value)}>
          {!value && <option value="">—</option>}
          {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button type="button" className="btn" aria-expanded={open} title={ar ? 'فئة جديدة' : 'New category'} aria-label={ar ? 'فئة جديدة' : 'New category'} onClick={() => setOpen(o => !o)}>➕</button>
      </div>
      {open && <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: 1, minWidth: 130 }} dir="rtl" placeholder={ar ? 'اسم الفئة (عربي)' : 'Category name (Arabic)'} value={n.ar} onChange={e => setN({ ...n, ar: e.target.value })} />
        <input className="input" style={{ flex: 1, minWidth: 130 }} dir="ltr" placeholder={ar ? 'اسم الفئة (إنكليزي)' : 'Category name (English)'} value={n.en} onChange={e => setN({ ...n, en: e.target.value })} />
        <button type="button" className="btn primary" disabled={busy || !(n.ar.trim() || n.en.trim())} onClick={add}>{busy ? '…' : (ar ? 'إضافة' : 'Add')}</button>
      </div>}
      {err && <div className="error" style={{ fontSize: 13 }}>{err}</div>}
    </div>
  );
}
