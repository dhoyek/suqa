'use client';
import Link from 'next/link';
import { useCart, type ShopRef } from '@/components/CartProvider';
import { useConfirm } from '@/components/ConfirmProvider';

// The basket Yorgo proposes, as a card: lines with quantities, groups to choose from, what was not found, "add to cart".
// One card for the two places a draft shows: the chat on the storefront and the page a WhatsApp link opens (/y/<id>).
// Nothing is ordered here — "add to cart" fills the usual cart and checkout stays the usual one.
type L = 'ar' | 'en';
export type Item = { product_id: string; name: Record<string, string>; unit: string | null; price_usd: number; days: number[] | null; shop: ShopRef };
export type Line = Item & { key: string; quantity: number; note?: string };
export type Choice = { key: string; phrase: string; quantity: number; options: Item[]; picked?: number; note?: string };
export type Draft = { lines: Line[]; choices: Choice[]; notFound: string[]; state: 'open' | 'added' | 'discarded' };
export type DraftIn = { kind?: string; add?: boolean; lines?: (Item & { quantity: number; note?: string })[]; choices?: { phrase: string; quantity: number; options: Item[]; note?: string }[]; not_found?: string[] };

const T = {
  draft: { ar: 'سلة مقترحة', en: 'Suggested basket' }, toCart: { ar: 'أضف إلى السلة', en: 'Add to cart' }, discard: { ar: 'تجاهل', en: 'Discard' },
  added: { ar: 'أُضيفت إلى السلة', en: 'Added to cart' }, discarded: { ar: 'تم التجاهل', en: 'Discarded' }, viewCart: { ar: 'افتح السلة', en: 'Open cart' },
  pick: { ar: 'اختر واحداً أو أكثر', en: 'pick one or more' }, skip: { ar: 'تخطَّ', en: 'Skip' }, done: { ar: 'تم', en: 'Done' }, pickFirst: { ar: 'ما عليه ❓ لا يُضاف قبل أن تختار.', en: 'Items marked ❓ are not added until you pick.' },
  notFound: { ar: 'غير موجود', en: 'Not found' },
  replace: { ar: 'سلتك تحتوي أصنافاً من متجر آخر. استبدالها؟', en: 'Your cart has items from another shop. Replace them?' },
  oneShop: { ar: 'السلة تقبل متجراً واحداً في كل مرة: أُضيفت أصناف', en: 'The cart takes one shop at a time: added the items from' },
} as const;

/** what the server sent → the card's own shape (nothing to show = no card) */
export function toDraft(d: DraftIn): Draft | undefined {
  const lines = (d.lines ?? []).map((l, i) => ({ ...l, key: `l${i}` }));
  const choices = (d.choices ?? []).map((c, i) => ({ ...c, key: `c${i}` }));
  const notFound = d.not_found ?? [];
  return lines.length || choices.length || notFound.length ? { lines, choices, notFound, state: 'open' } : undefined;
}

// a pick joins the basket and the OTHER suggestions stay, so a second and a third can be picked from the same group
// (several drinks, several kinds of chips); the group goes when it is empty or closed with "done" / "skip"
export function pickOption(d: Draft, c: Choice, o: Item): Draft {
  const i = d.lines.findIndex(x => x.product_id === o.product_id && (x.note ?? '') === (c.note ?? ''));      // what was said about the item ("bala basal") goes with the pick
  const lines = i >= 0 ? d.lines.map((x, n) => (n === i ? { ...x, quantity: x.quantity + c.quantity } : x)) : [...d.lines, { ...o, key: `${c.key}-${o.product_id}`, quantity: c.quantity, ...(c.note ? { note: c.note } : {}) }];
  return { ...d, lines, choices: d.choices.map(x => (x.key === c.key ? { ...x, picked: (x.picked ?? 0) + 1, options: x.options.filter(y => y.product_id !== o.product_id) } : x)).filter(x => x.options.length) };
}

/** "add to cart": the draft's lines into the usual cart. Returns false when the customer kept the cart he had. `note` gets the one-shop remark. */
export function useAddBasket(locale: L, note: (text: string) => void) {
  const cart = useCart(); const ask = useConfirm();
  const name = (n: Record<string, string>) => n?.[locale] || n?.ar || n?.en || '';
  return async (draft: Draft): Promise<boolean> => {
    if (!draft.lines.length) return false;
    let lines = draft.lines; let cleared = false;
    if (!cart.multiShop) {                                                    // one shop per cart: take the shop with most lines, say so
      const by = new Map<string, Line[]>(); lines.forEach(l => by.set(l.shop.id, [...(by.get(l.shop.id) ?? []), l]));
      const best = [...by.values()].sort((a, b) => b.length - a.length)[0];
      if (by.size > 1) note(`${T.oneShop[locale]} ${name(best[0].shop.name)}`);
      lines = best;
      const other = cart.cart.shops.some(s => s.id !== best[0].shop.id && s.lines.length);
      if (other) { if (!(await ask(T.replace[locale]))) return false; cart.clear(); cleared = true; await new Promise(r => setTimeout(r, 0)); }   // let the empty cart land before adding
    }
    for (const l of lines) {
      const before = cleared ? 0 : cart.qtyOf(l.shop.id, l.product_id);
      await cart.add(l.shop, { product_id: l.product_id, name: l.name, unit: l.unit, price_usd: l.price_usd, days: l.days, ...(l.note ? { notes: l.note } : {}) }, () => true);
      const want = before + Math.max(1, Math.round(l.quantity));
      if (want !== before + 1) cart.setQty(l.shop.id, l.product_id, want);
    }
    return true;
  };
}

export default function YorgoBasketCard({ locale, draft, onPatch, onAccept, onLearn, onViewCart }: { locale: L; draft: Draft; onPatch: (f: (d: Draft) => Draft) => void; onAccept: () => void; onLearn?: (o: Item, phrase: string) => void; onViewCart?: () => void }) {
  const t = (k: keyof typeof T) => T[k][locale];
  const name = (n: Record<string, string>) => n?.[locale] || n?.ar || n?.en || '';
  const money = (n: number) => `$${n.toFixed(2)}`;
  return (
    <div className={`yorgo-draft ${draft.state}`}>
      <div className="yorgo-draft-head">🛒 {t('draft')}{draft.state === 'added' && <><span className="yorgo-ok">✓ {t('added')}</span><Link href="/cart" className="btn" onClick={onViewCart}>{t('viewCart')}</Link></>}{draft.state === 'discarded' && <span className="muted">{t('discarded')}</span>}</div>
      {draft.lines.map(l => (
        <div key={l.key} className="yorgo-line">
          <div className="yorgo-line-name">{name(l.name)}{l.note && <small className="muted"> · 📝 {l.note}</small>}<br /><small className="muted">{name(l.shop.name)} · {money(l.price_usd)}{l.unit ? ` /${l.unit}` : ''}</small></div>
          {draft.state === 'open' ? <div className="yorgo-qty">
            <button onClick={() => onPatch(d => ({ ...d, lines: d.lines.map(x => (x.key === l.key ? { ...x, quantity: Math.max(1, Math.round(x.quantity) - 1) } : x)) }))}>−</button>
            <span>{Math.max(1, Math.round(l.quantity))}</span>
            <button onClick={() => onPatch(d => ({ ...d, lines: d.lines.map(x => (x.key === l.key ? { ...x, quantity: Math.round(x.quantity) + 1 } : x)) }))}>+</button>
            <button className="rm" onClick={() => onPatch(d => ({ ...d, lines: d.lines.filter(x => x.key !== l.key) }))}>✕</button>
          </div> : <strong>× {Math.max(1, Math.round(l.quantity))}</strong>}
        </div>
      ))}
      {draft.state === 'open' && draft.choices.map(c => (
        <div key={c.key} className="yorgo-choice">
          <div>❓ <strong dir="auto">{c.phrase}</strong> <span className="muted">× {c.quantity}{c.note ? <> · 📝 <span dir="auto">{c.note}</span></> : null} · {t('pick')}</span></div>
          <div className="yorgo-options">
            {c.options.map(o => <button key={o.product_id} className="btn" onClick={() => { onLearn?.(o, c.phrase); onPatch(d => pickOption(d, c, o)); }}>{name(o.name)} <small className="muted">{money(o.price_usd)} · {name(o.shop.name)}</small></button>)}
            <button className="btn ghost" onClick={() => onPatch(d => ({ ...d, choices: d.choices.filter(x => x.key !== c.key) }))}>{c.picked ? `✓ ${t('done')}` : `✕ ${t('skip')}`}</button>
          </div>
        </div>
      ))}
      {!!draft.notFound.length && <div className="yorgo-missing">⚠ {t('notFound')}: <span dir="auto">{draft.notFound.join('، ')}</span></div>}
      {draft.state === 'open' && <div className="yorgo-actions">
        <button className="btn ghost" onClick={() => onPatch(d => ({ ...d, state: 'discarded' }))}>{t('discard')}</button><span style={{ flex: 1 }} />
        <button className="btn primary" disabled={!draft.lines.length} onClick={onAccept}>🛒 {t('toCart')} ({draft.lines.length})</button>
      </div>}
      {draft.state === 'open' && !!draft.choices.length && <small className="muted">{t('pickFirst')}</small>}
    </div>
  );
}
