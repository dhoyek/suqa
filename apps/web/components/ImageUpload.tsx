'use client';
import { useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { uploadShopImage, deleteShopImage } from '@/lib/upload';
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

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const sb = supabaseBrowser();
      const url = await uploadShopImage(sb, shopId, kind, file);
      if (value) deleteShopImage(sb, value);
      onChange(url);
    } catch (e) { setErr(friendlyError(e, locale)); }
    setBusy(false);
  }
  async function remove() { if (value) deleteShopImage(supabaseBrowser(), value); onChange(null); }

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
        {value && <button type="button" className="btn ghost muted" disabled={busy} onClick={remove}>{labels.remove}</button>}
      </div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}
