// One exchange with Yorgo: gate → history → model (with tools, run as the caller) → metering. Used by the app route today and by
// the WhatsApp webhook later. No provider or database client is created here: both are passed in, so this file is testable as is.
import { costOf, type Usage, type YorgoConfig } from './config';
import type { Block, ModelClient, Turn } from './model';
import { systemPrompt, type ShopHint } from './prompts';
import { toolsFor, type Mode, type Role, type ToolCtx } from './tools';

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Query = { select(c: string): Query; eq(c: string, v: unknown): Query; order(c: string, o: { ascending: boolean }): Query; limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }> };
export type Deps = {
  model: ModelClient; cfg: YorgoConfig;
  admin: { rpc: Rpc };                               // service role: ONLY the gate and the record (switches, caps, metering) — and, on WhatsApp, the phone's own history
  sb: { rpc: Rpc; from(t: string): Query };  // (tools may use the same `from` for the public catalog)          // the caller's own client: history and every tool
};
export type TurnInput = {
  tenant: { id: string; brand: string; fx_lbp_rate?: number | string | null }; userId: string | null; mode: Mode; channel: 'app' | 'pos' | 'whatsapp';
  waPhone?: string | null;                              // WhatsApp (95): no account — the conversation, the rate and the cap belong to the phone; the tools read the public catalog
  shopId: string | null; shopName?: string | null; role: Role | null; conversationId: string | null; message: string;
  focusShop?: { id: string; name: string } | null;      // shopper mode: the shop page they are on, as a hint for the model only
  shops?: ShopHint[];                                   // shopper mode: the open shops (public), so "min 3end el mir" finds its shop
};
export type TurnResult =
  | { status: 'ok'; conversation_id: string; reply: string; drafts: unknown[]; cost_usd: number; missed: string[]; first?: boolean; lang: Lang }
  | { status: 'paused'; reason: 'off' | 'rate' | 'cap_global' | 'cap_shop' | 'cap_user' }
  | { status: 'error'; error: string; conversation_id?: string };

type Stored = { role: 'user' | 'assistant' | 'tool'; content: Block[]; model?: string; cost_usd?: number } & Partial<Usage>;

export async function runTurn(d: Deps, i: TurnInput): Promise<TurnResult> {
  const text = i.message.trim().slice(0, d.cfg.maxMessageChars);
  if (!text) return { status: 'error', error: 'empty_message' };
  if (i.mode === 'seller' && (!i.shopId || !i.role)) return { status: 'error', error: 'not_staff' };

  // 1. switches, rate, caps — before a single token is spent
  const wa = i.channel === 'whatsapp' ? (i.waPhone ?? '').trim() : '';
  if (i.channel === 'whatsapp' ? (!wa || i.mode !== 'shopper') : !i.userId) return { status: 'error', error: 'no_caller' };
  const gate = wa ? await d.admin.rpc('yorgo_gate_wa', { p_tenant: i.tenant.id, p_phone: wa })
    : await d.admin.rpc('yorgo_gate', { p_tenant: i.tenant.id, p_user: i.userId, p_mode: i.mode, p_shop: i.shopId });
  const g = (gate.data ?? {}) as { ok?: boolean; reason?: string; history_turns?: number; conversation_id?: string | null; first?: boolean };
  if (gate.error) return { status: 'error', error: 'gate_failed' };
  if (!g.ok) return { status: 'paused', reason: (g.reason as 'off') ?? 'off' };

  // 2. history, read with the caller's own token: a conversation that is not theirs simply comes back empty and a new one starts
  let conversationId = wa ? (g.conversation_id ?? null) : i.conversationId;      // WhatsApp: the phone's latest conversation, as the gate found it
  let history: Turn[] = [];
  if (conversationId && wa) {
    const { data } = await d.admin.rpc('yorgo_history_wa', { p_conversation: conversationId, p_phone: wa, p_limit: (g.history_turns ?? 12) * 3 });
    const rows = ((data as { role: Stored['role']; content: Block[] }[] | null) ?? []).reverse();
    if (!rows.length) conversationId = null;
    history = toTurns(rows);
  } else if (conversationId) {
    const { data } = await d.sb.from('yorgo_messages').select('role,content').eq('conversation_id', conversationId).order('id', { ascending: false }).limit((g.history_turns ?? 12) * 3);
    const rows = ((data as { role: Stored['role']; content: Block[] }[] | null) ?? []).reverse();
    if (!rows.length) conversationId = null;
    history = toTurns(rows);
  }

  // 3. the model, with the tools this person may use
  const tools = toolsFor(i.mode, i.role);
  const ctx: ToolCtx = { sb: d.sb, tenantId: i.tenant.id, mode: i.mode, shopId: i.shopId, role: i.role, fx: Number(i.tenant.fx_lbp_rate ?? 0) || null };
  const system = systemPrompt({ brand: i.tenant.brand, mode: i.mode, role: i.role, shopName: i.shopName, focusShop: i.mode === 'shopper' ? i.focusShop : null, shops: i.mode === 'shopper' ? i.shops : undefined });
  const fresh: Stored[] = [{ role: 'user', content: [{ type: 'text', text }] }];
  // the reply language is decided here, not left to the model: small models answer Arabizi in English or in Arabic script.
  // The note travels with this call only; what is stored is the person's own words.
  const note = languageNote(text, history);
  const model = i.mode === 'shopper' ? d.cfg.modelShopper : d.cfg.modelDefault;      // customers get the stronger model (config.ts)
  const messages: Turn[] = [...history, { role: 'user', content: [{ type: 'text', text }, ...(note ? [{ type: 'text' as const, text: note }] : [])] }];
  let reply = ''; let failure: string | null = null; let cost = 0; const drafts: unknown[] = []; let retried = false; const missed: string[] = [];
  try {
    for (let round = 0; ; round++) {
      const res = await d.model.create({ model, system, tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })), messages, maxTokens: d.cfg.maxTokens });
      const c = costOf(model, res.usage, d.cfg.prices); cost += c;
      // what is kept (and read back as history next time) never holds broken characters: see cleanReply
      fresh.push({ role: 'assistant', content: storedBlocks(res.content), model, ...res.usage, cost_usd: c });
      messages.push({ role: 'assistant', content: res.content });
      const calls = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      if (res.stop !== 'tool_use' || !calls.length) {
        const raw = res.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').trim();
        reply = cleanReply(raw);
        // the whole answer came out broken: ask once more (rare; the model usually corrects itself in the same reply)
        if (isGarbled(raw) && reply.length < 12 && !retried && round < d.cfg.maxToolRounds) {
          retried = true; reply = '';
          const again: Block[] = [{ type: 'text', text: GARBLED_NOTE }, ...(note ? [{ type: 'text' as const, text: note }] : [])];
          fresh.push({ role: 'tool', content: [{ type: 'text', text: GARBLED_NOTE }] });
          messages.push({ role: 'user', content: again });
          continue;
        }
        break;
      }
      if (round >= d.cfg.maxToolRounds) { failure = 'too_many_tool_rounds'; break; }
      const results: Block[] = [];
      for (const call of calls) {
        const tool = tools.find(t => t.name === call.name);                       // a tool outside this person's list does not exist
        try {
          if (!tool) throw new Error('unknown_tool');
          const out = await tool.run(call.input ?? {}, ctx) as Record<string, unknown> | unknown[];
          // a draft goes to the screen, not back to the model: the model only learns that it was shown
          if (out && !Array.isArray(out) && out.draft) { drafts.push({ kind: call.name, ...(out.draft as object) }); const { draft: _d, ...rest } = out; void _d; results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(rest) }); }
          else {
            // asked for and not in any catalog (nothing came back, or nothing close): counted for the shops, whatever the model then says
            if (call.name === 'match_items' && Array.isArray(out)) for (const r of out as { phrase?: string; candidates?: { score?: number; matched_on?: string }[] }[]) {
              const best = Math.max(0, ...(r.candidates ?? []).map(c => (c.matched_on === 'kind' ? 1 : Number(c.score) || 0)));
              if (r.phrase && best < MISS_BELOW && !missed.some(m => m.toLowerCase() === r.phrase!.toLowerCase())) missed.push(r.phrase);
            }
            results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) });
          }
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ error: (e as Error).message.slice(0, 120) }), is_error: true });
        }
      }
      fresh.push({ role: 'tool', content: results });
      messages.push({ role: 'user', content: note ? [...results, { type: 'text', text: note }] : results });   // the language note again: the answer is written right after this turn
    }
  } catch (e) { failure = (e as Error).message.slice(0, 160); }

  // 4. metering — also when the model failed half-way: what was spent is spent
  const rec = wa ? await d.admin.rpc('yorgo_record_wa', { p_conversation: conversationId, p_tenant: i.tenant.id, p_phone: wa, p_messages: fresh })
    : await d.admin.rpc('yorgo_record', { p_conversation: conversationId, p_tenant: i.tenant.id, p_user: i.userId, p_mode: i.mode, p_shop: i.shopId, p_channel: i.channel, p_messages: fresh, p_summary: null });
  const id = typeof rec.data === 'string' ? rec.data : conversationId;
  if (rec.error || !id) return { status: 'error', error: 'record_failed' };
  if (failure || (!reply && !drafts.length)) return { status: 'error', error: failure ?? 'no_reply', conversation_id: id };
  return { status: 'ok', conversation_id: id, reply, drafts, cost_usd: Math.round(cost * 1e6) / 1e6, missed, lang: replyLanguage(text, history), ...(wa ? { first: g.first === true } : {}) };
}

const MISS_BELOW = 0.45;      // best candidate under this = the person asked for something no shop lists (yorgo_misses)
const GARBLED_NOTE = '(App note — follow it, never mention it: your last reply came out as broken characters. Write the same answer again in clean text, with no apology.)';
/** Arabic that came out as mojibake ("Ø§Ù„Ø³Ù„Ø©" for "السلة"): UTF-8 bytes shown as Latin-1. Seen from the model itself (prod, 2026-11-20). */
const MOJIBAKE = /[ØŲ]|[ÙÚÛ][\u0080-\u00BF\u0152-\u0192\u02C6\u02DC\u2013-\u203A\u20AC\u2122]/g;   // Ø / Ų lead almost every broken Arabic letter, whatever the code page
export function isGarbled(text: string): boolean { return (text.match(MOJIBAKE) ?? []).length >= 3; }
/** The reply the person sees: lines of broken characters are dropped, and with them the model's own "sorry, that came out
 *  garbled, let me write it cleanly". A clean reply is returned untouched. */
export function cleanReply(text: string): string {
  if (!isGarbled(text)) return text;
  const sorry = /garbled|scrambled|came out (wrong|broken)|write (it|that) (again )?cleanly|rewrite (it|that)|مشوّه|مشوه|غير مقروء|بشكل صحيح/i;
  return text.split('\n').filter(l => (l.match(MOJIBAKE) ?? []).length < 2 && !(sorry.test(l) && l.length < 160)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** what is stored of a model answer: no thinking, and text without broken characters (an emptied text block is dropped) */
function storedBlocks(content: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of content) {
    if (b.type === 'thinking' || b.type === 'redacted_thinking') continue;
    if (b.type === 'text') { const t = cleanReply((b as { text: string }).text); if (t) out.push({ ...b, text: t } as Block); continue; }
    out.push(b);
  }
  return out.length ? out : [{ type: 'text', text: '…' }];
}

/** Stored rows → what the model expects. Tool results travel as user turns; the window must open on a real user message,
 *  never in the middle of a tool exchange (a tool result without its call is rejected by the provider). */
export function toTurns(rows: { role: Stored['role']; content: Block[] }[]): Turn[] {
  const start = rows.findIndex(r => r.role === 'user');
  if (start < 0) return [];
  return rows.slice(start).map(r => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content }));
}

/** Which language and script the person wrote in: Arabic script, Lebanese Arabizi (Arabic in Latin letters), or neither (no note). */
export function detectScript(text: string): 'ar' | 'arabizi' | null {
  const arabic = (text.match(/[\u0600-\u06FF]/g) ?? []).length, latin = (text.match(/[a-z]/gi) ?? []).length;
  if (arabic && arabic >= latin) return 'ar';
  const t = ` ${text.toLowerCase()} `;
  const digitInWord = /[a-z][2357]|[2357][a-z]/.test(t.replace(/\b\d+(?:[.,]\d+)?\s?(?:kg|g|gr|l|ml|x|pcs?)\b/g, ' '));
  const marker = /[^a-z](w|bade|badde|baddi|bede|bdi|badna|shu|chou|shou|kifak|kifik|yalla|hayda|hek|mish|ma fi|3al|khebez|kbire?|zghire?|adde|addeh|law sama7t|iza|kamen|ktir|shway|ya3ne|3ande|3anna|3andak|3andkon|fi|mafi|3endo|3ende|3endak|3endkon|3andon|3endon|bade|baddo|eza|hayde|hayk|la2|tayeb|tayyeb|taybe|akid|addesh|2adde|2addesh|bkam|halla2|3am|kif|mnih|ma3|minno|menno)[^a-z]/.test(t);
  if (latin && (digitInWord || marker)) return 'arabizi';
  if (arabic) return 'ar';
  return null;
}
export type Lang = 'ar' | 'en' | 'arabizi';
/** a language the person asked for in so many words ("b3atle bil arabe", "in English please", "بالعربي") */
export function askedLanguage(text: string): Lang | null {
  const t = ` ${text.toLowerCase()} `;
  if (/arabizi|franco|\b(bil|bel|b|bi)\s*(a7rof|7rouf|letters?)\s*(el\s*)?(latin|ajnabiy?e)|بالعربيزي|بالفرانكو/.test(t)) return 'arabizi';
  if (/\b(bil|bel|b|bi|in)\s*(el\s*)?(english|inglize|inglizi|engliziye?|ingliziye?)\b|\benglish (please|plz|pls)\b|بالانكليزي|بالإنكليزي|بالانجليزي|بالإنجليزي|بالانجليزية|بالإنجليزية/.test(t)) return 'en';
  if (/\b(bil|bel|b|bi|in)\s*(el\s*)?(3arabe?h?|3arabi|arabe|arabi|arabic|3arabiye?)\b|\barabic (please|plz|pls|script|letters)\b|بالعربي|بالعربية|بالعربيه|بالأحرف العربية/.test(t)) return 'ar';
  return null;
}
/** The reply language: what they asked for in this conversation (the latest request holds), otherwise their message's own:
 *  English → English, Arabic or Arabizi → Arabic script. */
export function replyLanguage(text: string, history: Turn[] = []): Lang {
  const asked = askedLanguage(text) ?? [...history].reverse().filter(h => h.role === 'user')
    .map(h => askedLanguage(h.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(' '))).find(Boolean) ?? null;
  if (asked) return asked;
  const own = detectScript(text);
  if (own) return 'ar';
  // "eh", "1", "yes", "330ml" say nothing about the language: keep the one of their last real message
  if (isShortNeutral(text)) for (const h of [...history].reverse()) {
    if (h.role !== 'user') continue;
    const t = h.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).filter(x => !x.startsWith('(App note')).join(' ').trim();
    if (!t || isShortNeutral(t)) continue;
    return detectScript(t) ? 'ar' : 'en';
  }
  return 'en';
}
/** a message too short to carry a language: up to three words, no Arabic letters, no Arabizi marker */
export function isShortNeutral(text: string): boolean {
  const t = text.trim();
  return !!t && !/[\u0600-\u06FF]/.test(t) && detectScript(t) === null && t.split(/\s+/).length <= 3;
}
export function languageNote(text: string, history: Turn[] = []): string {
  const k = replyLanguage(text, history);
  const say = k === 'ar' ? 'in Arabic script: simple Lebanese-friendly Arabic' : k === 'arabizi' ? 'in Lebanese Arabizi: Arabic in Latin letters with 2 3 5 7' : 'in English';
  return `(App note — follow it, never mention it: write your reply ${say}. Item names may stay as the shop wrote them.)`;
}
