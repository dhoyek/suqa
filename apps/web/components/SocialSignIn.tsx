'use client';
import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

export type Provider = 'google' | 'facebook' | 'apple';
// Providers are enabled per deploy with NEXT_PUBLIC_AUTH_PROVIDERS="google,facebook" (each must also be
// configured in Supabase → Authentication → Providers). Nothing renders until that is set.
export const ENABLED_PROVIDERS = ((process.env.NEXT_PUBLIC_AUTH_PROVIDERS ?? '').split(',').map(s => s.trim()).filter(Boolean) as Provider[]);

const ICON: Record<Provider, string> = {
  google: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="%23EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.8 6.1C12.3 13.6 17.7 9.5 24 9.5z"/><path fill="%234285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-4 7.2-9.9 7.2-16.9z"/><path fill="%23FBBC05" d="M10.4 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.6l-7.8-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.8-6.1z"/><path fill="%2334A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2.1 1.4-4.9 2.3-8.6 2.3-6.3 0-11.7-4.1-13.6-9.9l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/></svg>',
  facebook: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="%231877F2"/><path fill="%23fff" d="M13.5 24v-9h3l.5-3.5h-3.5V9.3c0-1 .3-1.7 1.8-1.7h1.9V4.5c-.3 0-1.5-.2-2.8-.2-2.8 0-4.6 1.7-4.6 4.8v2.4H6.7V15h3.1v9h3.7z"/></svg>',
  apple: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.3 1.2 9.7.8 1.2 1.8 2.5 3.1 2.4 1.2 0 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8-.1 0-2.7-1-2.7-3.8zM14 5.4c.7-.8 1.1-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4z"/></svg>',
};

export default function SocialSignIn({ next, labels }: { next: string; labels: { or: string; google: string; facebook: string; apple: string } }) {
  const [busy, setBusy] = useState<Provider | null>(null);
  if (!ENABLED_PROVIDERS.length) return null;
  async function go(p: Provider) {
    setBusy(p);
    const sb = supabaseBrowser();
    await sb.auth.signInWithOAuth({ provider: p, options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` } });
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="divider">{labels.or}</div>
      {ENABLED_PROVIDERS.map(p => (
        <button key={p} type="button" className="btn social wide" disabled={busy !== null} onClick={() => go(p)}>
          <img src={ICON[p]} alt="" width={18} height={18} /> {labels[p]}
        </button>
      ))}
    </div>
  );
}
