'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { MicIcon, useVoiceRecorder } from '@/components/useVoiceRecorder';
import YorgoBasketCard, { toDraft, useAddBasket, type Draft, type DraftIn, type Item } from '@/components/YorgoBasketCard';

// Yorgo on the storefront: the customer writes what they want (Arabic, Arabizi or English), Yorgo proposes a basket, the customer
// checks it and adds it to the cart. Nothing is ordered here — checkout stays the usual one. Names and prices on the card are the
// public catalog's, filled in on the server with the customer's own access.
type L = 'ar' | 'en';
type Msg = { id: number; from: 'me' | 'yorgo' | 'note'; text: string; draft?: Draft; mid?: number | null; fb?: 1 | -1 };
type Reply = { status: 'ok'; conversation_id: string; reply: string; drafts: DraftIn[]; message_id?: number | null; heard?: string } | { status: 'voice'; reason: 'off' | 'too_long' | 'unclear' | 'failed'; conversation_id?: string } | { status: 'paused'; reason: string } | { status: 'error'; error: string; conversation_id?: string };

const T = {
  open: { ar: 'اسأل يورغو', en: 'Ask Yorgo' }, ai: { ar: 'مساعد ذكاء اصطناعي', en: 'AI assistant' },
  hello: { ar: 'أهلاً، أنا يورغو.', en: 'Hi, I am Yorgo.' },
  hint: { ar: 'اكتب ما تريد شراءه كما تكتبه على واتساب — بالعربي أو بالعربيزي أو بالإنكليزي — وأحضّر لك السلة. أو اسألني إن كان صنف موجوداً وكم سعره.', en: 'Write what you want to buy the way you would on WhatsApp — Arabic, Arabizi or English — and I prepare the basket. Or ask me whether an item exists and what it costs.' },
  eg: { ar: 'مثال: بدي ربطتين خبز و pepsi kbire w labne', en: 'Example: 2 bread, a big pepsi and labne' },
  placeholder: { ar: 'اكتب طلبك هنا…', en: 'Write your order here…' }, send: { ar: 'إرسال', en: 'Send' }, fresh: { ar: 'محادثة جديدة', en: 'New conversation' }, close: { ar: 'إغلاق', en: 'Close' },
  signIn: { ar: 'سجّل الدخول لتتحدث مع يورغو.', en: 'Sign in to chat with Yorgo.' }, signInBtn: { ar: 'تسجيل الدخول', en: 'Sign in' },
  off: { ar: 'يورغو غير متاح حالياً.', en: 'Yorgo is not available right now.' }, cap: { ar: 'وصلتَ إلى حدّ يورغو لهذا الشهر. التسوّق يعمل كالعادة.', en: 'You reached Yorgo\'s limit for this month. Shopping works as usual.' },
  rate: { ar: 'رسائل كثيرة بسرعة. انتظر دقيقة ثم جرّب.', en: 'Too many messages too quickly. Wait a minute and try again.' },
  error: { ar: 'لم أستطع الإجابة الآن. جرّب مرة ثانية.', en: 'I could not answer just now. Please try again.' },
  mic: { ar: 'سجّل طلبك بصوتك', en: 'Say your order' }, stop: { ar: 'إيقاف وإرسال', en: 'Stop and send' }, cancel: { ar: 'إلغاء', en: 'Cancel' },
  recording: { ar: 'أسجّل… قل طلبك ثم اضغط إرسال', en: 'Recording… say your order, then tap send' },
  micDenied: { ar: 'لا إذن لاستخدام الميكروفون. اسمح به من إعدادات المتصفح، أو اكتب طلبك.', en: 'The microphone is not allowed. Allow it in the browser settings, or type your order.' },
  voiceOff: { ar: 'الرسائل الصوتية غير متاحة الآن. اكتب طلبك.', en: 'Voice messages are not available right now. Please type your order.' },
  voiceLong: { ar: 'الرسالة الصوتية طويلة. سجّل رسالة أقصر (حتى دقيقتين) أو اكتب طلبك.', en: 'That voice message is too long. Record a shorter one (up to 2 minutes) or type your order.' },
  voiceUnclear: { ar: 'لم أسمع طلباً. جرّب مرة أخرى أو اكتب طلبك.', en: 'I could not hear an order. Try again or type it.' },
  disclaimer: { ar: 'يورغو ذكاء اصطناعي وقد يخطئ. راجِع السلة قبل الطلب؛ الأسماء والأسعار من المتاجر نفسها.', en: 'Yorgo is an AI and can be wrong. Check the basket before ordering; names and prices come from the shops themselves.' },
} as const;

export default function YorgoChat({ locale, signedIn }: { locale: L; signedIn: boolean }) {
  const t = (k: keyof typeof T) => T[k][locale];
  const path = usePathname() ?? '/';
  const sb = useMemo(() => supabaseBrowser(), []);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState(''); const [busy, setBusy] = useState(false);
  const conv = useRef<string | null>(null); const seq = useRef(0); const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy, open]);
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [open]);
  const { recording, canRecord, start: startRec, stop: stopRec } = useVoiceRecorder(clip => void sendVoice(clip), () => push({ from: 'note', text: t('micDenied') }));      // before the early return: hooks keep their order
  if (/^\/(checkout|login|signup)/.test(path)) return null;                 // never in the way of paying or signing in

  const push = (m: Omit<Msg, 'id'>) => setMsgs(ms => [...ms, { ...m, id: ++seq.current }]);
  // what became of the last suggestion on screen: Yorgo is told, so a discarded (or already added) one does not come back in the next
  const lastCard = () => [...msgs].reverse().find(x => x.draft)?.draft?.state ?? null;
  const shopSlug = () => { const slug = path.match(/^\/s\/([^/?#]+)/)?.[1]; return slug ? decodeURIComponent(slug) : null; };
  const send = async () => {
    const message = input.trim(); if (!message || busy) return;
    setInput(''); push({ from: 'me', text: message }); setBusy(true);
    const slug = shopSlug();
    await deliver(() => fetch('/api/yorgo/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'shopper', conversation_id: conv.current, message, card: lastCard(), ...(slug ? { shop_slug: slug } : {}) }) }));
    setBusy(false);
  };
  // a voice message: the recording goes with the same fields; the answer comes back with what was heard, shown as the person's own line
  const sendVoice = async (clip: Blob) => {
    if (busy) return; setBusy(true);
    const form = new FormData(); form.append('audio', clip, 'voice'); form.append('mode', 'shopper');
    if (conv.current) form.append('conversation_id', conv.current);
    const card = lastCard(); if (card) form.append('card', card);
    const slug = shopSlug(); if (slug) form.append('shop_slug', slug);
    await deliver(() => fetch('/api/yorgo/chat', { method: 'POST', body: form }));
    setBusy(false);
  };
  const deliver = async (ask: () => Promise<Response>) => {
    try {
      const res = await ask();
      const r = (res.status === 401 ? { status: 'error', error: 'unauthorized' } : await res.json()) as Reply;
      if (r.status === 'voice') { if (r.conversation_id) conv.current = r.conversation_id; push({ from: 'note', text: t(r.reason === 'too_long' ? 'voiceLong' : r.reason === 'unclear' ? 'voiceUnclear' : r.reason === 'off' ? 'voiceOff' : 'error') }); return; }
      if (r.status === 'ok') {
        conv.current = r.conversation_id;
        if (r.heard) push({ from: 'me', text: `🎤 ${r.heard}` });
        const baskets = (r.drafts ?? []).filter(d => d.kind === 'draft_basket');
        // "add" (zid, kamen): the new items join the basket still open on screen — the card moves down, under the answer
        const stamp = `a${Date.now()}`;
        const adds = baskets.filter(d => d.add).map(toDraft).filter((d): d is Draft => !!d);
        const drafts = baskets.filter(d => !d.add).map(toDraft).filter((d): d is Draft => !!d);
        // a new basket replaces the one still open on screen; clear_draft takes it away
        const cleared = (r.drafts ?? []).some(d => d.kind === 'clear_draft');
        if (cleared || drafts.length) setMsgs(ms => ms.map(x => (x.draft?.state === 'open' ? { ...x, draft: { ...x.draft, state: 'discarded' } } : x)));
        if (r.reply) push({ from: 'yorgo', text: r.reply, mid: r.message_id ?? null });
        drafts.forEach(draft => push({ from: 'yorgo', text: '', draft }));
        if (adds.length) setMsgs(ms => {
          const open = [...ms].reverse().find(x => x.draft?.state === 'open');
          let d: Draft = open?.draft ?? { lines: [], choices: [], notFound: [], state: 'open' };
          adds.forEach((a, n) => {
            const lines = [...d.lines];
            for (const l of a.lines) { const i = lines.findIndex(x => x.product_id === l.product_id); if (i >= 0) lines[i] = { ...lines[i], quantity: lines[i].quantity + l.quantity }; else lines.push({ ...l, key: `${stamp}${n}${l.key}` }); }
            d = { ...d, lines, choices: [...d.choices, ...a.choices.map(c => ({ ...c, key: `${stamp}${n}${c.key}` }))], notFound: [...new Set([...d.notFound, ...a.notFound])] };
          });
          return [...ms.filter(x => x !== open), { id: ++seq.current, from: 'yorgo' as const, text: '', draft: d }];
        });
        if (!r.reply && !drafts.length && !adds.length && !cleared) push({ from: 'note', text: t('error') });
      } else if (r.status === 'paused') push({ from: 'note', text: t(r.reason === 'rate' ? 'rate' : r.reason === 'off' ? 'off' : 'cap') });
      else { if (r.conversation_id) conv.current = r.conversation_id; push({ from: 'note', text: t(r.error === 'unauthorized' ? 'signIn' : 'error') }); }
    } catch { push({ from: 'note', text: t('error') }); }
  };


  const patch = (id: number, f: (d: Draft) => Draft) => setMsgs(ms => ms.map(m => (m.id === id && m.draft ? { ...m, draft: f(m.draft) } : m)));
  const addBasket = useAddBasket(locale, text => push({ from: 'note', text }));
  const accept = async (m: Msg) => { if (m.draft && await addBasket(m.draft)) patch(m.id, d => ({ ...d, state: 'added' })); };
  const rate = (m: Msg, v: 1 | -1) => { if (!m.mid) return; const value = m.fb === v ? null : v;
    setMsgs(ms => ms.map(x => (x.id === m.id ? { ...x, fb: value ?? undefined } : x)));
    void fetch('/api/yorgo/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message_id: m.mid, value }) }).catch(() => null); };
  // a pick teaches the shop a name ("<phrase>" meant this item); the shop approves it before it becomes an alias
  const learn = (o: Item, phrase: string) => { void Promise.resolve(sb.rpc('alias_suggest', { p_product: o.product_id, p_phrase: phrase, p_source: 'yorgo' })).then(() => null, () => null); };

  return (
    <>
      {!open && <button className="yorgo-fab" onClick={() => setOpen(true)} aria-label={t('open')}>✨ <span>{t('open')}</span></button>}
      {open && <div className="yorgo-sheet" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}>
        <div className="yorgo-box" role="dialog" aria-modal="true" aria-label="Yorgo">
          <div className="yorgo-head">
            <strong>✨ Yorgo</strong> <small className="yorgo-tag">{t('ai')}</small><span style={{ flex: 1 }} />
            {!!msgs.length && <button className="btn icon" title={t('fresh')} onClick={() => { setMsgs([]); conv.current = null; }}>↺</button>}
            <button className="btn icon" aria-label={t('close')} onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="yorgo-body">
            {!msgs.length && <div className="yorgo-hello">
              <strong>{t('hello')}</strong>
              <span className="muted">{t('hint')}</span>
              <span className="muted" dir="auto" style={{ fontSize: 13 }}>{t('eg')}</span>
              {!signedIn && <><span>{t('signIn')}</span><Link className="btn primary" href={`/login?next=${encodeURIComponent(path)}`}>{t('signInBtn')}</Link></>}
            </div>}
            {msgs.map(m => m.draft ? (
              <YorgoBasketCard key={m.id} locale={locale} draft={m.draft} onPatch={f => patch(m.id, f)} onAccept={() => void accept(m)} onLearn={learn} onViewCart={() => setOpen(false)} />
            ) : <div key={m.id} className={`yorgo-msg ${m.from}`} dir="auto">{m.text}{m.from === 'yorgo' && !!m.mid && <span className="yorgo-thumbs" dir="ltr">
              <button className={m.fb === 1 ? 'on' : ''} aria-label="👍" onClick={() => rate(m, 1)}>👍</button><button className={m.fb === -1 ? 'on' : ''} aria-label="👎" onClick={() => rate(m, -1)}>👎</button></span>}</div>)}
            {busy && <div className="yorgo-msg yorgo typing">…</div>}
            <div ref={endRef} />
          </div>
          {signedIn && recording && <div className="yorgo-input" style={{ alignItems: 'center' }}>
            <span className="yorgo-rec" aria-live="polite">● {t('recording')}</span>
            <button className="btn" onClick={() => stopRec(false)} aria-label={t('cancel')}>✕</button>
            <button className="btn primary" onClick={() => stopRec(true)} aria-label={t('stop')}>↑</button>
          </div>}
          {signedIn && !recording && <div className="yorgo-input">
            <textarea className="input" rows={2} dir="auto" maxLength={2000} placeholder={t('placeholder')} value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); void send(); } }} />
            {canRecord && !input.trim() ? <button className="btn primary" disabled={busy} onClick={() => void startRec()} aria-label={t('mic')} title={t('mic')}><MicIcon /></button>
              : <button className="btn primary" disabled={busy || !input.trim()} onClick={() => void send()} aria-label={t('send')}>↑</button>}
          </div>}
          <p className="yorgo-foot muted">{t('disclaimer')} <a href="/legal/privacy">{locale === 'ar' ? 'الخصوصية' : 'Privacy'}</a></p>
        </div>
      </div>}
    </>
  );
}
