'use client';
// Offers (script 130), step 1: bundles — a named set of items sold together for one price. The owner's screen.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fmtLbp, fmtUsd, num, text, type CatalogIndex, type Offer, type Product, type Rate } from '@suqa/pos-core';
import type { L } from '../i18n';
import type { Booted } from '../lib/boot';
import Modal from '../components/Modal';
import NumInput from '../components/NumInput';
import ImageUpload from '@/components/ImageUpload';
import { cachedOffers, fetchOffers, tillBundle } from '../lib/offers';

const ERR: Record<string, [string, string]> = {
  not_owner: ['العروض يضيفها صاحب المحل فقط.', 'Only the shop owner can change offers.'],
  offer_name_required: ['اكتب اسم العرض.', 'Give the bundle a name.'],
  offer_name_too_long: ['الاسم طويل (80 حرفاً كحدّ أقصى).', 'The name is too long (80 characters at most).'],
  offer_price_required: ['اكتب سعر العرض.', 'Enter the bundle price.'],
  offer_items_required: ['أضف صنفاً واحداً على الأقل.', 'Add at least one item.'],
  offer_too_many_items: ['20 صنفاً كحدّ أقصى في العرض.', 'At most 20 items in a bundle.'],
  offer_item_unknown: ['أحد الأصناف لم يعد موجوداً.', 'One of the items no longer exists.'],
  offer_mixed_currency: ['كل أصناف العرض يجب أن تكون مسعّرة بالعملة نفسها (كلها بالدولار أو كلها بالليرة).', 'Every item in a bundle must be priced in the same currency (all dollars or all lira).'],
  offer_bad_quantity: ['الكمية عدد صحيح بين 1 و99.', 'A quantity is a whole number from 1 to 99.'],
  offer_needs_two: ['العرض يحتاج قطعتين على الأقل (صنفان، أو صنف بكمية 2 أو أكثر).', 'A bundle needs at least two units (two items, or one item × 2 or more).'],
  offer_no_saving: ['سعر العرض يجب أن يكون أقل من مجموع أسعار الأصناف.', 'The bundle price must be below the items\' normal total.'],
  offer_not_found: ['العرض لم يعد موجوداً.', 'This offer no longer exists.'],
};
const WHY: Record<string, [string, string]> = {
  off: ['متوقف', 'Paused'], not_yet: ['لم يبدأ بعد', 'Not started yet'], ended: ['انتهى', 'Ended'], empty: ['بلا أصناف', 'No items'],
  item: ['صنف غير متوفر الآن', 'An item is not available now'], currency: ['أصناف بعملتين', 'Items in two currencies'], no_saving: ['لا يوجد توفير', 'No saving'],
};

type Row = { p: Product; qty: number };
type Form = { id?: string; ar: string; en: string; dAr: string; dEn: string; img: string | null; rows: Row[]; price: number | null; hot: boolean; active: boolean; starts: string; ends: string; max: number | null };
const localDT = (iso?: string | null) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

export default function OffersView({ boot, sb, locale, index, online, tick }: { boot: Booted; sb: SupabaseClient; locale: L; index: CatalogIndex; online: boolean; tick: number }) {
  const T = (ar: string, en: string) => (locale === 'ar' ? ar : en);
  const [offers, setOffers] = useState<Offer[]>(() => cachedOffers(boot.shop.id));
  const [ready, setReady] = useState<boolean | null>(null);        // null = not asked yet, false = the server has no offers table / offline
  const [rate, setRate] = useState(89500);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [q, setQ] = useState(''); const [ask, setAsk] = useState<Offer | null>(null);
  useEffect(() => { boot.db.rates.orderBy('effective_at').reverse().first().then((r: Rate | undefined) => { if (r) setRate(r.lbp_per_usd); }); }, [boot]);
  const reload = useCallback(async () => { const list = await fetchOffers(sb, boot.shop.id); setReady(!!list); if (list) setOffers(list); }, [sb, boot]);
  useEffect(() => { if (online) void reload(); }, [online, reload]);
  const views = useMemo(() => offers.filter(o => o.kind === 'bundle').map(o => tillBundle(o, index, rate)), [offers, index, rate, tick]);   // eslint-disable-line react-hooks/exhaustive-deps
  const money = (v: number, unit: 'cents' | 'lbp') => (unit === 'lbp' ? fmtLbp(v, locale) : fmtUsd(v));

  const open = (o?: Offer) => { setErr(''); setQ(''); setForm(o
    ? { id: o.id, ar: o.name?.ar ?? '', en: o.name?.en ?? '', dAr: o.description?.ar ?? '', dEn: o.description?.en ?? '', img: o.image_url ?? null, price: o.price_currency === 'lbp' ? num(o.price_lbp) : num(o.price_usd), hot: o.is_hot, active: o.is_active, starts: localDT(o.starts_at), ends: localDT(o.ends_at), max: o.max_per_order ?? null,
        rows: [...o.items].sort((a, b) => num(a.sort_order) - num(b.sort_order)).map(it => ({ p: index.byId.get(it.product_id)!, qty: num(it.quantity) })).filter(r => r.p) }
    : { ar: '', en: '', dAr: '', dEn: '', img: null, rows: [], price: null, hot: false, active: true, starts: '', ends: '', max: null }); };
  // the bundle's currency is its items' currency
  const cur = form?.rows[0]?.p.price_currency === 'lbp' ? 'lbp' : 'usd';
  const mixed = !!form && form.rows.some(r => (r.p.price_currency ?? 'usd') !== cur);
  const normal = form ? form.rows.reduce((s, r) => s + r.qty * (cur === 'lbp' ? num(r.p.price_lbp) : Math.round(num(r.p.price_usd) * 100)), 0) : 0;   // lira, or cents
  const priceMinor = form?.price != null ? (cur === 'lbp' ? Math.round(form.price) : Math.round(form.price * 100)) : 0;
  const saving = normal - priceMinor; const units = form ? form.rows.reduce((s, r) => s + r.qty, 0) : 0;
  const hits = useMemo(() => (q.trim() && form ? index.search(q, 8).filter(p => !form.rows.some(r => r.p.id === p.id)) : []), [q, form, index]);
  const patch = (x: Partial<Form>) => setForm(f => (f ? { ...f, ...x } : f));
  const canSave = !!form && (form.ar.trim() || form.en.trim()) && units >= 2 && !mixed && priceMinor > 0 && saving > 0;

  const save = async () => {
    if (!form || busy) return; setBusy(true); setErr('');
    const { error } = await sb.rpc('offer_save', { p_shop: boot.shop.id, p: { ...(form.id ? { id: form.id } : {}), name: { ar: form.ar.trim(), en: form.en.trim() }, description: { ar: form.dAr.trim().slice(0, 300), en: form.dEn.trim().slice(0, 300) }, image_url: form.img ?? '', price_currency: cur, price: form.price,
      is_active: form.active, is_hot: form.hot, starts_at: form.starts ? new Date(form.starts).toISOString() : '', ends_at: form.ends ? new Date(form.ends).toISOString() : '', max_per_order: form.max ? String(Math.round(form.max)) : '',
      items: form.rows.map(r => ({ product_id: r.p.id, quantity: r.qty })) } });
    setBusy(false);
    if (error) { const k = Object.keys(ERR).find(c => error.message.includes(c)); setErr(k ? T(...ERR[k]) : /offer_save|schema cache|does not exist/i.test(error.message) ? T('العروض غير مفعّلة بعد.', 'Offers are not switched on yet.') : error.message); return; }
    setForm(null); await reload();
  };
  const toggle = async (o: Offer, x: { is_active?: boolean; is_hot?: boolean }) => {
    setBusy(true);
    const { error } = await sb.rpc('offer_save', { p_shop: boot.shop.id, p: { id: o.id, name: o.name, description: o.description ?? {}, image_url: o.image_url ?? '', price_currency: o.price_currency, price: o.price_currency === 'lbp' ? num(o.price_lbp) : num(o.price_usd),
      is_active: x.is_active ?? o.is_active, is_hot: x.is_hot ?? o.is_hot, starts_at: o.starts_at ?? '', ends_at: o.ends_at ?? '', max_per_order: o.max_per_order ? String(o.max_per_order) : '', items: o.items.map(i => ({ product_id: i.product_id, quantity: num(i.quantity) })) } });
    setBusy(false); if (error) { const k = Object.keys(ERR).find(c => error.message.includes(c)); setErr(k ? T(...ERR[k]) : error.message); } else await reload();
  };
  const remove = async (o: Offer) => { setBusy(true); const { error } = await sb.rpc('offer_delete', { p_offer: o.id }); setBusy(false); setAsk(null); if (error) setErr(error.message); else await reload(); };

  return (
    <div className="stack offers-view">
      <div className="row spread" style={{ alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>🎁 {T('العروض', 'Offers')} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>{views.length ? `(${views.length})` : ''}</span></h2>
        <button className="btn primary" disabled={!online || ready === false} onClick={() => open()}>＋ {T('عرض جديد (مجموعة)', 'New bundle')}</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{T('المجموعة: عدة أصناف تُباع معاً بسعر واحد أقل من مجموع أسعارها. تظهر أولاً في صفحة المحل، وتُباع من شاشة البيع بزر 🎁.', 'A bundle: several items sold together for one price below their total. It shows first on the shop page and is sold from the sale screen with the 🎁 button.')}</p>
      {!online && <div className="pill warn">{T('غير متصل: يمكن بيع العروض المحفوظة، وتعديلها يحتاج اتصالاً.', 'Offline: saved offers can be sold; changing them needs a connection.')}</div>}
      {online && ready === false && <div className="pill warn">{T('العروض غير مفعّلة بعد على الخادم.', 'Offers are not switched on yet on the server.')}</div>}
      {err && !form && <div className="error">{err}</div>}
      {!views.length && ready !== false && <div className="card muted">{T('لا عروض بعد. أضف أول مجموعة.', 'No offers yet. Add the first bundle.')}</div>}
      <div className="offers-grid">
        {views.map(v => { const o = v.offer; return (
          <div key={o.id} className={`card offer-card ${v.ok ? '' : 'off'}`}>
            <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              {o.image_url ? <img className="offer-pic" src={o.image_url} alt="" /> : <div className="offer-pic none">🎁</div>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row spread" style={{ gap: 6 }}><strong>{o.is_hot ? '🔥 ' : ''}{text(o.name, locale)}</strong>{!v.ok && <span className="pill warn" style={{ fontSize: 11 }}>{T(...(WHY[v.why ?? 'off'] ?? WHY.off))}</span>}</div>
                <div className="muted" style={{ fontSize: 13 }}>{v.lines.map(l => `${l.quantity}× ${text(l.product.name, locale)}`).join(' · ') || '—'}</div>
                {text(o.description ?? {}, locale) && <div className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>{text(o.description ?? {}, locale)}</div>}
                <div style={{ marginTop: 4 }}>{v.normal > v.charged && <s className="muted" style={{ marginInlineEnd: 8 }}>{money(v.normal, v.unit)}</s>}<strong className="offer-price">{money(v.charged, v.unit)}</strong>{v.saving > 0 && v.ok && <span className="pill ok" style={{ marginInlineStart: 8, fontSize: 11 }}>−{v.pct}%</span>}</div>
                {(o.starts_at || o.ends_at || o.max_per_order) && <div className="muted" style={{ fontSize: 12 }}>{o.starts_at ? `${T('من', 'from')} ${new Date(o.starts_at).toLocaleString(locale === 'ar' ? 'ar-LB' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })} ` : ''}{o.ends_at ? `${T('حتى', 'until')} ${new Date(o.ends_at).toLocaleString(locale === 'ar' ? 'ar-LB' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })} ` : ''}{o.max_per_order ? `· ${T('حدّ', 'max')} ${o.max_per_order} ${T('بالطلب', 'per order')}` : ''}</div>}
              </div>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              <button className="btn" disabled={!online || busy} onClick={() => open(o)}>✎ {T('تعديل', 'Edit')}</button>
              <button className="btn" disabled={!online || busy} onClick={() => void toggle(o, { is_active: !o.is_active })}>{o.is_active ? `⏸ ${T('إيقاف', 'Pause')}` : `▶ ${T('تشغيل', 'Resume')}`}</button>
              <button className="btn" disabled={!online || busy} onClick={() => void toggle(o, { is_hot: !o.is_hot })}>{o.is_hot ? T('إزالة 🔥', 'Remove 🔥') : `🔥 ${T('عرض ساخن', 'Hot')}`}</button>
              <span style={{ flex: 1 }} />
              <button className="btn danger" disabled={!online || busy} onClick={() => setAsk(o)}>🗑</button>
            </div>
          </div>); })}
      </div>

      {form && <Modal open onClose={() => setForm(null)} wide title={form.id ? T('تعديل المجموعة', 'Edit bundle') : T('مجموعة جديدة', 'New bundle')}
        footer={<><button className="btn" onClick={() => setForm(null)}>{T('إلغاء', 'Cancel')}</button><span style={{ flex: 1 }} /><button className="btn primary" disabled={!canSave || busy} onClick={() => void save()}>✓ {T('حفظ', 'Save')}</button></>}>
        <div className="stack">
          <div className="form-grid">
            <label className="label">{T('اسم العرض (عربي)', 'Name (Arabic)')}<input className="input" dir="rtl" maxLength={80} value={form.ar} onChange={e => patch({ ar: e.target.value })} placeholder="فطور الصبح" /></label>
            <label className="label">{T('اسم العرض (إنكليزي)', 'Name (English)')}<input className="input" dir="ltr" maxLength={80} value={form.en} onChange={e => patch({ en: e.target.value })} placeholder="Breakfast deal" /></label>
            <label className="label">{T('وصف قصير (عربي، اختياري)', 'Short description (Arabic, optional)')}<textarea className="input" dir="rtl" rows={2} maxLength={300} value={form.dAr} onChange={e => patch({ dAr: e.target.value })} placeholder="فطور كامل لشخصين" /></label>
            <label className="label">{T('وصف قصير (إنكليزي، اختياري)', 'Short description (English, optional)')}<textarea className="input" dir="ltr" rows={2} maxLength={300} value={form.dEn} onChange={e => patch({ dEn: e.target.value })} placeholder="A full breakfast for two" /></label>
          </div>
          <div className="label">{T('أصناف المجموعة', 'Items in the bundle')}
            {form.rows.map(r => (
              <div key={r.p.id} className="row offer-row" style={{ gap: 8, alignItems: 'center' }}>
                <span style={{ flex: 1, minWidth: 0 }}>{text(r.p.name, locale)} <small className="muted">{r.p.price_currency === 'lbp' ? fmtLbp(num(r.p.price_lbp), locale) : fmtUsd(Math.round(num(r.p.price_usd) * 100))}</small></span>
                <span className="qty-btns"><button className="btn" onClick={() => patch({ rows: form.rows.map(x => (x.p.id === r.p.id ? { ...x, qty: Math.max(1, x.qty - 1) } : x)) })}>−</button><strong style={{ minWidth: 24, textAlign: 'center' }}>{r.qty}</strong><button className="btn" onClick={() => patch({ rows: form.rows.map(x => (x.p.id === r.p.id ? { ...x, qty: Math.min(99, x.qty + 1) } : x)) })}>+</button></span>
                <button className="btn ghost" onClick={() => patch({ rows: form.rows.filter(x => x.p.id !== r.p.id) })}>✕</button>
              </div>))}
            <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder={T('＋ أضف صنفاً — اكتب الاسم أو امسح الباركود', '＋ Add an item — type its name or scan')} />
            {hits.length > 0 && <div className="offer-hits">{hits.map(p => <button key={p.id} className="btn ghost" onClick={() => { patch({ rows: [...form.rows, { p, qty: 1 }] }); setQ(''); }}>{text(p.name, locale)} <small className="muted">{p.price_currency === 'lbp' ? fmtLbp(num(p.price_lbp), locale) : fmtUsd(Math.round(num(p.price_usd) * 100))}</small></button>)}</div>}
          </div>
          {mixed && <div className="error">{T(...ERR.offer_mixed_currency)}</div>}
          <div className="form-grid">
            <label className="label">{T('سعر المجموعة', 'Bundle price')} ({cur === 'lbp' ? T('ل.ل.', 'LBP') : '$'})
              <NumInput className="input" value={form.price} onChange={v => patch({ price: v })} empty />
            </label>
            <div className="label">{T('السعر العادي ← سعر العرض', 'Normal price → bundle price')}
              <div style={{ fontSize: 16, paddingTop: 6 }}>{normal > 0 ? <><s className="muted">{money(normal, cur === 'lbp' ? 'lbp' : 'cents')}</s> → <strong>{priceMinor > 0 ? money(priceMinor, cur === 'lbp' ? 'lbp' : 'cents') : '—'}</strong>{priceMinor > 0 && saving > 0 && <span className="pill ok" style={{ marginInlineStart: 8 }}>{T('توفير', 'saves')} {money(saving, cur === 'lbp' ? 'lbp' : 'cents')} (−{Math.round((saving * 100) / normal)}%)</span>}</> : <span className="muted">—</span>}</div>
              {priceMinor > 0 && normal > 0 && saving <= 0 && <small className="error">{T(...ERR.offer_no_saving)}</small>}
              {units === 1 && <small className="error">{T(...ERR.offer_needs_two)}</small>}
            </div>
          </div>
          <div className="form-grid">
            <label className="label">{T('يبدأ (اختياري)', 'Starts (optional)')}<input className="input" type="datetime-local" value={form.starts} onChange={e => patch({ starts: e.target.value })} /></label>
            <label className="label">{T('ينتهي (اختياري)', 'Ends (optional)')}<input className="input" type="datetime-local" value={form.ends} onChange={e => patch({ ends: e.target.value })} /></label>
            <label className="label">{T('حدّ أقصى بالطلب الواحد (اختياري)', 'At most per order (optional)')}<NumInput className="input" value={form.max} onChange={v => patch({ max: v })} empty /></label>
            <div className="label">{T('الظهور', 'Showing')}
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={form.active} onChange={e => patch({ active: e.target.checked })} /> {T('العرض شغّال', 'The offer is on')}</label>
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={form.hot} onChange={e => patch({ hot: e.target.checked })} /> 🔥 {T('عرض ساخن (يظهر أولاً)', 'Hot offer (shown first)')}</label>
            </div>
          </div>
          <div className="label">{T('صورة العرض (اختياري — وإلا تُستعمل صور الأصناف)', 'Picture (optional — otherwise the items\' pictures are used)')}
            {online ? <ImageUpload shopId={boot.shop.id} kind="product" value={form.img} onChange={u => patch({ img: u })} locale={locale} shape="square" labels={{ add: T('إضافة صورة', 'Add a picture'), change: T('تغيير', 'Change'), remove: T('إزالة', 'Remove') }} /> : null}
          </div>
          {err && <div className="error">{err}</div>}
        </div>
      </Modal>}
      {ask && <Modal open onClose={() => setAsk(null)} title={T('حذف العرض؟', 'Delete this offer?')}
        footer={<><button className="btn" onClick={() => setAsk(null)}>{T('إلغاء', 'Cancel')}</button><span style={{ flex: 1 }} /><button className="btn danger" disabled={busy} onClick={() => void remove(ask)}>🗑 {T('حذف', 'Delete')}</button></>}>
        <p>{text(ask.name, locale)} — {T('الطلبات السابقة لا تتأثر.', 'Past orders are not affected.')}</p>
      </Modal>}
    </div>
  );
}
