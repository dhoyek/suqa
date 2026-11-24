'use client';
import { useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { uploadShopImage, deleteShopImage } from '@/lib/upload';
import { tidyItemPhoto } from '@/lib/photo-tidy';
import { friendlyError } from '@/lib/ui-text';
import type { Locale } from '@suqa/shared';

// Pick → compress → upload → onChange(url). Shows the current image with change/remove.
export default function ImageUpload({ shopId, kind, value, onChange, locale, labels, shape = 'wide' }: {
  shopId: string; kind: 'logo' | 'cover' | 'product'; value: string | null; onChange: (url: string | null) => void; locale: Locale;
  labels: { add: string; change: string; remove: string }; shape?: 'wide' | 'square';
}) {
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
    } catch (e) { setErr(friendlyError(e, locale)); }
    setBusy(false);
  }
  async function pick(file: File | undefined) {
    if (!file) return;
    taken.current = kind === 'product' ? file : null;
    await send(file, kind === 'product');
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
        {value && <button type="button" className="btn ghost muted" disabled={busy} onClick={remove}>{labels.remove}</button>}
      </div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}
