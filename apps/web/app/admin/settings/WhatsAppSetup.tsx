'use client';
import { useState } from 'react';

/** Operator panel (tenant admin): which number this site sends from, where its incoming messages go, templates. */
export default function WhatsAppSetup({ ar }: { ar: boolean }) {
  const [out, setOut] = useState<string>(''); const [busy, setBusy] = useState(false);
  const run = async (label: string, url: string, init?: RequestInit) => {
    setBusy(true); setOut(label + ' …');
    try { const r = await fetch(url, init); setOut(`${label} → ${r.status}\n${JSON.stringify(await r.json().catch(() => ({})), null, 1)}`); }
    catch (e) { setOut(`${label} → ${(e as Error).message}`); } finally { setBusy(false); }
  };
  const post = (action: string) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
  return (
    <section className="card stack" id="wa-setup" style={{ marginTop: 16 }}>
      <b>WhatsApp · {ar ? 'ربط الحساب' : 'connection'}</b>
      <small className="muted">{ar ? 'للمشغّل فقط. «توجيه الرسائل الواردة إلى هذا الموقع» يجعل رسائل رقم هذا الموقع تصل إليه مهما كان عنوان التطبيق في Meta.' : 'Operator only. “Route incoming here” makes this site receive its own number’s messages whatever the app callback in Meta says.'}</small>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy} data-wa="status" onClick={() => run('status', '/api/wa/numbers')}>{ar ? 'الحالة' : 'Status'}</button>
        <button className="btn" disabled={busy} data-wa="route_here" onClick={() => run('route_here', '/api/wa/numbers', post('route_here'))}>{ar ? 'توجيه الرسائل الواردة إلى هذا الموقع' : 'Route incoming here'}</button>
        <button className="btn" disabled={busy} data-wa="route_default" onClick={() => run('route_default', '/api/wa/numbers', post('route_default'))}>{ar ? 'إلغاء التوجيه' : 'Remove routing'}</button>
        <button className="btn" disabled={busy} data-wa="templates" onClick={() => run('templates', '/api/wa/templates')}>{ar ? 'حالة القوالب' : 'Templates status'}</button>
        <button className="btn" disabled={busy} data-wa="templates_submit" onClick={() => run('templates_submit', '/api/wa/templates', { method: 'POST' })}>{ar ? 'إرسال القوالب الناقصة' : 'Submit missing templates'}</button>
      </div>
      {out && <pre data-wa="out" dir="ltr" style={{ fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', margin: 0 }}>{out}</pre>}
    </section>
  );
}
