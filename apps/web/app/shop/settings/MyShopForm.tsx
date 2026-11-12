'use client';
import { useEffect, useMemo, useState } from 'react';
import { useConfirm } from '@/components/ConfirmProvider';
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
  | 'openingHours' | 'closedDay' | 'addRange' | 'pauseOrders' | 'pauseHint' | 'followHours' | 'forceOpen' | 'forceClosed' | 'minOrderUsd' | 'prepMinutes' | 'save' | 'saved' | 'pickupEnabled'
  | 'zonesServed' | 'zonesServedHint' | 'feeOverride' | 'noZonesYet' | 'noZonesServed', string>;
type Zone = { id: string; name: string; fee_usd: number };

export default function MyShopForm({ shop, locale: L, canEdit, labels, zones, served: served0 }: { shop: Shop; locale: Locale; canEdit: boolean; labels: Labels; zones: Zone[]; served: { zone_id: string; fee_usd: number | null }[] }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const router = useRouter();
  // which association zones this shop delivers to, with an optional fee of its own (empty = the zone's standard fee)
  const [served, setServed] = useState<Record<string, { on: boolean; fee: string }>>(Object.fromEntries(zones.map(z => {
    const s = served0.find(x => x.zone_id === z.id); return [z.id, { on: !!s, fee: s?.fee_usd == null ? '' : String(s.fee_usd) }];
  })));
  const servedCount = Object.values(served).filter(v => v.on).length;
  const [f, setF] = useState({
    name_ar: shop.name.ar ?? '', name_en: shop.name.en ?? '', desc_ar: shop.description?.ar ?? '', desc_en: shop.description?.en ?? '',
    phone: shop.phone ?? '', whatsapp: shop.whatsapp ?? '', address_text: shop.address_text ?? '',
    min_order: String(shop.min_order_usd ?? 0), prep: String(shop.prep_minutes ?? 30), pickup: shop.pickup_enabled !== false,
    logo_url: shop.logo_url ?? null as string | null, cover_url: shop.cover_url ?? null as string | null,
    override: shop.is_open_override === true ? 'open' : shop.is_open_override === false ? 'closed' : 'hours',
  });
  const [hours, setHours] = useState<Hours>((shop.opening_hours as Hours) ?? {});
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const dis = !canEdit;
  // sections as tabs, and a guard for edits that were not saved
  type Tab = 'details' | 'contact' | 'zones' | 'hours';
  const [tab, setTab] = useState<Tab>('details');
  const ask = useConfirm();
  const snap = JSON.stringify({ f, hours, served });
  const [base, setBase] = useState(snap);
  const dirty = canEdit && snap !== base;
  const dirtyIn = (keys: { f?: (keyof typeof f)[]; hours?: boolean; served?: boolean }) => {
    if (!dirty) return false;
    const b = JSON.parse(base) as { f: typeof f; hours: Hours; served: typeof served };
    return (keys.f ?? []).some(k => b.f[k] !== f[k]) || (!!keys.hours && JSON.stringify(b.hours) !== JSON.stringify(hours)) || (!!keys.served && JSON.stringify(b.served) !== JSON.stringify(served));
  };
  const tabDirty: Record<Tab, boolean> = {
    details: dirtyIn({ f: ['name_ar', 'name_en', 'desc_ar', 'desc_en', 'min_order', 'prep', 'pickup', 'logo_url', 'cover_url'] }),
    contact: dirtyIn({ f: ['phone', 'whatsapp', 'address_text'] }), zones: dirtyIn({ served: true }), hours: dirtyIn({ f: ['override'], hours: true }),
  };
  function discard() { const b = JSON.parse(base) as { f: typeof f; hours: Hours; served: typeof served }; setF(b.f); setHours(b.hours); setServed(b.served); setMsg(null); }
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };          // closing / reloading the tab
    const click = (e: MouseEvent) => {                                                            // links inside the app
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || e.defaultPrevented || (a.pathname === location.pathname && a.search === location.search)) return;
      e.preventDefault(); e.stopPropagation();
      void ask(L === 'ar' ? 'لديك تغييرات غير محفوظة. المغادرة بدون حفظ؟' : 'You have unsaved changes. Leave without saving?', { danger: true }).then(ok => { if (ok) { window.removeEventListener('beforeunload', warn); window.location.href = a.href; } });
    };
    window.addEventListener('beforeunload', warn); document.addEventListener('click', click, true);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', click, true); };
  }, [dirty, ask, L]);

  // quick pause switch — saved immediately (the merchant's panic button)
  async function setPaused(paused: boolean) {
    const override = paused ? false : null;
    setF(x => ({ ...x, override: paused ? 'closed' : 'hours' }));
    const { error } = await sb.from('shops').update({ is_open_override: override }).eq('id', shop.id);
    if (error) setMsg(friendlyError(error, L)); else { setBase(b => { const x = JSON.parse(b); x.f.override = paused ? 'closed' : 'hours'; return JSON.stringify(x); }); router.refresh(); }
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
      min_order_usd: Number(f.min_order) || 0, prep_minutes: Math.max(0, Number(f.prep) || 0), pickup_enabled: f.pickup,
      logo_url: f.logo_url, cover_url: f.cover_url, opening_hours: hours,
      is_open_override: f.override === 'open' ? true : f.override === 'closed' ? false : null,
    }).eq('id', shop.id);
    if (error) { setBusy(false); setMsg(friendlyError(error, L)); return; }
    // zones served: replace the shop's rows (upsert the kept ones, drop the unticked ones)
    const keep = Object.entries(served).filter(([, v]) => v.on).map(([zone_id, v]) => ({ shop_id: shop.id, zone_id, fee_usd: v.fee.trim() === '' ? null : Number(v.fee) }));
    const drop = Object.entries(served).filter(([, v]) => !v.on).map(([zone_id]) => zone_id);
    const r1 = keep.length ? await sb.from('shop_delivery_zones').upsert(keep, { onConflict: 'shop_id,zone_id' }) : { error: null };
    const r2 = drop.length ? await sb.from('shop_delivery_zones').delete().eq('shop_id', shop.id).in('zone_id', drop) : { error: null };
    setBusy(false);
    const zerr = r1.error ?? r2.error;
    if (zerr) { setMsg(friendlyError(zerr, L)); return; }
    setBase(JSON.stringify({ f, hours, served })); setMsg(labels.saved); router.refresh();
  }

  const paused = f.override === 'closed';
  return (
    <div className="stack">
      <h1 style={{ margin: 0, fontSize: 20 }}>{labels.myShop}</h1>

      <section className={`card row spread ${paused ? 'paused' : ''}`} style={{ alignItems: 'center' }}>
        <div><strong>{labels.pauseOrders}</strong><div className="muted" style={{ fontSize: 13 }}>{labels.pauseHint}</div></div>
        <button className={`switch ${paused ? 'on' : ''}`} aria-pressed={paused} disabled={dis} onClick={() => setPaused(!paused)} aria-label={labels.pauseOrders} />
      </section>

      <div className="subtabs" role="tablist">
        {([['details', `🏪 ${labels.shopDetails}`], ['contact', `📞 ${labels.contact}`], ['zones', `🗺 ${labels.zonesServed}${zones.length ? ` (${servedCount})` : ''}`], ['hours', `🕒 ${labels.openingHours}`]] as [Tab, string][]).map(([k, t]) =>
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t}{tabDirty[k] && <span className="dot" title={L === 'ar' ? 'غير محفوظ' : 'unsaved'} />}</button>)}
      </div>

      {tab === 'details' && <section className="card stack">
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
        <div className="row">
          <label className="row" style={{ gap: 10, cursor: 'pointer' }}><input type="checkbox" className="check" disabled={dis} checked={f.pickup} onChange={e => setF({ ...f, pickup: e.target.checked })} /> 🛍️ {labels.pickupEnabled}</label>
        </div>
      </section>}

      {tab === 'contact' && <section className="card stack">
        <strong>{labels.contact}</strong>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: 1 }}><label className="label">{labels.publicPhone}</label><input className="input" dir="ltr" inputMode="tel" disabled={dis} value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></div>
          <div style={{ flex: 1 }}><label className="label">{labels.whatsapp}</label><input className="input" dir="ltr" inputMode="tel" disabled={dis} value={f.whatsapp} onChange={e => setF({ ...f, whatsapp: e.target.value })} /></div>
        </div>
        <div><label className="label">{labels.addressText}</label><input className="input" disabled={dis} value={f.address_text} onChange={e => setF({ ...f, address_text: e.target.value })} /></div>
      </section>}

      {tab === 'zones' && <section className="card stack">
        <strong>🗺 {labels.zonesServed}</strong>
        <div className="muted" style={{ fontSize: 13 }}>{labels.zonesServedHint}</div>
        {zones.length === 0 && <div className="muted">{labels.noZonesYet}</div>}
        {zones.length > 0 && servedCount === 0 && <div className="pill warn" style={{ alignSelf: 'flex-start' }}>{labels.noZonesServed}</div>}
        {zones.map(z => (
          <div key={z.id} className="row" style={{ alignItems: 'center', gap: 10 }}>
            <label className="row" style={{ flex: 1, gap: 10, cursor: dis ? 'default' : 'pointer' }}>
              <input type="checkbox" className="check" disabled={dis} checked={served[z.id]?.on ?? false} onChange={e => setServed({ ...served, [z.id]: { ...served[z.id], on: e.target.checked } })} />
              {z.name} <span className="muted">(${z.fee_usd.toFixed(2)})</span>
            </label>
            <input className="input" style={{ width: 110 }} dir="ltr" inputMode="decimal" placeholder={labels.feeOverride} disabled={dis || !served[z.id]?.on}
              value={served[z.id]?.fee ?? ''} onChange={e => setServed({ ...served, [z.id]: { ...served[z.id], fee: e.target.value } })} />
          </div>
        ))}
      </section>}

      {tab === 'hours' && <section className="card stack">
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
      </section>}

      {!canEdit && <div className="card muted">🔒 {L === 'ar' ? 'يمكن لصاحب المحل فقط تعديل هذه البيانات.' : 'Only the shop owner can change these details.'}</div>}
      {/* always in view: the form is long and the button used to sit below everything */}
      {canEdit && <div className="savebar">
        {dirty && <span className="unsaved">● {L === 'ar' ? 'تغييرات غير محفوظة' : 'Unsaved changes'}</span>}
        {msg && !(dirty && msg === labels.saved) && <span className={msg === labels.saved ? 'ok' : 'error'}>{msg === labels.saved ? '✓ ' : ''}{msg}</span>}
        {dirty && <button className="btn ghost" disabled={busy} onClick={discard}>{L === 'ar' ? 'تراجع' : 'Discard'}</button>}
        <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? '…' : `💾 ${labels.save}`}</button>
      </div>}
    </div>
  );
}
