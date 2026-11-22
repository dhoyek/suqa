'use client';
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useNotify } from '@/components/ConfirmProvider';
import type { Route } from '@/lib/ai/routes';

type Row = Route & { updated_at: string | null };
type Test = { status?: 'ok' | 'nothing' | 'too_long' | 'failed'; text?: string; model?: string; cost_usd?: number; ms?: number; seconds?: number | null; audio_tokens?: number; error?: string; priced?: boolean };
const TASKS: Record<string, { ar: string; en: string }> = {
  chat: { ar: 'المحادثة (يورغو)', en: 'Chat (Yorgo)' }, voice: { ar: 'الرسائل الصوتية ← نص', en: 'Voice notes → text' },
  photo_read: { ar: 'قراءة الصور', en: 'Photo reading' }, image_generate: { ar: 'توليد الصور', en: 'Image generation' }, image_cleanup: { ar: 'تنظيف الصور', en: 'Image clean-up' }, bulk_cleanup: { ar: 'تنظيف بالجملة', en: 'Bulk clean-up' },
};
const price = (v: number | null) => (v == null ? '' : String(v));

export default function Providers({ locale, keys, routes }: { locale: 'ar' | 'en'; keys: { google: boolean; anthropic: boolean }; routes: Row[] }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const notify = useNotify();
  const T = (a: string, e: string) => (locale === 'ar' ? a : e);
  const [rows, setRows] = useState<Row[]>(routes);
  const [saved, setSaved] = useState<Row[]>(routes);
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<Test | null>(null);
  const [testing, setTesting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const set = (task: string, patch: Partial<Row>) => setRows(l => l.map(r => (r.task === task ? { ...r, ...patch } : r)));
  const numIn = (r: Row, k: 'price_in_per_m' | 'price_out_per_m' | 'price_audio_per_m') =>
    <input className="input" type="number" min="0" step="0.01" inputMode="decimal" style={{ maxWidth: 110 }} value={price(r[k])} onChange={e => set(r.task, { [k]: e.target.value === '' ? null : Number(e.target.value) })} />;

  async function save(r: Row) {
    setBusy(r.task);
    const fb = (r.fallback_model ?? '').trim();
    const { data, error } = await sb.from('yorgo_ai_routes').update({
      provider: r.provider, model: r.model.trim(), fallback_provider: fb ? (r.fallback_provider ?? r.provider) : null, fallback_model: fb || null, enabled: r.enabled,
      price_in_per_m: r.price_in_per_m, price_out_per_m: r.price_out_per_m, price_audio_per_m: r.price_audio_per_m, notes: (r.notes ?? '').trim() || null,
    }).eq('task', r.task).select('task');
    setBusy(null);
    if (error || !data?.length) {
      const m = error?.message ?? '';
      notify(/yorgo_ai_routes_priced/.test(m) ? T('لا يمكن التشغيل قبل إدخال الأسعار (سعر الإخراج وسعر الصوت أو الإدخال).', 'It cannot be switched on before its prices are filled (output, and audio or input).')
        : /voice_provider/.test(m) ? T('الصوت يحتاج مزوّداً يقبل الصوت (Google).', 'Voice needs a provider that takes sound (Google).') : T('تعذّر الحفظ.', 'Could not save.'));
      return;
    }
    setSaved(l => l.map(x => (x.task === r.task ? r : x)));
    notify(T('تم الحفظ. يُطبَّق خلال دقيقة.', 'Saved. It applies within a minute.'));
  }

  async function runTest() {
    const f = file.current?.files?.[0]; if (!f) return;
    setTesting(true); setTest(null);
    try {
      const body = new FormData(); body.append('file', f);
      const res = await fetch('/api/admin/yorgo/voice-test', { method: 'POST', body });
      const j = await res.json().catch(() => ({})) as Test & { error?: string };
      setTest(res.ok ? j : { status: 'failed', error: j.error ?? `http_${res.status}` });
    } catch { setTest({ status: 'failed', error: 'network' }); }
    setTesting(false);
  }

  return (
    <div className="stack">
      <div className="row spread" style={{ alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>🧠 {T('مزوّدو الذكاء الاصطناعي', 'AI providers')}</h2>
        <Link href="/admin/yorgo" className="btn ghost">← Yorgo</Link>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{T('أي مزوّد ونموذج لكل مهمة. المفاتيح لا تُحفظ هنا: هي أسرار في إعدادات الموقع.', 'Which provider and model does each task. Keys are not kept here: they are secrets in the site settings.')}
        {' '}Google: {keys.google ? '✅' : T('❌ لا مفتاح (GOOGLE_AI_API_KEY)', '❌ no key (GOOGLE_AI_API_KEY)')} · Anthropic: {keys.anthropic ? '✅' : '❌'}</p>

      {rows.map(r => { const was = saved.find(x => x.task === r.task)!; const dirty = JSON.stringify(r) !== JSON.stringify(was); const chat = r.task === 'chat'; return (
        <div key={r.task} className="card stack">
          <div className="row spread" style={{ alignItems: 'center' }}>
            <strong>{TASKS[r.task]?.[locale] ?? r.task}</strong>
            {chat ? <span className="muted" style={{ fontSize: 13 }}>{T('للعرض فقط في هذه المرحلة', 'shown only, in this step')}</span>
              : <label className="row"><input type="checkbox" checked={r.enabled} onChange={e => set(r.task, { enabled: e.target.checked })} /> {T('مفعّل', 'On')}</label>}
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}><span style={{ minWidth: 150 }}>{T('المزوّد', 'Provider')}</span>
            <select className="input" style={{ maxWidth: 160 }} value={r.provider} disabled={chat || r.task === 'voice'} onChange={e => set(r.task, { provider: e.target.value as Row['provider'] })}><option value="google">Google</option><option value="anthropic">Anthropic</option></select></div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}><span style={{ minWidth: 150 }}>{T('النموذج', 'Model')}</span>
            <input className="input" dir="ltr" style={{ maxWidth: 260 }} value={r.model} disabled={chat} onChange={e => set(r.task, { model: e.target.value })} /></div>
          {!chat && <>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}><span style={{ minWidth: 150 }}>{T('نموذج بديل (اختياري)', 'Fallback model (optional)')}</span>
              <input className="input" dir="ltr" style={{ maxWidth: 260 }} value={r.fallback_model ?? ''} onChange={e => set(r.task, { fallback_model: e.target.value })} /></div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}><span style={{ minWidth: 150 }}>{T('سعر الصوت ($ / مليون)', 'Audio in ($ / 1M tokens)')}</span>{numIn(r, 'price_audio_per_m')}</div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}><span style={{ minWidth: 150 }}>{T('سعر النص ($ / مليون)', 'Text in ($ / 1M tokens)')}</span>{numIn(r, 'price_in_per_m')}</div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}><span style={{ minWidth: 150 }}>{T('سعر الإخراج ($ / مليون)', 'Output ($ / 1M tokens)')}</span>{numIn(r, 'price_out_per_m')}</div>
            {r.task === 'voice' && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{T('لنموذج النسخ يمكن تحديد اللغة بعد اسم النموذج، مثل', 'For the transcription model a language can be set after the model name, like')} <span dir="ltr">gemini-3.5-transcribe@ar-EG</span></p>}
            <input className="input" placeholder={T('ملاحظات', 'Notes')} value={r.notes ?? ''} maxLength={500} onChange={e => set(r.task, { notes: e.target.value })} />
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{T('الأسعار من صفحة أسعار المزوّد. لا يمكن التشغيل بلا أسعار، لأن الحدود تُحسب بالمال.', 'Prices come from the provider\'s pricing page. It cannot be switched on without prices, because the caps count money.')}</p>
            <div><button className="btn primary" disabled={busy === r.task || !dirty || !r.model.trim()} onClick={() => void save(r)}>{T('حفظ', 'Save')}</button></div>
          </>}
          {r.task === 'voice' && <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <strong style={{ fontSize: 14 }}>{T('تجربة', 'Test')}</strong>
            <span className="muted" style={{ fontSize: 13 }}>{T('اختر أو سجّل رسالة صوتية قصيرة (حتى دقيقتين). تُجرَّب على النموذج المحفوظ حتى لو كان المسار متوقفاً. لا يُحفظ التسجيل.', 'Choose or record a short voice note (up to 2 minutes). It runs on the saved model even while the route is off. The recording is not kept.')}</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <input ref={file} type="file" accept="audio/*" className="input" style={{ maxWidth: 280 }} />
              <button className="btn" disabled={testing || !keys.google} onClick={() => void runTest()}>{testing ? '…' : T('جرّب', 'Run test')}</button>
            </div>
            {test && <div className="card" style={{ background: 'var(--bg)' }}>
              {test.status === 'ok' && <><div dir="auto" style={{ fontSize: 16 }}>🎤 {test.text}</div>
                <div className="muted" style={{ fontSize: 13, marginTop: 6 }} dir="ltr">{test.model} · {((test.ms ?? 0) / 1000).toFixed(1)} s{test.seconds != null ? ` · ${test.seconds} s audio` : ''} · {test.audio_tokens} audio tokens · {test.priced ? `$${(test.cost_usd ?? 0).toFixed(5)}` : T('بلا أسعار بعد', 'no prices yet')}</div></>}
              {test.status === 'nothing' && <span>{T('لم يُسمع كلام في التسجيل.', 'No speech was heard in the clip.')}</span>}
              {test.status === 'too_long' && <span>{T('التسجيل أطول من دقيقتين أو أكبر من 2 ميغابايت.', 'The clip is longer than 2 minutes or larger than 2 MB.')}</span>}
              {test.status === 'failed' && <span dir="ltr">{test.error === 'no_key' ? T('لا يوجد مفتاح Google على هذا الموقع.', 'There is no Google key on this site.') : `✗ ${test.error}`}</span>}
            </div>}
          </div>}
          {r.updated_at && <span className="muted" style={{ fontSize: 12 }} dir="ltr">{T('آخر تعديل', 'Last change')}: {r.updated_at.slice(0, 16).replace('T', ' ')} UTC</span>}
        </div>); })}
    </div>
  );
}
