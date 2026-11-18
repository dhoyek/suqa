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
  tenant: { id: string; brand: string }; userId: string; mode: Mode; channel: 'app' | 'pos' | 'whatsapp';
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
  const ctx: ToolCtx = { sb: d.sb, tenantId: i.tenant.id, mode: i.mode, shopId: i.shopId, role: i.role };
  const system = systemPrompt({ brand: i.tenant.brand, mode: i.mode, role: i.role, shopName: i.shopName, focusShop: i.mode === 'shopper' ? i.focusShop : null });
  const fresh: Stored[] = [{ role: 'user', content: [{ type: 'text', text }] }];
  const messages: Turn[] = [...history, { role: 'user', content: [{ type: 'text', text }] }];
  let reply = ''; let failure: string | null = null; let cost = 0; const drafts: unknown[] = [];
  try {
    for (let round = 0; ; round++) {
      const res = await d.model.create({ model: d.cfg.modelDefault, system, tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })), messages, maxTokens: d.cfg.maxTokens });
      const c = costOf(d.cfg.modelDefault, res.usage, d.cfg.prices); cost += c;
      fresh.push({ role: 'assistant', content: res.content, model: d.cfg.modelDefault, ...res.usage, cost_usd: c });
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
      messages.push({ role: 'user', content: results });
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
