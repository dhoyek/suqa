'use client';
import { useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useConfirm, useNotify } from '@/components/ConfirmProvider';

type Cat = { id: string; slug: string; ar: string; en: string; shops: number };

export default function CategoriesEditor({ tenantId, locale, initial }: { tenantId: string; locale: 'ar' | 'en'; initial: Cat[] }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const ar = locale === 'ar';
  const ask = useConfirm(); const notify = useNotify();
  const [cats, setCats] = useState<Cat[]>(initial);
  const [saved, setSaved] = useState<Record<string, { ar: string; en: string }>>(Object.fromEntries(initial.map(c => [c.id, { ar: c.ar, en: c.en }])));
  const [n, setN] = useState({ ar: '', en: '' });
  const [busy, setBusy] = useState(false);
  const T = (a: string, e: string) => (ar ? a : e);

  const edit = (id: string, k: 'ar' | 'en', v: string) => setCats(cs => cs.map(c => c.id === id ? { ...c, [k]: v } : c));
  const changed = (c: Cat) => saved[c.id]?.ar !== c.ar || saved[c.id]?.en !== c.en;

  async function saveName(c: Cat) {
    const nameAr = c.ar.trim() || c.en.trim(), nameEn = c.en.trim() || c.ar.trim();
    if (!nameAr) { notify(T('الاسم مطلوب.', 'A name is required.')); return; }
    const { error } = await sb.from('categories').update({ name: { ar: nameAr, en: nameEn } }).eq('id', c.id);
    if (error) { notify(error.message); return; }
    setCats(cs => cs.map(x => x.id === c.id ? { ...x, ar: nameAr, en: nameEn } : x));
    setSaved(s => ({ ...s, [c.id]: { ar: nameAr, en: nameEn } }));
  }

  // order on the home page: swap with the neighbour, then store every position (the list is short)
  async function move(i: number, d: -1 | 1) {
    const j = i + d; if (j < 0 || j >= cats.length || busy) return;
    const next = [...cats]; [next[i], next[j]] = [next[j], next[i]];
    setCats(next); setBusy(true);
    const res = await Promise.all(next.map((c, k) => sb.from('categories').update({ sort_order: k + 1 }).eq('id', c.id)));
    setBusy(false);
    const err = res.find(r => r.error)?.error; if (err) notify(err.message);
  }

  async function remove(c: Cat) {
    if (c.shops > 0) { notify(T(`لا يمكن حذف فئة فيها ${c.shops} متجر. انقل المتاجر إلى فئة أخرى أولاً.`, `This category has ${c.shops} shop(s). Move them to another category first.`)); return; }
    if (!(await ask(T(`حذف الفئة «${c.ar || c.en}»؟`, `Delete the category "${c.en || c.ar}"?`), { danger: true }))) return;
    const { error } = await sb.from('categories').delete().eq('id', c.id);
    if (error) { notify(error.message); return; }
    setCats(cs => cs.filter(x => x.id !== c.id));
  }

  async function add() {
    const nameAr = n.ar.trim() || n.en.trim(), nameEn = n.en.trim() || n.ar.trim();
    if (!nameAr) return;
    setBusy(true);
    const base = nameEn.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = base || `cat-${Date.now().toString(36)}`;
    const { data, error } = await sb.from('categories').insert({ tenant_id: tenantId, slug, name: { ar: nameAr, en: nameEn }, sort_order: cats.length + 1 }).select('id').single();
    setBusy(false);
    if (error || !data) { notify(error?.code === '23505' ? T('هذه الفئة موجودة.', 'This category already exists.') : (error?.message ?? 'error')); return; }
    const id = (data as { id: string }).id;
    setCats(cs => [...cs, { id, slug, ar: nameAr, en: nameEn, shops: 0 }]);
    setSaved(s => ({ ...s, [id]: { ar: nameAr, en: nameEn } }));
    setN({ ar: '', en: '' });
  }

  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{T('فئات المتاجر', 'Shop categories')}</h1>
      <div className="muted" style={{ fontSize: 13 }}>{T('الترتيب هنا هو ترتيب الفئات في الصفحة الرئيسية. الفئة التي لا متاجر ظاهرة فيها لا تظهر للزبائن.', 'The order here is the order on the home page. A category with no listed shop is not shown to customers.')}</div>
      <section className="card stack">
        {cats.length === 0 && <div className="muted">{T('لا فئات بعد.', 'No categories yet.')}</div>}
        {cats.map((c, i) => (
          <div key={c.id} className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 2 }}>
              <button type="button" className="btn ghost" disabled={i === 0 || busy} onClick={() => move(i, -1)} aria-label={T('إلى الأعلى', 'Move up')}>▲</button>
              <button type="button" className="btn ghost" disabled={i === cats.length - 1 || busy} onClick={() => move(i, 1)} aria-label={T('إلى الأسفل', 'Move down')}>▼</button>
            </span>
            <input className="input" style={{ flex: 1, minWidth: 130 }} dir="rtl" aria-label={T('الاسم (عربي)', 'Name (Arabic)')} value={c.ar} onChange={e => edit(c.id, 'ar', e.target.value)} />
            <input className="input" style={{ flex: 1, minWidth: 130 }} dir="ltr" aria-label={T('الاسم (إنكليزي)', 'Name (English)')} value={c.en} onChange={e => edit(c.id, 'en', e.target.value)} />
            <span className="badge" title={T('عدد المتاجر', 'Shops')}>🏪 {c.shops}</span>
            {changed(c) && <button type="button" className="btn primary" onClick={() => saveName(c)}>{T('حفظ', 'Save')}</button>}
            <button type="button" className="btn ghost muted" onClick={() => remove(c)} aria-label={T('حذف', 'Delete')}>✕</button>
          </div>
        ))}
      </section>
      <section className="card stack">
        <strong>{T('فئة جديدة', 'New category')}</strong>
        <div className="row" style={{ gap: 6, alignItems: 'stretch', flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: 1, minWidth: 130 }} dir="rtl" placeholder={T('الاسم (عربي)', 'Name (Arabic)')} value={n.ar} onChange={e => setN({ ...n, ar: e.target.value })} />
          <input className="input" style={{ flex: 1, minWidth: 130 }} dir="ltr" placeholder={T('الاسم (إنكليزي)', 'Name (English)')} value={n.en} onChange={e => setN({ ...n, en: e.target.value })} />
          <button type="button" className="btn primary" disabled={busy || !(n.ar.trim() || n.en.trim())} onClick={add}>➕ {T('إضافة', 'Add')}</button>
        </div>
      </section>
    </div>
  );
}
