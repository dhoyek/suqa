import { describe, expect, it } from 'vitest';
import { costOf, yorgoConfig } from './config';
import { runTurn, toTurns, type Deps, type TurnInput } from './core';
import type { ModelRequest, ModelResponse } from './model';
import { toolsFor } from './tools';

const cfg = yorgoConfig({});
const usage = { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 2000, cache_write_tokens: 0 };
const base: TurnInput = { tenant: { id: 't1', brand: 'Suq' }, userId: 'u1', mode: 'seller', channel: 'pos', shopId: 'shop-A', shopName: 'A', role: 'cashier', conversationId: null, message: '2 man2ouche za3tar' };

function rig(o: { gate?: unknown; replies: ModelResponse[]; history?: unknown[] }) {
  const calls = { model: [] as ModelRequest[], userRpc: [] as [string, Record<string, unknown>][], adminRpc: [] as [string, Record<string, unknown>][] };
  let n = 0;
  const deps: Deps = {
    cfg,
    model: { create: async req => { calls.model.push(JSON.parse(JSON.stringify(req))); const r = o.replies[n++]; if (!r) throw new Error('model_http_500'); return r; } },
    admin: { rpc: async (fn, args) => { calls.adminRpc.push([fn, args]); return fn === 'yorgo_gate' ? { data: o.gate ?? { ok: true, history_turns: 12 }, error: null } : { data: 'conv-1', error: null }; } },
    sb: {
      rpc: async (fn, args) => { calls.userRpc.push([fn, args]); return { data: [{ phrase_no: 1, product_id: 'p1', shop_id: 'shop-A', shop_name: { ar: 'أ' }, name: { ar: 'زعتر', en: 'Zaatar' }, unit: null, price_usd: 1.12, price_currency: 'lbp', price_lbp: 100000, is_available: true, available_days: null, score: 0.9 }], error: null }; },
      from: () => { const q = { select: () => q, eq: () => q, order: () => q, limit: async () => ({ data: o.history ?? [], error: null }) }; return q as never; },
    },
  };
  return { deps, calls };
}
const toolCall = (input: Record<string, unknown>, name = 'match_items'): ModelResponse => ({ content: [{ type: 'tool_use', id: 'tu1', name, input }], stop: 'tool_use', usage });
const say = (text: string): ModelResponse => ({ content: [{ type: 'text', text }], stop: 'end', usage });

describe('yorgo core', () => {
  it('runs a tool as the caller, answers, and meters every model call', async () => {
    const { deps, calls } = rig({ replies: [toolCall({ phrases: ['man2ouche za3tar'], shop_id: 'shop-B' }), say('زعتر × 2 — 200,000 ل.ل.')] });
    const r = await runTurn(deps, base);
    expect(r).toMatchObject({ status: 'ok', conversation_id: 'conv-1', reply: 'زعتر × 2 — 200,000 ل.ل.' });
    // the seller's own shop, whatever shop the model asked for; through the caller's client, never the service role
    expect(calls.userRpc).toEqual([['match_items', { p_tenant: 't1', p_phrases: ['man2ouche za3tar'], p_shop: 'shop-A', p_limit: 4 }]]);
    expect(calls.adminRpc.map(c => c[0])).toEqual(['yorgo_gate', 'yorgo_record']);
    const rec = calls.adminRpc[1][1] as { p_messages: { role: string; cost_usd?: number }[]; p_shop: string };
    expect(rec.p_messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const each = costOf(cfg.modelDefault, usage, cfg.prices);
    expect(rec.p_messages[1].cost_usd).toBe(each);
    expect((r as { cost_usd: number }).cost_usd).toBeCloseTo(each * 2, 6);
    // the second call carries the tool result back, as a user turn
    expect(calls.model[1].messages.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1' }] });
  });

  it('does not call the model when the gate is closed', async () => {
    for (const reason of ['off', 'rate', 'cap_shop', 'cap_global'] as const) {
      const { deps, calls } = rig({ gate: { ok: false, reason }, replies: [say('x')] });
      expect(await runTurn(deps, base)).toEqual({ status: 'paused', reason });
      expect(calls.model).toHaveLength(0); expect(calls.adminRpc).toHaveLength(1);
    }
  });

  it('refuses a tool that is not in this person\'s list, and keeps going', async () => {
    const { deps, calls } = rig({ replies: [toolCall({ sql: 'select 1' }, 'run_sql'), say('ما قدرت لاقيه')] });
    const r = await runTurn(deps, base);
    expect(r.status).toBe('ok'); expect(calls.userRpc).toHaveLength(0);
    expect(calls.model[1].messages.at(-1)!.content[0]).toMatchObject({ type: 'tool_result', is_error: true });
  });

  it('stops a tool loop and still records what was spent', async () => {
    const { deps, calls } = rig({ replies: Array.from({ length: 9 }, () => toolCall({ phrases: ['x'] })) });
    const r = await runTurn(deps, base);
    expect(r).toMatchObject({ status: 'error', error: 'too_many_tool_rounds', conversation_id: 'conv-1' });
    expect(calls.model).toHaveLength(cfg.maxToolRounds + 1);
    expect(calls.adminRpc.at(-1)![0]).toBe('yorgo_record');
  });

  it('records the cost of completed calls when the provider fails afterwards', async () => {
    const { deps, calls } = rig({ replies: [toolCall({ phrases: ['x'] })] });      // second call throws
    const r = await runTurn(deps, base);
    expect(r.status).toBe('error');
    expect((calls.adminRpc.at(-1)![1] as { p_messages: unknown[] }).p_messages).toHaveLength(3);
  });

  it('seller mode needs a shop and a role; a shopper never gets a shop forced', async () => {
    const a = rig({ replies: [say('x')] });
    expect(await runTurn(a.deps, { ...base, role: null })).toEqual({ status: 'error', error: 'not_staff' });
    expect(a.calls.adminRpc).toHaveLength(0);
    const b = rig({ replies: [toolCall({ phrases: ['pepsi'] }), say('ok')] });
    await runTurn(b.deps, { ...base, mode: 'shopper', shopId: null, role: null, channel: 'app' });
    expect(b.calls.userRpc[0][1]).toMatchObject({ p_shop: null });
  });

  it('history opens on a real user message, never inside a tool exchange', () => {
    const t = toTurns([
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'old', content: '[]' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ]);
    expect(t.map(x => x.role)).toEqual(['user', 'assistant']);
  });

  it('tool list follows mode and role; an unknown model is priced at the dearest rate', () => {
    expect(toolsFor('seller', null)).toHaveLength(0);
    expect(toolsFor('seller', 'setup').map(t => t.name)).toEqual(['match_items']);
    expect(toolsFor('shopper', null).map(t => t.name)).toEqual(['match_items']);
    expect(costOf('some-new-model', usage, cfg.prices)).toBe(costOf('claude-sonnet-5-5', usage, cfg.prices));
    expect(costOf('claude-haiku-5-5', usage, cfg.prices)).toBeCloseTo((1000 * 0.10 + 100 * 0.50 + 2000 * 0.01) / 1e6, 9);
  });
  it('hands a draft to the screen: ids and quantities only, cleaned, and never for a role that cannot sell', async () => {
    const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
    const { deps, calls } = rig({ replies: [toolCall({ lines: [{ product_id: A, quantity: 2, note: ' sliced ' }, { product_id: 'not-an-id', quantity: 1 }, { product_id: B, quantity: -5 }],
      choices: [{ phrase: 'pepsi', options: [A, A, B] }, { phrase: 'x', options: ['bad'] }], not_found: ['nido', ''] }, 'draft_order'), say('2 جاهزين')] });
    const r = await runTurn(deps, base) as { status: string; drafts: unknown[] };
    expect(r.status).toBe('ok');
    expect(r.drafts).toEqual([{ kind: 'draft_order', lines: [{ product_id: A, quantity: 2, note: 'sliced' }, { product_id: B, quantity: 1 }], choices: [{ phrase: 'pepsi', quantity: 1, options: [A, B] }], not_found: ['nido'] }]);
    // the model is told the draft was shown, not handed the draft back
    const back = JSON.parse((calls.model[1].messages.at(-1)!.content[0] as { content: string }).content);
    expect(back).toEqual({ ok: true, shown_to_staff: true, lines: 2, choices: 1, not_found: 1 });
    expect(toolsFor('seller', 'cashier').map(t => t.name)).toContain('draft_order');
    expect(toolsFor('seller', 'setup').map(t => t.name)).not.toContain('draft_order');
    expect(toolsFor('seller', 'stock').map(t => t.name)).not.toContain('draft_order');
    expect(toolsFor('shopper', null).map(t => t.name)).not.toContain('draft_order');
  });
});
