'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { Locale } from '@suqa/shared';

export default function SignupForm({ next, tenantId, locale, labels }: { next: string; tenantId: string; locale: Locale; labels: Record<'fullName' | 'phone' | 'email' | 'password' | 'createAccount' | 'failed' | 'checkEmail' | 'verifyPhoneTitle' | 'verifyPhoneHint' | 'enterCode' | 'verifyCode' | 'skipForNow' | 'invalidCode', string> }) {
  const [verify, setVerify] = useState<{ phone: string } | null>(null); const [code, setCode] = useState('');
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
      options: { data: { full_name: f.full_name.trim(), phone, tenant_id: tenantId, locale },
                 emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    setBusy(false);
    if (error) { setError(`${labels.failed}: ${error.message}`); return; }
    if (!data.session) { setError(labels.checkEmail); return; }
    // keep the phone on the profile too (auth.users.phone is only set by phone auth)
    await sb.from('profiles').update({ phone }).eq('id', data.user!.id);
    // Verify the WhatsApp number now and attach it to THIS account, so a later WhatsApp sign-in lands in the same
    // account instead of creating a duplicate. A code goes to the number; skipping is allowed.
    const { error: pe } = await sb.auth.updateUser({ phone });
    if (!pe) { setVerify({ phone }); return; }
    router.replace(next); router.refresh();
  }
  async function confirmPhone(e: React.FormEvent) {
    e.preventDefault(); if (!verify) return; setBusy(true); setError(null);
    const { error } = await supabaseBrowser().auth.verifyOtp({ phone: verify.phone, token: code.trim(), type: 'phone_change' });
    setBusy(false);
    if (error) { setError(labels.invalidCode); return; }
    router.replace(next); router.refresh();
  }
  if (verify) return (
    <form onSubmit={confirmPhone} className="stack">
      <h2 style={{ margin: 0 }}>{labels.verifyPhoneTitle}</h2>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>{labels.verifyPhoneHint} <bdi dir="ltr">{verify.phone}</bdi></p>
      <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} dir="ltr" required autoFocus value={code} onChange={e => setCode(e.target.value)} placeholder={labels.enterCode} style={{ letterSpacing: 6, textAlign: 'center', fontSize: 22 }} />
      {error && <div className="error" role="alert">{error}</div>}
      <button className="btn primary wide" disabled={busy || code.length < 6} type="submit">{labels.verifyCode}</button>
      <button className="btn wide" type="button" onClick={() => { router.replace(next); router.refresh(); }}>{labels.skipForNow}</button>
    </form>
  );

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
