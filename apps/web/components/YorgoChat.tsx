'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useCart, type ShopRef } from '@/components/CartProvider';
import { useConfirm } from '@/components/ConfirmProvider';

// Yorgo on the storefront: the customer writes what they want (Arabic, Arabizi or English), Yorgo proposes a basket, the customer
// checks it and adds it to the cart. Nothing is ordered here — checkout stays the usual one. Names and prices on the card are the
// public catalog's, filled in on the server with the customer's own access.
type L = 'ar' | 'en';
type Item = { product_id: string; name: Record<string, string>; unit: string | null; price_usd: number; days: number[] | null; shop: ShopRef };
type Line = Item & { key: string; quantity: number; note?: string };
type Choice = { key: string; phrase: string; quantity: number; options: Item[] };
type Draft = { lines: Line[]; choices: Choice[]; notFound: string[]; state: 'open' | 'added' | 'discarded' };
type Msg = { id: number; from: 'me' | 'yorgo' | 'note'; text: string; draft?: Draft; mid?: number | null; fb?: 1 | -1 };
type DraftIn = { kind?: string; lines?: (Item & { quantity: number; note?: string })[]; choices?: { phrase: string; quantity: number; options: Item[] }[]; not_found?: string[] };
type Reply = { status: 'ok'; conversation_id: string; reply: string; drafts: DraftIn[]; message_id?: number | null } | { status: 'paused'; reason: string } | { status: 'error'; error: string; conversation_id?: string };

const T = {
  open: { ar: 'اسأل يورغو', en: 'Ask Yorgo' }, ai: { ar: 'مساعد ذكاء اصطناعي', en: 'AI assistant' },
  hello: { ar: 'أهلاً، أنا يورغو.', en: 'Hi, I am Yorgo.' },
  hint: { ar: 'اكتب ما تريد شراءه كما تكتبه على واتساب — بالعربي أو بالعربيزي أو بالإنكليزي — وأحضّر لك السلة. أو اسألني إن كان صنف موجوداً وكم سعره.', en: 'Write what you want to buy the way you would on WhatsApp — Arabic, Arabizi or English — and I prepare the basket. Or ask me whether an item exists and what it costs.' },
  eg: { ar: 'مثال: بدي ربطتين خبز و pepsi kbire w labne', en: 'Example: 2 bread, a big pepsi and labne' },
  placeholder: { ar: 'اكتب طلبك هنا…', en: 'Write your order here…' }, send: { ar: 'إرسال', en: 'Send' }, fresh: { ar: 'محادثة جديدة', en: 'New conversation' }, close: { ar: 'إغلاق', en: 'Close' },
  signIn: { ar: 'سجّل الدخول لتتحدث مع يورغو.', en: 'Sign in to chat with Yorgo.' }, signInBtn: { ar: 'تسجيل الدخول', en: 'Sign in' },
  draft: { ar: 'سلة مقترحة', en: 'Suggested basket' }, toCart: { ar: 'أضف إلى السلة', en: 'Add to cart' }, discard: { ar: 'تجاهل', en: 'Discard' },
  added: { ar: 'أُضيفت إلى السلة', en: 'Added to cart' }, discarded: { ar: 'تم التجاهل', en: 'Discarded' }, viewCart: { ar: 'افتح السلة', en: 'Open cart' },
  pick: { ar: 'اختر', en: 'pick one' }, skip: { ar: 'تخطَّ', en: 'Skip' }, pickFirst: { ar: 'ما عليه ❓ لا يُضاف قبل أن تختار.', en: 'Items marked ❓ are not added until you pick.' },
  notFound: { ar: 'غير موجود', en: 'Not found' },
  replace: { ar: 'سلتك تحتوي أصنافاً من متجر آخر. استبدالها؟', en: 'Your cart has items from another shop. Replace them?' },
  oneShop: { ar: 'السلة تقبل متجراً واحداً في كل مرة: أُضيفت أصناف', en: 'The cart takes one shop at a time: added the items from' },
  off: { ar: 'يورغو غير متاح حالياً.', en: 'Yorgo is not available right now.' }, cap: { ar: 'وصلتَ إلى حدّ يورغو لهذا الشهر. التسوّق يعمل كالعادة.', en: 'You reached Yorgo\'s limit for this month. Shopping works as usual.' },
  rate: { ar: 'رسائل كثيرة بسرعة. انتظر دقيقة ثم جرّب.', en: 'Too many messages too quickly. Wait a minute and try again.' },
  error: { ar: 'لم أستطع الإجابة الآن. جرّب مرة ثانية.', en: 'I could not answer just now. Please try again.' },
  disclaimer: { ar: 'يورغو ذكاء اصطناعي وقد يخطئ. راجِع السلة قبل الطلب؛ الأسماء والأسعار من المتاجر نفسها.', en: 'Yorgo is an AI and can be wrong. Check the basket before ordering; names and prices come from the shops themselves.' },
} as const;

export default function YorgoChat({ locale, signedIn }: { locale: L; signedIn: boolean }) {
  const t = (k: keyof typeof T) => T[k][locale];
  const name = (n: Record<string, string>) => n?.[locale] || n?.ar || n?.en || '';
  const path = usePathname() ?? '/';
  const cart = useCart(); const ask = useConfirm(); const sb = useMemo(() => supabaseBrowser(), []);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState(''); const [busy, setBusy] = useState(false);
  const conv = useRef<string | null>(null); const seq = useRef(0); const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy, open]);
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [open]);
  if (/^\/(checkout|login|signup)/.test(path)) return null;                 // never in the way of paying or signing in

  const push = (m: Omit<Msg, 'id'>) => setMsgs(ms => [...ms, { ...m, id: ++seq.current }]);
  const toDraft = (d: DraftIn): Draft | undefined => {
    const lines = (d.lines ?? []).map((l, i) => ({ ...l, key: `l${i}` }));
    const choices = (d.choices ?? []).map((c, i) => ({ ...c, key: `c${i}` }));
    const notFound = d.not_found ?? [];
    return lines.length || choices.length || notFound.length ? { lines, choices, notFound, state: 'open' } : undefined;
  };
  const send = async () => {
    const message = input.trim(); if (!message || busy) return;
    setInput(''); push({ from: 'me', text: message }); setBusy(true);
    try {
      const slug = path.match(/^\/s\/([^/?#]+)/)?.[1];
      const res = await fetch('/api/yorgo/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'shopper', conversation_id: conv.current, message, ...(slug ? { shop_slug: decodeURIComponent(slug) } : {}) }) });
      const r = (res.status === 401 ? { status: 'error', error: 'unauthorized' } : await res.json()) as Reply;
      if (r.status === 'ok') {
        conv.current = r.conversation_id;
        const drafts = (r.drafts ?? []).filter(d => d.kind === 'draft_basket').map(toDraft).filter((d): d is Draft => !!d);
        // a new basket replaces the one still open on screen; clear_draft takes it away
        const cleared = (r.drafts ?? []).some(d => d.kind === 'clear_draft');
        if (cleared || drafts.length) setMsgs(ms => ms.map(x => (x.draft?.state === 'open' ? { ...x, draft: { ...x.draft, state: 'discarded' } } : x)));
        if (r.reply) push({ from: 'yorgo', text: r.reply, mid: r.message_id ?? null });
        drafts.forEach(draft => push({ from: 'yorgo', text: '', draft }));
        if (!r.reply && !drafts.length && !cleared) push({ from: 'note', text: t('error') });
      } else if (r.status === 'paused') push({ from: 'note', text: t(r.reason === 'rate' ? 'rate' : r.reason === 'off' ? 'off' : 'cap') });
      else { if (r.conversation_id) conv.current = r.conversation_id; push({ from: 'note', text: t(r.error === 'unauthorized' ? 'signIn' : 'error') }); }
    } catch { push({ from: 'note', text: t('error') }); }
    setBusy(false);
  };

  const patch = (id: number, f: (d: Draft) => Draft) => setMsgs(ms => ms.map(m => (m.id === id && m.draft ? { ...m, draft: f(m.draft) } : m)));
  const accept = async (m: Msg) => {
    if (!m.draft?.lines.length) return;
    let lines = m.draft.lines; let cleared = false;
    if (!cart.multiShop) {                                                    // one shop per cart: take the shop with most lines, say so
      const by = new Map<string, Line[]>(); lines.forEach(l => by.set(l.shop.id, [...(by.get(l.shop.id) ?? []), l]));
      const best = [...by.values()].sort((a, b) => b.length - a.length)[0];
      if (by.size > 1) push({ from: 'note', text: `${t('oneShop')} ${name(best[0].shop.name)}` });
      lines = best;
      const other = cart.cart.shops.some(s => s.id !== best[0].shop.id && s.lines.length);
      if (other) { if (!(await ask(t('replace')))) return; cart.clear(); cleared = true; await new Promise(r => setTimeout(r, 0)); }   // let the empty cart land before adding
    }
    for (const l of lines) {
      const before = cleared ? 0 : cart.qtyOf(l.shop.id, l.product_id);
      await cart.add(l.shop, { product_id: l.product_id, name: l.name, unit: l.unit, price_usd: l.price_usd, days: l.days, ...(l.note ? { notes: l.note } : {}) }, () => true);
      const want = before + Math.max(1, Math.round(l.quantity));
      if (want !== before + 1) cart.setQty(l.shop.id, l.product_id, want);
    }
    patch(m.id, d => ({ ...d, state: 'added' }));
  };
  const money = (n: number) => `$${n.toFixed(2)}`;
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
              <div key={m.id} className={`yorgo-draft ${m.draft.state}`}>
                <div className="yorgo-draft-head">🛒 {t('draft')}{m.draft.state === 'added' && <><span className="yorgo-ok">✓ {t('added')}</span><Link href="/cart" className="btn" onClick={() => setOpen(false)}>{t('viewCart')}</Link></>}{m.draft.state === 'discarded' && <span className="muted">{t('discarded')}</span>}</div>
                {m.draft.lines.map(l => (
                  <div key={l.key} className="yorgo-line">
                    <div className="yorgo-line-name">{name(l.name)}{l.note && <small className="muted"> · 📝 {l.note}</small>}<br /><small className="muted">{name(l.shop.name)} · {money(l.price_usd)}{l.unit ? ` /${l.unit}` : ''}</small></div>
                    {m.draft!.state === 'open' ? <div className="yorgo-qty">
                      <button onClick={() => patch(m.id, d => ({ ...d, lines: d.lines.map(x => (x.key === l.key ? { ...x, quantity: Math.max(1, Math.round(x.quantity) - 1) } : x)) }))}>−</button>
                      <span>{Math.max(1, Math.round(l.quantity))}</span>
                      <button onClick={() => patch(m.id, d => ({ ...d, lines: d.lines.map(x => (x.key === l.key ? { ...x, quantity: Math.round(x.quantity) + 1 } : x)) }))}>+</button>
                      <button className="rm" onClick={() => patch(m.id, d => ({ ...d, lines: d.lines.filter(x => x.key !== l.key) }))}>✕</button>
                    </div> : <strong>× {Math.max(1, Math.round(l.quantity))}</strong>}
                  </div>
                ))}
                {m.draft.state === 'open' && m.draft.choices.map(c => (
                  <div key={c.key} className="yorgo-choice">
                    <div>❓ <strong dir="auto">{c.phrase}</strong> <span className="muted">× {c.quantity} · {t('pick')}</span></div>
                    <div className="yorgo-options">
                      {c.options.map(o => <button key={o.product_id} className="btn" onClick={() => { learn(o, c.phrase); patch(m.id, d => ({ ...d, choices: d.choices.filter(x => x.key !== c.key), lines: [...d.lines, { ...o, key: c.key, quantity: c.quantity }] })); }}>{name(o.name)} <small className="muted">{money(o.price_usd)} · {name(o.shop.name)}</small></button>)}
                      <button className="btn ghost" onClick={() => patch(m.id, d => ({ ...d, choices: d.choices.filter(x => x.key !== c.key) }))}>✕ {t('skip')}</button>
                    </div>
                  </div>
                ))}
                {!!m.draft.notFound.length && <div className="yorgo-missing">⚠ {t('notFound')}: <span dir="auto">{m.draft.notFound.join('، ')}</span></div>}
                {m.draft.state === 'open' && <div className="yorgo-actions">
                  <button className="btn ghost" onClick={() => patch(m.id, d => ({ ...d, state: 'discarded' }))}>{t('discard')}</button><span style={{ flex: 1 }} />
                  <button className="btn primary" disabled={!m.draft.lines.length} onClick={() => void accept(m)}>🛒 {t('toCart')} ({m.draft.lines.length})</button>
                </div>}
                {m.draft.state === 'open' && !!m.draft.choices.length && <small className="muted">{t('pickFirst')}</small>}
              </div>
            ) : <div key={m.id} className={`yorgo-msg ${m.from}`} dir="auto">{m.text}{m.from === 'yorgo' && !!m.mid && <span className="yorgo-thumbs" dir="ltr">
              <button className={m.fb === 1 ? 'on' : ''} aria-label="👍" onClick={() => rate(m, 1)}>👍</button><button className={m.fb === -1 ? 'on' : ''} aria-label="👎" onClick={() => rate(m, -1)}>👎</button></span>}</div>)}
            {busy && <div className="yorgo-msg yorgo typing">…</div>}
            <div ref={endRef} />
          </div>
          {signedIn && <div className="yorgo-input">
            <textarea className="input" rows={2} dir="auto" maxLength={2000} placeholder={t('placeholder')} value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); void send(); } }} />
            <button className="btn primary" disabled={busy || !input.trim()} onClick={() => void send()} aria-label={t('send')}>↑</button>
          </div>}
          <p className="yorgo-foot muted">{t('disclaimer')} <a href="/legal/privacy">{locale === 'ar' ? 'الخصوصية' : 'Privacy'}</a></p>
        </div>
      </div>}
    </>
  );
}
