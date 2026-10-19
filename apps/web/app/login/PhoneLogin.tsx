'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { normalizePhone } from '@/lib/whatsapp';

type Labels = { phoneNumber: string; sendCode: string; codeSentTo: string; enterCode: string; verifyCode: string; changeNumber: string; invalidCode: string; invalid: string };

// Passwordless sign-in: Supabase phone OTP, delivered over WhatsApp by /api/auth/sms-hook.
export default function PhoneLogin({ next, tenantId, brand, labels }: { next: string; tenantId: string; brand: string; labels: Labels }) {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    const n = normalizePhone(phone);
    if (!n) { setError(labels.invalid); return; }
    setBusy(true);
    const { error } = await supabaseBrowser().auth.signInWithOtp({ phone: `+${n}`, options: { channel: 'sms', data: { tenant_id: tenantId, brand } } });
    setBusy(false);
    if (error) { setError(error.message); return; }
    setSentTo(`+${n}`);
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    const { error } = await supabaseBrowser().auth.verifyOtp({ phone: sentTo!, token: code.trim(), type: 'sms' });
    setBusy(false);
    if (error) { setError(labels.invalidCode); return; }
    router.replace(next); router.refresh();
  }

  if (sentTo) return (
    <form onSubmit={verify} className="stack">
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>{labels.codeSentTo} <bdi dir="ltr">{sentTo}</bdi></p>
      <div><label className="label" htmlFor="otp">{labels.enterCode}</label>
        <input id="otp" className="input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} dir="ltr" required autoFocus value={code} onChange={e => setCode(e.target.value)} style={{ letterSpacing: 6, textAlign: 'center', fontSize: 22 }} /></div>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="btn primary wide" disabled={busy || code.length < 6} type="submit">{labels.verifyCode}</button>
      <button className="btn wide" type="button" onClick={() => { setSentTo(null); setCode(''); }}>{labels.changeNumber}</button>
    </form>
  );
  return (
    <form onSubmit={send} className="stack">
      <div><label className="label" htmlFor="phone">{labels.phoneNumber}</label>
        <input id="phone" className="input" type="tel" autoComplete="tel" inputMode="tel" dir="ltr" required placeholder="+961 70 000 000" value={phone} onChange={e => setPhone(e.target.value)} /></div>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="btn primary wide" disabled={busy} type="submit">{labels.sendCode}</button>
    </form>
  );
}
