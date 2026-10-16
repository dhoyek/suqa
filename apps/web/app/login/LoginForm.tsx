'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';

export default function LoginForm({ next, labels }: { next: string; labels: { email: string; password: string; signIn: string; invalid: string } }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const sb = supabaseBrowser();
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) { setError(labels.invalid); return; }
    router.replace(next); router.refresh();
  }

  return (
    <form onSubmit={submit} className="stack">
      <div><label className="label" htmlFor="email">{labels.email}</label>
        <input id="email" className="input" type="email" autoComplete="email" dir="ltr" required value={email} onChange={e => setEmail(e.target.value)} /></div>
      <div><label className="label" htmlFor="password">{labels.password}</label>
        <input id="password" className="input" type="password" autoComplete="current-password" dir="ltr" required value={password} onChange={e => setPassword(e.target.value)} /></div>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="btn primary wide" disabled={busy} type="submit">{labels.signIn}</button>
    </form>
  );
}
