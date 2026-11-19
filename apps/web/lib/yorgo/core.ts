// One exchange with Yorgo: gate → history → model (with tools, run as the caller) → metering. Used by the app route today and by
// the WhatsApp webhook later. No provider or database client is created here: both are passed in, so this file is testable as is.
import { costOf, type Usage, type YorgoConfig } from './config';
import type { Block, ModelClient, Turn } from './model';
import { systemPrompt } from './prompts';
import { toolsFor, type Mode, type Role, type ToolCtx } from './tools';

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Query = { select(c: string): Query; eq(c: string, v: unknown): Query; order(c: string, o: { ascending: boolean }): Query; limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }> };
export type Deps = {
  model: ModelClient; cfg: YorgoConfig;
  admin: { rpc: Rpc };                               // service role: ONLY yorgo_gate and yorgo_record (switches, caps, metering)
  sb: { rpc: Rpc; from(t: string): Query };  // (tools may use the same `from` for the public catalog)          // the caller's own client: history and every tool
};
export type TurnInput = {
  tenant: { id: string; brand: string; fx_lbp_rate?: number | string | null }; userId: string; mode: Mode; channel: 'app' | 'pos' | 'whatsapp';
  shopId: string | null; shopName?: string | null; role: Role | null; conversationId: string | null; message: string;
  focusShop?: { id: string; name: string } | null;      // shopper mode: the shop page they are on, as a hint for the model only
};
export type TurnResult =
  | { status: 'ok'; conversation_id: string; reply: string; drafts: unknown[]; cost_usd: number }
  | { status: 'paused'; reason: 'off' | 'rate' | 'cap_global' | 'cap_shop' | 'cap_user' }
  | { status: 'error'; error: string; conversation_id?: string };

type Stored = { role: 'user' | 'assistant' | 'tool'; content: Block[]; model?: string; cost_usd?: number } & Partial<Usage>;

export async function runTurn(d: Deps, i: TurnInput): Promise<TurnResult> {
  const text = i.message.trim().slice(0, d.cfg.maxMessageChars);
  if (!text) return { status: 'error', error: 'empty_message' };
  if (i.mode === 'seller' && (!i.shopId || !i.role)) return { status: 'error', error: 'not_staff' };

  // 1. switches, rate, caps — before a single token is spent
  const gate = await d.admin.rpc('yorgo_gate', { p_tenant: i.tenant.id, p_user: i.userId, p_mode: i.mode, p_shop: i.shopId });
  const g = (gate.data ?? {}) as { ok?: boolean; reason?: string; history_turns?: number };
  if (gate.error) return { status: 'error', error: 'gate_failed' };
  if (!g.ok) return { status: 'paused', reason: (g.reason as 'off') ?? 'off' };

  // 2. history, read with the caller's own token: a conversation that is not theirs simply comes back empty and a new one starts
  let conversationId = i.conversationId;
  let history: Turn[] = [];
  if (conversationId) {
    const { data } = await d.sb.from('yorgo_messages').select('role,content').eq('conversation_id', conversationId).order('id', { ascending: false }).limit((g.history_turns ?? 12) * 3);
    const rows = ((data as { role: Stored['role']; content: Block[] }[] | null) ?? []).reverse();
    if (!rows.length) conversationId = null;
    history = toTurns(rows);
  }

  // 3. the model, with the tools this person may use
  const tools = toolsFor(i.mode, i.role);
  const ctx: ToolCtx = { sb: d.sb, tenantId: i.tenant.id, mode: i.mode, shopId: i.shopId, role: i.role, fx: Number(i.tenant.fx_lbp_rate ?? 0) || null };
  const system = systemPrompt({ brand: i.tenant.brand, mode: i.mode, role: i.role, shopName: i.shopName, focusShop: i.mode === 'shopper' ? i.focusShop : null });
  const fresh: Stored[] = [{ role: 'user', content: [{ type: 'text', text }] }];
  // the reply language is decided here, not left to the model: small models answer Arabizi in English or in Arabic script.
  // The note travels with this call only; what is stored is the person's own words.
  const note = languageNote(text, history);
  const model = i.mode === 'shopper' ? d.cfg.modelShopper : d.cfg.modelDefault;      // customers get the stronger model (config.ts)
  const messages: Turn[] = [...history, { role: 'user', content: [{ type: 'text', text }, ...(note ? [{ type: 'text' as const, text: note }] : [])] }];
  let reply = ''; let failure: string | null = null; let cost = 0; const drafts: unknown[] = [];
  try {
    for (let round = 0; ; round++) {
      const res = await d.model.create({ model, system, tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })), messages, maxTokens: d.cfg.maxTokens });
      const c = costOf(model, res.usage, d.cfg.prices); cost += c;
      fresh.push({ role: 'assistant', content: res.content, model, ...res.usage, cost_usd: c });
      messages.push({ role: 'assistant', content: res.content });
      const calls = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      if (res.stop !== 'tool_use' || !calls.length) { reply = res.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').trim(); break; }
      if (round >= d.cfg.maxToolRounds) { failure = 'too_many_tool_rounds'; break; }
      const results: Block[] = [];
      for (const call of calls) {
        const tool = tools.find(t => t.name === call.name);                       // a tool outside this person's list does not exist
        try {
          if (!tool) throw new Error('unknown_tool');
          const out = await tool.run(call.input ?? {}, ctx) as Record<string, unknown> | unknown[];
          // a draft goes to the screen, not back to the model: the model only learns that it was shown
          if (out && !Array.isArray(out) && out.draft) { drafts.push({ kind: call.name, ...(out.draft as object) }); const { draft: _d, ...rest } = out; void _d; results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(rest) }); }
          else results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ error: (e as Error).message.slice(0, 120) }), is_error: true });
        }
      }
      fresh.push({ role: 'tool', content: results });
      messages.push({ role: 'user', content: note ? [...results, { type: 'text', text: note }] : results });   // the language note again: the answer is written right after this turn
    }
  } catch (e) { failure = (e as Error).message.slice(0, 160); }

  // 4. metering — also when the model failed half-way: what was spent is spent
  const rec = await d.admin.rpc('yorgo_record', { p_conversation: conversationId, p_tenant: i.tenant.id, p_user: i.userId, p_mode: i.mode, p_shop: i.shopId, p_channel: i.channel, p_messages: fresh, p_summary: null });
  const id = typeof rec.data === 'string' ? rec.data : conversationId;
  if (rec.error || !id) return { status: 'error', error: 'record_failed' };
  if (failure || (!reply && !drafts.length)) return { status: 'error', error: failure ?? 'no_reply', conversation_id: id };
  return { status: 'ok', conversation_id: id, reply, drafts, cost_usd: Math.round(cost * 1e6) / 1e6 };
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
  return detectScript(text) ? 'ar' : 'en';
}
export function languageNote(text: string, history: Turn[] = []): string {
  const k = replyLanguage(text, history);
  const say = k === 'ar' ? 'in Arabic script: simple Lebanese-friendly Arabic' : k === 'arabizi' ? 'in Lebanese Arabizi: Arabic in Latin letters with 2 3 5 7' : 'in English';
  return `(App note — follow it, never mention it: write your reply ${say}. Item names may stay as the shop wrote them.)`;
}
