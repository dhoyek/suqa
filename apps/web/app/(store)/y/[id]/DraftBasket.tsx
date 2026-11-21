'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase-browser';
import YorgoBasketCard, { toDraft, useAddBasket, type Draft, type DraftIn, type Item } from '@/components/YorgoBasketCard';

// The basket Yorgo prepared on WhatsApp, on its own page: the same card as in the chat. The customer picks, changes quantities,
// adds to the cart, and goes on to the usual cart and checkout.
export default function DraftBasket({ id, locale, draft: incoming, alreadyAdded }: { id: string; locale: 'ar' | 'en'; draft: DraftIn; alreadyAdded: boolean }) {
  const T = (ar: string, en: string) => (locale === 'ar' ? ar : en);
  const sb = useMemo(() => supabaseBrowser(), []);
  const [draft, setDraft] = useState<Draft | undefined>(() => toDraft(incoming));
  const [note, setNote] = useState<string | null>(null);
  const add = useAddBasket(locale, setNote);
  const accept = async () => {
    if (!draft || !(await add(draft))) return;
    setDraft(d => (d ? { ...d, state: 'added' } : d));
    void Promise.resolve(sb.rpc('yorgo_draft_added', { p_id: id })).then(() => null, () => null);
  };
  // a pick teaches the shop a name, as in the chat (signed-in customers only; it fails quietly for a visitor)
  const learn = (o: Item, phrase: string) => { void Promise.resolve(sb.rpc('alias_suggest', { p_product: o.product_id, p_phrase: phrase, p_source: 'yorgo' })).then(() => null, () => null); };
  return (
    <div className="stack" style={{ maxWidth: 640, margin: '16px auto' }}>
      <div><strong>✨ Yorgo</strong> <small className="yorgo-tag">{T('مساعد ذكاء اصطناعي', 'AI assistant')}</small></div>
      <span className="muted">{T('هذه السلة جهّزها يورغو من رسالتك على واتساب. راجعها، اختر ما عليه ❓، ثم أضفها إلى سلتك واطلب كالعادة.', 'Yorgo prepared this basket from your WhatsApp message. Check it, pick the items marked ❓, then add it to your cart and order as usual.')}</span>
      {alreadyAdded && draft?.state === 'open' && <span className="muted">ⓘ {T('سبق أن أضفت هذه السلة مرة.', 'You already added this basket once.')}</span>}
      {draft ? <YorgoBasketCard locale={locale} draft={draft} onPatch={f => setDraft(d => (d ? f(d) : d))} onAccept={() => void accept()} onLearn={learn} />
        : <div className="card"><span className="muted">{T('لا شيء في هذه السلة.', 'Nothing in this basket.')}</span></div>}
      {note && <div className="yorgo-msg note" dir="auto">{note}</div>}
      {draft?.state === 'added' && <div><Link className="btn primary" href="/cart">{T('افتح السلة وأكمل الطلب', 'Open the cart and order')}</Link></div>}
      {draft?.state === 'discarded' && <div><Link className="btn" href="/">{T('تصفّح المتاجر', 'Browse the shops')}</Link></div>}
      <p className="yorgo-foot muted">{T('يورغو ذكاء اصطناعي وقد يخطئ. راجِع السلة قبل الطلب؛ الأسماء والأسعار من المتاجر نفسها.', 'Yorgo is an AI and can be wrong. Check the basket before ordering; names and prices come from the shops themselves.')} <a href="/legal/privacy">{T('الخصوصية', 'Privacy')}</a></p>
    </div>
  );
}
