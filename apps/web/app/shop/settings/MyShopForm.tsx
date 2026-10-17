'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import ImageUpload from '@/components/ImageUpload';
import type { Locale, Shop } from '@suqa/shared';

type Range = [string, string];
type Hours = Record<string, Range[]>;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABEL: Record<string, { en: string; ar: string }> = {
  mon: { en: 'Mon', ar: 'الاثنين' }, tue: { en: 'Tue', ar: 'الثلاثاء' }, wed: { en: 'Wed', ar: 'الأربعاء' }, thu: { en: 'Thu', ar: 'الخميس' },
  fri: { en: 'Fri', ar: 'الجمعة' }, sat: { en: 'Sat', ar: 'السبت' }, sun: { en: 'Sun', ar: 'الأحد' },
};
type Labels = Record<'myShop' | 'shopDetails' | 'nameAr' | 'nameEn' | 'descAr' | 'descEn' | 'logo' | 'cover' | 'photo' | 'changePhoto' | 'remove' | 'contact' | 'publicPhone' | 'whatsapp' | 'addressText'
  | 'openingHours' | 'closedDay' | 'addRange' | 'pauseOrders' | 'pauseHint' | 'followHours' | 'forceOpen' | 'forceClosed' | 'minOrderUsd' | 'prepMinutes' | 'save' | 'saved', string>;

export default function MyShopForm({ shop, locale: L, canEdit, labels }: { shop: Shop; locale: Locale; canEdit: boolean; labels: Labels }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const router = useRouter();
  const [f, setF] = useState({
    name_ar: shop.name.ar ?? '', name_en: shop.name.en ?? '', desc_ar: shop.description?.ar ?? '', desc_en: shop.description?.en ?? '',
    phone: shop.phone ?? '', whatsapp: shop.whatsapp ?? '', address_text: shop.address_text ?? '',
    min_order: String(shop.min_order_usd ?? 0), prep: String(shop.prep_minutes ?? 30),
    logo_url: shop.logo_url ?? null as string | null, cover_url: shop.cover_url ?? null as string | null,
    override: shop.is_open_override === true ? 'open' : shop.is_open_override === false ? 'closed' : 'hours',
  });
  const [hours, setHours] = useState<Hours>((shop.opening_hours as Hours) ?? {});
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const dis = !canEdit;

  // quick pause switch — saved immediately (the merchant's panic button)
  async function setPaused(paused: boolean) {
    const override = paused ? false : null;
    setF(x => ({ ...x, override: paused ? 'closed' : 'hours' }));
    const { error } = await sb.from('shops').update({ is_open_override: override }).eq('id', shop.id);
    if (error) setMsg(friendlyError(error, L)); else router.refresh();
  }

  function setRange(day: string, i: number, k: 0 | 1, v: string) {
    setHours(h => { const r = [...(h[day] ?? [])]; r[i] = [...(r[i] ?? ['09:00', '18:00'])] as Range; r[i][k] = v; return { ...h, [day]: r }; });
  }
  function addRange(day: string) { setHours(h => ({ ...h, [day]: [...(h[day] ?? []), (h[day]?.length ? ['16:00', '20:00'] : ['09:00', '18:00']) as Range] })); }
  function removeRange(day: string, i: number) { setHours(h => { const r = (h[day] ?? []).filter((_, j) => j !== i); const n = { ...h }; if (r.length) n[day] = r; else delete n[day]; return n; }); }

  async function save() {
    setBusy(true); setMsg(null);
    const { error } = await sb.from('shops').update({
      name: { ar: f.name_ar.trim() || f.name_en.trim(), en: f.name_en.trim() || f.name_ar.trim() },
      description: { ar: f.desc_ar.trim(), en: f.desc_en.trim() },
      phone: f.phone.trim() || null, whatsapp: f.whatsapp.trim() || null, address_text: f.address_text.trim() || null,
      min_order_usd: Number(f.min_order) || 0, prep_minutes: Math.max(0, Number(f.prep) || 0),
      logo_url: f.logo_url, cover_url: f.cover_url, opening_hours: hours,
      is_open_override: f.override === 'open' ? true : f.override === 'closed' ? false : null,
    }).eq('id', shop.id);
    setBusy(false);
    if (error) { setMsg(friendlyError(error, L)); return; }
    setMsg(labels.saved); router.refresh();
  }

  const paused = f.override === 'closed';
  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{labels.myShop}</h1>

      <section className={`card row spread ${paused ? 'paused' : ''}`} style={{ alignItems: 'center' }}>
        <div><strong>{labels.pauseOrders}</strong><div className="muted" style={{ fontSize: 13 }}>{labels.pauseHint}</div></div>
        <button className={`switch ${paused ? 'on' : ''}`} aria-pressed={paused} disabled={dis} onClick={() => setPaused(!paused)} aria-label={labels.pauseOrders} />
      </section>

      <section className="card stack">
        <strong>{labels.shopDetails}</strong>
        <div><label className="label">{labels.cover}</label>
          <ImageUpload shopId={shop.id} kind="cover" value={f.cover_url} onChange={u => setF({ ...f, cover_url: u })} locale={L} labels={{ add: labels.photo, change: labels.changePhoto, remove: labels.remove }} /></div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
          <div><label className="label">{labels.logo}</label>
            <ImageUpload shopId={shop.id} kind="logo" shape="square" value={f.logo_url} onChange={u => setF({ ...f, logo_url: u })} locale={L} labels={{ add: labels.photo, change: labels.changePhoto, remove: labels.remove }} /></div>
          <div className="stack" style={{ flex: 1 }}>
            <div><label className="label">{labels.nameAr}</label><input className="input" dir="rtl" disabled={dis} value={f.name_ar} onChange={e => setF({ ...f, name_ar: e.target.value })} /></div>
            <div><label className="label">{labels.nameEn}</label><input className="input" dir="ltr" disabled={dis} value={f.name_en} onChange={e => setF({ ...f, name_en: e.target.value })} /></div>
          </div>
        </div>
        <div><label className="label">{labels.descAr}</label><input className="input" dir="rtl" disabled={dis} value={f.desc_ar} onChange={e => setF({ ...f, desc_ar: e.target.value })} /></div>
        <div><label className="label">{labels.descEn}</label><input className="input" dir="ltr" disabled={dis} value={f.desc_en} onChange={e => setF({ ...f, desc_en: e.target.value })} /></div>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: 1 }}><label className="label">{labels.minOrderUsd}</label><input className="input" dir="ltr" inputMode="decimal" disabled={dis} value={f.min_order} onChange={e => setF({ ...f, min_order: e.target.value })} /></div>
          <div style={{ flex: 1 }}><label className="label">{labels.prepMinutes}</label><input className="input" dir="ltr" inputMode="numeric" disabled={dis} value={f.prep} onChange={e => setF({ ...f, prep: e.target.value })} /></div>
        </div>
      </section>

      <section className="card stack">
        <strong>{labels.contact}</strong>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: 1 }}><label className="label">{labels.publicPhone}</label><input className="input" dir="ltr" inputMode="tel" disabled={dis} value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></div>
          <div style={{ flex: 1 }}><label className="label">{labels.whatsapp}</label><input className="input" dir="ltr" inputMode="tel" disabled={dis} value={f.whatsapp} onChange={e => setF({ ...f, whatsapp: e.target.value })} /></div>
        </div>
        <div><label className="label">{labels.addressText}</label><input className="input" disabled={dis} value={f.address_text} onChange={e => setF({ ...f, address_text: e.target.value })} /></div>
      </section>

      <section className="card stack">
        <div className="row spread">
          <strong>{labels.openingHours}</strong>
          <select className="input" style={{ width: 'auto' }} disabled={dis} value={f.override} onChange={e => setF({ ...f, override: e.target.value })}>
            <option value="hours">{labels.followHours}</option><option value="open">{labels.forceOpen}</option><option value="closed">{labels.forceClosed}</option>
          </select>
        </div>
        {DAYS.map(d => (
          <div key={d} className="stack" style={{ gap: 4 }}>
            {(hours[d]?.length ? hours[d] : [null]).map((r, i) => (
              <div className="hours-row" key={i}>
                <span style={{ fontSize: 13 }}>{i === 0 ? DAY_LABEL[d][L === 'ar' ? 'ar' : 'en'] : ''}</span>
                {r ? <>
                  <input type="time" className="input" dir="ltr" disabled={dis} value={r[0]} onChange={e => setRange(d, i, 0, e.target.value)} />
                  <input type="time" className="input" dir="ltr" disabled={dis} value={r[1]} onChange={e => setRange(d, i, 1, e.target.value)} />
                  <button type="button" className="btn ghost muted" disabled={dis} onClick={() => removeRange(d, i)} aria-label={labels.remove}>✕</button>
                </> : <>
                  <span className="muted" style={{ fontSize: 13, gridColumn: 'span 2' }}>{labels.closedDay}</span>
                  <button type="button" className="btn ghost" disabled={dis} onClick={() => addRange(d)}>{labels.addRange}</button>
                </>}
              </div>
            ))}
            {hours[d]?.length === 1 && <button type="button" className="btn ghost" style={{ alignSelf: 'flex-end', fontSize: 12 }} disabled={dis} onClick={() => addRange(d)}>{labels.addRange}</button>}
          </div>
        ))}
      </section>

      {msg && <div className={msg === labels.saved ? 'muted' : 'error'}>{msg}</div>}
      {canEdit && <button className="btn primary wide" disabled={busy} onClick={save}>{labels.save}</button>}
    </div>
  );
}
