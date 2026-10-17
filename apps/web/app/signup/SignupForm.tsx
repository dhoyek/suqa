'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { Locale } from '@suqa/shared';

export default function SignupForm({ next, tenantId, locale, labels }: { next: string; tenantId: string; locale: Locale; labels: Record<'fullName' | 'phone' | 'email' | 'password' | 'createAccount' | 'failed' | 'checkEmail', string> }) {
  const router = useRouter();
  const [f, setF] = useState({ full_name: '', phone: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const sb = supabaseBrowser();
    const phone = f.phone.trim().replace(/[\s-]/g, '').replace(/^0/, '+961').replace(/^961/, '+961');
    const { data, error } = await sb.auth.signUp({
      email: f.email.trim(), password: f.password,
      options: { data: { full_name: f.full_name.trim(), phone, tenant_id: tenantId, locale } },
    });
    setBusy(false);
    if (error) { setError(`${labels.failed}: ${error.message}`); return; }
    if (!data.session) { setError(labels.checkEmail); return; }
    // keep the phone on the profile too (auth.users.phone is only set by phone auth)
    await sb.from('profiles').update({ phone }).eq('id', data.user!.id);
    router.replace(next); router.refresh();
  }

  return (
    <form onSubmit={submit} className="stack">
      <div><label className="label">{labels.fullName}</label><input className="input" required value={f.full_name} onChange={e => setF({ ...f, full_name: e.target.value })} /></div>
      <div><label className="label">{labels.phone}</label><input className="input" dir="ltr" inputMode="tel" placeholder="03 123 456" required value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></div>
      <div><label className="label">{labels.email}</label><input className="input" dir="ltr" type="email" autoComplete="email" required value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></div>
      <div><label className="label">{labels.password}</label><input className="input" dir="ltr" type="password" autoComplete="new-password" minLength={6} required value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></div>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="btn primary wide" disabled={busy} type="submit">{labels.createAccount}</button>
    </form>
  );
}
