'use client';
import { useConfirm } from '@/components/ConfirmProvider';
import { useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import ImageUpload from '@/components/ImageUpload';
import { formatMoney, t as tr, type DisplayCurrency, type Locale, type Product } from '@suqa/shared';

type Labels = Record<'available' | 'unavailable' | 'addProduct' | 'editProduct' | 'nameEn' | 'nameAr' | 'priceUsd' | 'unit' | 'section' | 'save' | 'cancel' | 'remove' | 'photo' | 'changePhoto' | 'descAr' | 'descEn', string>;
type Draft = { id?: string; name_en: string; name_ar: string; desc_en: string; desc_ar: string; price_usd: string; unit: string; section: string; image_url: string | null };
const empty: Draft = { name_en: '', name_ar: '', desc_en: '', desc_ar: '', price_usd: '', unit: '', section: '', image_url: null };

export default function ProductList(props: { shopId: string; tenantId: string; initial: Product[]; locale: Locale; fx: number; displayCurrency: DisplayCurrency; labels: Labels }) {
  const { shopId, tenantId, locale: L, fx, displayCurrency, labels } = props;
  const ask = useConfirm();
  const sb = useMemo(() => supabaseBrowser(), []);
  const [products, setProducts] = useState<Product[]>(props.initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  // Optimistic toggle — the merchant's most frequent action.
  async function toggle(p: Product) {
    const next = !p.is_available;
    setProducts(prev => prev.map(x => x.id === p.id ? { ...x, is_available: next } : x));
    const { error } = await sb.from('products').update({ is_available: next }).eq('id', p.id);
    if (error) { setProducts(prev => prev.map(x => x.id === p.id ? { ...x, is_available: !next } : x)); alert(friendlyError(error, L)); }
  }

  async function save() {
    if (!draft) return;
    const price = Number(draft.price_usd);
    if (!draft.name_en.trim() && !draft.name_ar.trim()) return;
    if (!(price >= 0)) return;
    setBusy(true);
    const row = {
      tenant_id: tenantId, shop_id: shopId,
      name: { en: draft.name_en.trim() || draft.name_ar.trim(), ar: draft.name_ar.trim() || draft.name_en.trim() },
      description: { en: draft.desc_en.trim(), ar: draft.desc_ar.trim() },
      price_usd: price, unit: draft.unit.trim() || null, section: draft.section.trim() || null, image_url: draft.image_url,
    };
    const q = draft.id ? sb.from('products').update(row).eq('id', draft.id).select().single()
                       : sb.from('products').insert({ ...row, sort_order: products.length + 1 }).select().single();
    const { data, error } = await q;
    setBusy(false);
    if (error) { alert(friendlyError(error, L)); return; }
    setProducts(prev => draft.id ? prev.map(x => x.id === draft.id ? (data as Product) : x) : [...prev, data as Product]);
    setDraft(null);
  }

  async function remove(p: Product) {
    if (!(await ask(`${labels.remove}: ${tr(p.name, L)}?`, { danger: true }))) return;
    const { error } = await sb.from('products').update({ is_active: false }).eq('id', p.id);  // soft delete
    if (error) { alert(friendlyError(error, L)); return; }
    setProducts(prev => prev.filter(x => x.id !== p.id));
  }

  const sections = Array.from(new Set(products.map(p => p.section ?? '')));
  const money = (v: number) => formatMoney(v, fx, displayCurrency, L);

  return (
    <>
      <div className="row spread" style={{ marginBottom: 10 }}>
        <span className="muted">{products.filter(p => p.is_available).length}/{products.length} {labels.available.toLowerCase()}</span>
        <button className="btn primary" onClick={() => setDraft({ ...empty })}>+ {labels.addProduct}</button>
      </div>
      <div className="stack">
        {sections.map(sec => (
          <section className="card" key={sec || '_'}>
            {sec && <div className="col-title" style={{ marginTop: 0 }}>{sec}</div>}
            {products.filter(p => (p.section ?? '') === sec).map(p => (
              <div className={`product ${p.is_available ? '' : 'off'}`} key={p.id}>
                <button className={`switch ${p.is_available ? 'on' : ''}`} aria-label={p.is_available ? labels.available : labels.unavailable} aria-pressed={p.is_available} onClick={() => toggle(p)} />
                {p.image_url ? <img className="thumb" src={p.image_url} alt="" /> : <span className="thumb" aria-hidden />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="name">{tr(p.name, L)}</div>
                  <div className="muted" style={{ fontSize: 13 }}>{money(Number(p.price_usd))}{p.unit ? ` / ${p.unit}` : ''}</div>
                </div>
                <button className="btn ghost muted" onClick={() => setDraft({ id: p.id, name_en: p.name.en ?? '', name_ar: p.name.ar ?? '', desc_en: p.description?.en ?? '', desc_ar: p.description?.ar ?? '', price_usd: String(p.price_usd), unit: p.unit ?? '', section: p.section ?? '', image_url: p.image_url ?? null })}>✎</button>
              </div>
            ))}
          </section>
        ))}
      </div>

      {draft && (
        <div className="sheet" onClick={() => setDraft(null)}>
          <div className="panel stack" onClick={e => e.stopPropagation()}>
            <strong>{draft.id ? labels.editProduct : labels.addProduct}</strong>
            <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <ImageUpload shopId={shopId} kind="product" shape="square" value={draft.image_url} onChange={u => setDraft(d => d ? { ...d, image_url: u } : d)} locale={L} labels={{ add: labels.photo, change: labels.changePhoto, remove: labels.remove }} />
              <div className="stack" style={{ flex: 1 }}>
                <div><label className="label">{labels.descAr}</label><input className="input" dir="rtl" value={draft.desc_ar} onChange={e => setDraft({ ...draft, desc_ar: e.target.value })} /></div>
                <div><label className="label">{labels.descEn}</label><input className="input" dir="ltr" value={draft.desc_en} onChange={e => setDraft({ ...draft, desc_en: e.target.value })} /></div>
              </div>
            </div>
            <div><label className="label">{labels.nameAr}</label><input className="input" dir="rtl" value={draft.name_ar} onChange={e => setDraft({ ...draft, name_ar: e.target.value })} /></div>
            <div><label className="label">{labels.nameEn}</label><input className="input" dir="ltr" value={draft.name_en} onChange={e => setDraft({ ...draft, name_en: e.target.value })} /></div>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <div style={{ flex: 1 }}><label className="label">{labels.priceUsd}</label><input className="input" dir="ltr" inputMode="decimal" value={draft.price_usd} onChange={e => setDraft({ ...draft, price_usd: e.target.value })} /></div>
              <div style={{ flex: 1 }}><label className="label">{labels.unit}</label><input className="input" value={draft.unit} onChange={e => setDraft({ ...draft, unit: e.target.value })} /></div>
            </div>
            <div><label className="label">{labels.section}</label><input className="input" list="sections" value={draft.section} onChange={e => setDraft({ ...draft, section: e.target.value })} />
              <datalist id="sections">{sections.filter(Boolean).map(s => <option key={s} value={s} />)}</datalist></div>
            <div className="row spread">
              <div className="row">
                <button className="btn" onClick={() => setDraft(null)}>{labels.cancel}</button>
                {draft.id && <button className="btn danger" onClick={() => { const p = products.find(x => x.id === draft.id); setDraft(null); if (p) remove(p); }}>{labels.remove}</button>}
              </div>
              <button className="btn primary" disabled={busy} onClick={save}>{labels.save}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
