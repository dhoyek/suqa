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
  const input = useRef<HTMLInputElement>(null);
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
      <div className="imgup-box" onClick={() => !busy && input.current?.click()} role="button" aria-busy={busy}>
        {value ? <img src={value} alt="" /> : <span className="muted">{busy ? '…' : `+ ${labels.add}`}</span>}
      </div>
      <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={e => pick(e.target.files?.[0])} />
      <div className="row" style={{ gap: 6 }}>
        {value && <button type="button" className="btn ghost" disabled={busy} onClick={() => input.current?.click()}>{labels.change}</button>}
        {value && <button type="button" className="btn ghost muted" disabled={busy} onClick={remove}>{labels.remove}</button>}
      </div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}
