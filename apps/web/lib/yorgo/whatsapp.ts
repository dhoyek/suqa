// Yorgo on WhatsApp (step W1): one inbound text → a basket draft behind a link → one short reply.
// Nothing here knows who the customer is: the phone is the conversation, the rate and the cap, and the tools read the public
// catalog. Nothing is ordered from WhatsApp — the link opens the basket in the app, where the customer orders the usual way.
// Pure on purpose (no provider, no database client, no network): everything it needs is passed in, so it is tested as is.
import { toLbp } from '@suqa/shared';
import { runTurn, type Deps, type Lang, type TurnResult } from './core';
import type { ShopHint } from './prompts';
import { hydrateBasket, slimBasket, type BasketDraft, type OrderDraft } from './tools';

export type Slim = Pick<OrderDraft, 'lines' | 'choices' | 'not_found'>;
type L2 = 'ar' | 'en';
const two = (l: Lang | L2): L2 => (l === 'en' ? 'en' : 'ar');          // Arabizi is answered in Arabic script, as in the app

/** What customers read on WhatsApp besides Yorgo's own sentence (wording agreed with Dan; change it here only). */
export const WA_TEXT = {
  notice: { ar: 'أنا يورغو، المساعد الآلي (ذكاء اصطناعي) لـ{brand}. أجهّز لك السلة، وأنت تراجعها وتؤكّد الطلب من التطبيق.', en: "I'm Yorgo, {brand}'s AI assistant. I prepare your basket; you check it and confirm the order in the app." },
  open: { ar: 'افتح السلة، راجعها واطلب: {link}\n(الرابط صالح 24 ساعة)', en: 'Open your basket, check it and order: {link}\n(the link works for 24 hours)' },
  paused: { ar: 'المساعد متوقف مؤقتاً. يمكنك الطلب مباشرة من التطبيق: {site}', en: 'The assistant is paused for now. You can order directly in the app: {site}' },
  rate: { ar: 'لحظة من فضلك، ثم أرسل رسالتك من جديد.', en: 'One moment please, then send your message again.' },
  textOnly: { ar: 'حالياً أقرأ الرسائل المكتوبة فقط. اكتب لي ما تريد طلبه وأجهّز لك السلة.', en: "For now I read text messages only. Write what you would like to order and I'll prepare your basket." },
  failed: { ar: 'عذراً، حصل خطأ. جرّب مرة أخرى، أو اطلب من التطبيق: {site}', en: 'Sorry, something went wrong. Try again, or order in the app: {site}' },
  items: { ar: 'صنف', en: 'items' }, choose: { ar: 'للاختيار', en: 'to choose' }, missing: { ar: 'غير موجود', en: 'not found' }, shops: { ar: 'متاجر', en: 'shops' },
} as const;
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? '');

/** No text to tell the language from (a voice note, a photo): both, in one message. */
export const waTextOnly = () => `${WA_TEXT.textOnly.ar}\n\n${WA_TEXT.textOnly.en}`;

/** Message kinds: 'text' goes to Yorgo; these get the "text only" line; everything else (reactions, buttons, system…) stays silent. */
export function waKind(type: string): 'text' | 'unsupported' | 'silent' {
  if (type === 'text') return 'text';
  return ['audio', 'voice', 'image', 'video', 'document', 'sticker', 'contacts'].includes(type) ? 'unsupported' : 'silent';
}

/** "add to it": the new lines join the open draft (same item = quantities added), the groups to choose from and the misses are kept. */
export function mergeSlim(open: Slim, add: Slim): Slim {
  const lines = open.lines.map(l => ({ ...l }));
  for (const l of add.lines) { const i = lines.findIndex(x => x.product_id === l.product_id && (x.note ?? '') === (l.note ?? '')); if (i >= 0) lines[i].quantity += l.quantity; else lines.push({ ...l }); }
  return { lines, choices: [...open.choices, ...add.choices], not_found: [...new Set([...open.not_found, ...add.not_found])] };
}

/** One line: shop(s) · items · total in both currencies · what is left to choose · what was not found. No item list. */
export function waSummary(d: Pick<BasketDraft, 'lines' | 'choices' | 'not_found'>, lang: Lang | L2, fx: number | null): string {
  const l = two(lang); const t = (k: 'items' | 'choose' | 'missing' | 'shops') => WA_TEXT[k][l];
  const shops = [...new Map(d.lines.map(x => [x.shop.id, x.shop.name?.[l] || x.shop.name?.ar || x.shop.name?.en || ''])).values()].filter(Boolean);
  const usd = Math.round(d.lines.reduce((s, x) => s + x.price_usd * Math.max(1, Math.round(x.quantity)), 0) * 100) / 100;
  const parts: string[] = [];
  if (shops.length === 1) parts.push(shops[0]); else if (shops.length > 1) parts.push(`${shops.length} ${t('shops')}`);
  if (d.lines.length) parts.push(`${d.lines.length} ${t('items')}`, fx ? `$${usd.toFixed(2)} (${toLbp(usd, fx).toLocaleString('en-US')} ${l === 'ar' ? 'ل.ل.' : 'L.L.'})` : `$${usd.toFixed(2)}`);
  if (d.choices.length) parts.push(`${d.choices.length} ${t('choose')}`);
  if (d.not_found.length) parts.push(`${d.not_found.length} ${t('missing')}`);
  return parts.join(' · ');
}

export type WaDeps = Deps & {
  drafts: {
    /** the conversation's latest draft that has not expired, as stored (ids only) */
    latest(conversationId: string): Promise<Slim | null>;
    /** stores a draft, returns its id (the link), or null when it could not be stored */
    save(conversationId: string, phone: string, draft: Slim): Promise<string | null>;
  };
};
export type WaInput = { tenant: { id: string; brand: string; fx_lbp_rate?: number | string | null }; phone: string; text: string; site: string; shops?: ShopHint[] };
export type WaOutcome = { reply: string | null; as: 'yorgo' | 'paused' | 'off' | 'error'; draft_id?: string | null; cost_usd?: number; error?: string; turn: TurnResult };

/** One customer text → what to send back (null = stay silent: Yorgo is off for this market). */
export async function waTurn(d: WaDeps, i: WaInput): Promise<WaOutcome> {
  const site = i.site.replace(/\/+$/, '');
  const turn = await runTurn(d, { tenant: i.tenant, userId: null, waPhone: i.phone, mode: 'shopper', channel: 'whatsapp', shopId: null, role: null, conversationId: null, message: i.text, shops: i.shops });
  // the language of our own lines: the turn's when it ran, otherwise from this message alone
  const guess: L2 = /[؀-ۿ]/.test(i.text) ? 'ar' : 'en';
  if (turn.status === 'paused') {
    if (turn.reason === 'off') return { reply: null, as: 'off', turn };
    return { reply: fill(WA_TEXT[turn.reason === 'rate' ? 'rate' : 'paused'][guess], { site }), as: 'paused', turn };
  }
  if (turn.status === 'error') return { reply: fill(WA_TEXT.failed[guess], { site }), as: 'error', error: turn.error, turn };

  const lang = two(turn.lang); const fx = Number(i.tenant.fx_lbp_rate ?? 0) || null;
  const parts: string[] = []; if (turn.reply) parts.push(turn.reply);
  let draftId: string | null = null;
  const baskets = (turn.drafts as ({ kind?: string } & Partial<BasketDraft>)[]).filter(x => x.kind === 'draft_basket');
  if (baskets.length) {
    // several drafts in one turn: the later ones were added to the first (as the app card does); "add" also joins the draft sent before
    let full: Pick<BasketDraft, 'lines' | 'choices' | 'not_found'> = { lines: [], choices: [], not_found: [] }; let slim: Slim = { lines: [], choices: [], not_found: [] };
    for (const b of baskets) { const piece = { lines: b.lines ?? [], choices: b.choices ?? [], not_found: b.not_found ?? [] }; full = joinFull(full, piece); slim = mergeSlim(slim, slimBasket(piece)); }
    if (baskets[0].add === true) {
      const open = await d.drafts.latest(turn.conversation_id).catch(() => null);
      // the summary must describe what the link will show — the whole basket, read again from the catalog — not only what was added
      if (open) { slim = mergeSlim(open, slim); full = await hydrateBasket({ sb: d.sb, tenantId: i.tenant.id, fx }, slim).catch(() => full); }
    }
    const hasAny = slim.lines.length || slim.choices.length;
    if (hasAny) {
      draftId = await d.drafts.save(turn.conversation_id, i.phone, slim).catch(() => null);
      if (draftId) {
        parts.push(`🛒 ${waSummary(full, lang, fx)}`, fill(WA_TEXT.open[lang], { link: `${site}/y/${draftId}` }));
      } else parts.push(fill(WA_TEXT.failed[lang], { site }));
    }
  }
  if (turn.first) parts.push(fill(WA_TEXT.notice[lang], { brand: i.tenant.brand }));
  return { reply: parts.join('\n\n') || null, as: 'yorgo', draft_id: draftId, cost_usd: turn.cost_usd, turn };
}

function joinFull<T extends Pick<BasketDraft, 'lines' | 'choices' | 'not_found'>>(a: T, b: Pick<BasketDraft, 'lines' | 'choices' | 'not_found'>): Pick<BasketDraft, 'lines' | 'choices' | 'not_found'> {
  const lines = a.lines.map(l => ({ ...l }));
  for (const l of b.lines) { const i = lines.findIndex(x => x.product_id === l.product_id && (x.note ?? '') === (l.note ?? '')); if (i >= 0) lines[i].quantity += l.quantity; else lines.push({ ...l }); }
  return { lines, choices: [...a.choices, ...b.choices], not_found: [...new Set([...a.not_found, ...b.not_found])] };
}
