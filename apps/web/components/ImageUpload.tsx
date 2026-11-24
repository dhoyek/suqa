'use client';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { uploadShopImage, deleteShopImage } from '@/lib/upload';
import { tidyItemPhoto } from '@/lib/photo-tidy';
import { friendlyError } from '@/lib/ui-text';
import type { Locale } from '@suqa/shared';

// Pick → compress → upload → onChange(url). Shows the current image with change/remove.
// `autoClean` (items only, a setting of the device): after a new photo is in, the background removal starts by itself and the
// before / after choice opens — still a choice, never applied silently. `ref.take(file)` lets the item editor hand over the photo
// it just read the names from, so one photo does both jobs.
export type ImageUploadHandle = { take(file: File): Promise<void> };
type Props = {
  shopId: string; kind: 'logo' | 'cover' | 'product'; value: string | null; onChange: (url: string | null) => void; locale: Locale;
  labels: { add: string; change: string; remove: string }; shape?: 'wide' | 'square'; autoClean?: boolean;
};
const ImageUpload = forwardRef<ImageUploadHandle, Props>(function ImageUpload({ shopId, kind, value, onChange, locale, labels, shape = 'wide', autoClean = false }, ref) {
  const input = useRef<HTMLInputElement>(null); const camera = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // An ITEM photo is tidied on the device before it goes up: square, its light evened out (lib/photo-tidy.ts — free, offline,
  // no AI). The photo as taken is kept for this screen, so "as taken" puts it back if the crop cut something off.
  const taken = useRef<File | null>(null); const [tidied, setTidied] = useState(false);
  async function send(file: File, tidy: boolean) {
    setBusy(true); setErr(null);
    try {
      const sb = supabaseBrowser();
      const body = tidy ? new File([await tidyItemPhoto(file)], 'item.jpg', { type: 'image/jpeg' }) : file;
      const url = await uploadShopImage(sb, shopId, kind, body);
      if (value) deleteShopImage(sb, value);
      onChange(url); setTidied(tidy);
      setBusy(false); return url;
    } catch (e) { setErr(friendlyError(e, locale)); }
    setBusy(false); return null;
  }
  async function pick(file: File | undefined) {
    if (!file) return;
    taken.current = kind === 'product' ? file : null;
    const url = await send(file, kind === 'product');
    if (url && kind === 'product' && autoClean) void removeBackground(url);      // the setting: clean every new item photo, then let the person choose
  }
  useImperativeHandle(ref, () => ({ take: pick }));
  // "Remove background" (items only): the current picture goes to the AI and comes back on a clean white background. The AI
  // redraws the picture and can change small print, so it is NEVER applied by itself: both are shown and the person taps one.
  const [clean, setClean] = useState<{ before: string; after: string; blob: Blob } | null>(null); const [cleaning, setCleaning] = useState(false);
  const T = (ar: string, en: string) => (locale === 'ar' ? ar : en);
  const closeClean = () => { if (clean) URL.revokeObjectURL(clean.after); setClean(null); };
  async function removeBackground(from: string | null = value) {
    if (!from || cleaning) return;
    setCleaning(true); setErr(null);
    try {
      const src = await fetch(from).then(r => (r.ok ? r.blob() : Promise.reject(new Error('no_image'))));
      const form = new FormData(); form.append('shop_id', shopId); form.append('image', new Blob([src], { type: 'image/jpeg' }), 'item.jpg');
      const res = await fetch('/api/pos/item-photo-clean', { method: 'POST', body: form });
      if (res.ok && (res.headers.get('content-type') ?? '').startsWith('image/')) { const blob = await res.blob(); setClean({ before: from, after: URL.createObjectURL(blob), blob }); }
      else {
        const j = (await res.json().catch(() => ({}))) as { reason?: string };
        setErr(j.reason === 'off' ? T('إزالة الخلفية غير متاحة الآن.', 'Background removal is not available right now.')
          : j.reason === 'cap' || j.reason === 'rate' ? T('وصل المحل إلى حدّ الاستخدام لهذا اليوم.', 'The shop has reached its usage limit for now.')
          : T('لم أستطع تحسين الصورة. جرّب مرة أخرى.', 'I could not clean the photo. Try again.'));
      }
    } catch { setErr(T('لم أستطع تحسين الصورة. جرّب مرة أخرى.', 'I could not clean the photo. Try again.')); }
    setCleaning(false);
  }
  async function keepCleaned() {
    if (!clean) return;
    setBusy(true); setErr(null);
    try {
      const sb = supabaseBrowser();
      const url = await uploadShopImage(sb, shopId, kind, new File([clean.blob], 'item.jpg', { type: clean.blob.type || 'image/jpeg' }));
      if (clean.before) deleteShopImage(sb, clean.before);
      taken.current = null; onChange(url); closeClean();
    } catch (e) { setErr(friendlyError(e, locale)); }
    setBusy(false);
  }
  async function remove() { if (value) deleteShopImage(supabaseBrowser(), value); taken.current = null; onChange(null); }

  return (
    <div className={`imgup ${shape}`}>
      <div className="imgup-box" onClick={() => !busy && input.current?.click()} role="button" aria-busy={busy} title={value ? labels.change : labels.add}>
        {value ? <img src={value} alt="" /> : <span className="muted">{busy ? '…' : `+ ${labels.add}`}</span>}
      </div>
      {/* two inputs: one opens the photos / files of the device, the other goes straight to the camera (phones) */}
      <input ref={input} type="file" accept="image/*" hidden onChange={e => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={e => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => input.current?.click()}>🖼 {locale === 'ar' ? 'من الصور' : 'Gallery'}</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => camera.current?.click()}>📷 {locale === 'ar' ? 'الكاميرا' : 'Camera'}</button>
        {value && taken.current && <button type="button" className="btn ghost" disabled={busy} onClick={() => void send(taken.current!, !tidied)}>{tidied ? (locale === 'ar' ? '↺ كما التُقطت' : '↺ As taken') : (locale === 'ar' ? '✨ تحسين' : '✨ Tidy')}</button>}
        {value && kind === 'product' && <button type="button" className="btn ghost" disabled={busy || cleaning} onClick={() => void removeBackground()}>{cleaning ? T('… أنظّف الصورة', '… cleaning') : T('🪄 إزالة الخلفية', '🪄 Remove background')}</button>}
        {value && <button type="button" className="btn ghost muted" disabled={busy} onClick={remove}>{labels.remove}</button>}
      </div>
      {err && <div className="error">{err}</div>}
      {clean && (
        <div className="dlg-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) closeClean(); }}>
          <div className="dlg card" role="dialog" aria-label={T('اختر الصورة', 'Choose the picture')}>
            <strong>{T('اختر الصورة التي تريدها', 'Choose the picture to keep')}</strong>
            <span className="muted" style={{ fontSize: 13 }}>{T('الصورة المنظّفة يعيد رسمها الذكاء الاصطناعي: تأكّد أن الاسم والكتابة على العبوة صحيحان.', 'The cleaned picture is redrawn by AI: check that the name and the writing on the pack are right.')}</span>
            <div className="clean-pair">
              <button type="button" className="clean-pick" disabled={busy} onClick={closeClean}><img src={clean.before} alt="" /><span>{T('الأصلية', 'Original')}</span></button>
              <button type="button" className="clean-pick" disabled={busy} onClick={() => void keepCleaned()}><img src={clean.after} alt="" /><span>✨ {T('المنظّفة', 'Cleaned')}{busy ? ' …' : ''}</span></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
export default ImageUpload;
