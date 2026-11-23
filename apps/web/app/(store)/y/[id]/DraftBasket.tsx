'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase-browser';
import YorgoBasketCard, { toDraft, useAddBasket, type Draft, type DraftIn, type Item } from '@/components/YorgoBasketCard';

// The basket Yorgo prepared on WhatsApp, on its own page: the same card as in the chat. The customer picks, changes quantities,
// adds to the cart, and goes on to the usual cart and checkout.
export default function DraftBasket({ id, locale, draft: incoming, alreadyAdded, discarded }: { id: string; locale: 'ar' | 'en'; draft: DraftIn; alreadyAdded: boolean; discarded: boolean }) {
  const T = (ar: string, en: string) => (locale === 'ar' ? ar : en);
  const sb = useMemo(() => supabaseBrowser(), []);
  const [draft, setDraft] = useState<Draft | undefined>(() => { const d = toDraft(incoming); return d && discarded ? { ...d, state: 'discarded' } : d; });
  const [note, setNote] = useState<string | null>(null);
  const add = useAddBasket(locale, setNote);
  const accept = async () => {
    if (!draft || !(await add(draft))) return;
    setDraft(d => (d ? { ...d, state: 'added' } : d));
    void Promise.resolve(sb.rpc('yorgo_draft_added', { p_id: id })).then(() => null, () => null);
  };
  // "discard" is told to the server (script 102), so a later "zid" on WhatsApp starts a new basket instead of bringing this one back
  const patch = (f: (d: Draft) => Draft) => setDraft(d => {
    if (!d) return d; const n = f(d);
    if (d.state === 'open' && n.state === 'discarded') void Promise.resolve(sb.rpc('yorgo_draft_discarded', { p_id: id })).then(() => null, () => null);
    return n;
  });
  // a pick teaches the shop a name, as in the chat (signed-in customers only; it fails quietly for a visitor)
  const learn = (o: Item, phrase: string) => { void Promise.resolve(sb.rpc('alias_suggest', { p_product: o.product_id, p_phrase: phrase, p_source: 'yorgo' })).then(() => null, () => null); };
  return (
    <div className="stack" style={{ maxWidth: 640, margin: '16px auto' }}>
      <div><strong>✨ Yorgo</strong> <small className="yorgo-tag">{T('مساعد ذكاء اصطناعي', 'AI assistant')}</small></div>
      <span className="muted">{T('هذه السلة جهّزها يورغو من رسالتك على واتساب. راجعها، اختر ما عليه ❓، ثم أضفها إلى سلتك واطلب كالعادة.', 'Yorgo prepared this basket from your WhatsApp message. Check it, pick the items marked ❓, then add it to your cart and order as usual.')}</span>
      {alreadyAdded && draft?.state === 'open' && <span className="muted">ⓘ {T('سبق أن أضفت هذه السلة مرة.', 'You already added this basket once.')}</span>}
      {draft ? <YorgoBasketCard locale={locale} draft={draft} onPatch={patch} onAccept={() => void accept()} onLearn={learn} />
        : <div className="card"><span className="muted">{T('لا شيء في هذه السلة.', 'Nothing in this basket.')}</span></div>}
      {note && <div className="yorgo-msg note" dir="auto">{note}</div>}
      {draft?.state === 'added' && <div><Link className="btn primary" href="/cart">{T('افتح السلة وأكمل الطلب', 'Open the cart and order')}</Link></div>}
      {draft?.state === 'discarded' && <div><Link className="btn" href="/">{T('تصفّح المتاجر', 'Browse the shops')}</Link></div>}
      <p className="yorgo-foot muted">{T('يورغو ذكاء اصطناعي وقد يخطئ. راجِع السلة قبل الطلب؛ الأسماء والأسعار من المتاجر نفسها.', 'Yorgo is an AI and can be wrong. Check the basket before ordering; names and prices come from the shops themselves.')} <a href="/legal/privacy">{T('الخصوصية', 'Privacy')}</a></p>
    </div>
  );
}
