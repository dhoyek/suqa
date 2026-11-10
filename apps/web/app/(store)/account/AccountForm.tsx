'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { normalizePhone } from '@/lib/whatsapp';

type Labels = Record<'fullName' | 'phoneNumber' | 'save' | 'saved' | 'changePhone' | 'sendCode' | 'codeSentTo' | 'enterCode' | 'verifyCode' | 'cancel' | 'invalid' | 'invalidCode' | 'phoneChanged' | 'phoneHint' | 'email', string>;

export default function AccountForm({ name: name0, phone: phone0, email, labels }: { name: string; phone: string; email: string; labels: Labels }) {
  const router = useRouter();
  const [name, setName] = useState(name0); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const [phone, setPhone] = useState(phone0);
  const [changing, setChanging] = useState(false); const [newPhone, setNewPhone] = useState(''); const [sentTo, setSentTo] = useState<string | null>(null); const [code, setCode] = useState('');

  async function saveName(e: React.FormEvent) {
    e.preventDefault(); setErr(null); setMsg(null); setBusy(true);
    const sb = supabaseBrowser(); const { data: u } = await sb.auth.getUser();
    const { error } = await sb.from('profiles').update({ full_name: name.trim() || null }).eq('id', u.user!.id);
    await sb.auth.updateUser({ data: { full_name: name.trim() || null } });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setMsg(labels.saved); router.refresh();
  }
  async function sendCode(e: React.FormEvent) {
    e.preventDefault(); setErr(null); setMsg(null);
    const n = normalizePhone(newPhone); if (!n) { setErr(labels.invalid); return; }
    setBusy(true);
    // Supabase sends a verification code to the NEW number (through the same WhatsApp hook as sign-in); the number only
    // changes once that code is entered, so nobody can point an account at a phone they don't hold.
    const { error } = await supabaseBrowser().auth.updateUser({ phone: `+${n}` });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setSentTo(`+${n}`);
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault(); setErr(null); setBusy(true);
    const sb = supabaseBrowser();
    const { error } = await sb.auth.verifyOtp({ phone: sentTo!, token: code.trim(), type: 'phone_change' });
    if (error) { setBusy(false); setErr(labels.invalidCode); return; }
    const { data: u } = await sb.auth.getUser();
    await sb.from('profiles').update({ phone: sentTo }).eq('id', u.user!.id);
    setBusy(false); setPhone(sentTo!); setChanging(false); setSentTo(null); setCode(''); setNewPhone(''); setMsg(labels.phoneChanged); router.refresh();
  }

  return (
    <div className="stack">
      <form onSubmit={saveName} className="card stack">
        <div><label className="label" htmlFor="nm">{labels.fullName}</label><input id="nm" className="input" value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></div>
        {email && <div><label className="label">{labels.email}</label><div className="muted" dir="ltr">{email}</div></div>}
        <button className="btn primary" disabled={busy} type="submit">{labels.save}</button>
      </form>

      <section className="card stack">
        <div className="row spread" style={{ alignItems: 'center' }}>
          <div><div className="label">{labels.phoneNumber}</div><strong dir="ltr">{phone ? `+${phone.replace(/^\+/, '')}` : '—'}</strong></div>
          {!changing && <button type="button" className="btn" onClick={() => { setChanging(true); setMsg(null); setErr(null); }}>{labels.changePhone}</button>}
        </div>
        {changing && !sentTo && (
          <form onSubmit={sendCode} className="stack">
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{labels.phoneHint}</p>
            <input className="input" type="tel" inputMode="tel" dir="ltr" required placeholder="+961 70 000 000" value={newPhone} onChange={e => setNewPhone(e.target.value)} autoFocus />
            <div className="row" style={{ gap: 8 }}><button className="btn primary" disabled={busy} type="submit">{labels.sendCode}</button><button className="btn" type="button" onClick={() => setChanging(false)}>{labels.cancel}</button></div>
          </form>
        )}
        {sentTo && (
          <form onSubmit={verify} className="stack">
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>{labels.codeSentTo} <bdi dir="ltr">{sentTo}</bdi></p>
            <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} dir="ltr" required autoFocus value={code} onChange={e => setCode(e.target.value)} style={{ letterSpacing: 6, textAlign: 'center', fontSize: 22 }} placeholder={labels.enterCode} />
            <div className="row" style={{ gap: 8 }}><button className="btn primary" disabled={busy || code.length < 6} type="submit">{labels.verifyCode}</button><button className="btn" type="button" onClick={() => { setSentTo(null); setCode(''); }}>{labels.cancel}</button></div>
          </form>
        )}
      </section>
      {err && <div className="error" role="alert">{err}</div>}
      {msg && <p className="muted">✓ {msg}</p>}
    </div>
  );
}
