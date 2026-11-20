import { describe, expect, it } from 'vitest';
import { costOf, yorgoConfig } from './config';
import { askedLanguage, cleanReply, detectScript, isGarbled, isShortNeutral, languageNote, replyLanguage, runTurn, toTurns, type Deps, type TurnInput } from './core';
import type { ModelRequest, ModelResponse } from './model';
import { toolsFor } from './tools';
import { systemPrompt } from './prompts';

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
    expect(calls.userRpc).toEqual([['match_items', { p_tenant: 't1', p_phrases: ['man2ouche za3tar'], p_shop: 'shop-A', p_limit: 6 }]]);
    expect(calls.adminRpc.map(c => c[0])).toEqual(['yorgo_gate', 'yorgo_record']);
    const rec = calls.adminRpc[1][1] as { p_messages: { role: string; cost_usd?: number }[]; p_shop: string };
    expect(rec.p_messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const each = costOf(cfg.modelDefault, usage, cfg.prices);
    expect(rec.p_messages[1].cost_usd).toBe(each);
    expect((r as { cost_usd: number }).cost_usd).toBeCloseTo(each * 2, 6);
    // the second call carries the tool result back, as a user turn
    expect(calls.model[1].messages.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1' }, { type: 'text' }] });   // + the language note
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
    expect(toolsFor('seller', 'stock').map(t => t.name)).not.toContain('clear_draft'); expect(toolsFor('seller', 'cashier').map(t => t.name)).toContain('clear_draft');
    expect(toolsFor('shopper', null).map(t => t.name)).toEqual(['match_items', 'draft_basket', 'clear_draft']);
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
  it('fills a shopper basket from the public catalog and drops what is not on sale', async () => {
    const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
    const shop = { id: 's1', tenant_id: 't1', slug: 'abou-elie', name: { ar: 'دكان' }, whatsapp: null, min_order_usd: 0, pickup_enabled: true, status: 'active' };
    const rows = [{ id: A, name: { ar: 'خبز' }, unit: 'bag', price_usd: '1.25', is_available: true, is_active: true, visible_online: true, available_days: null, shops: shop },
      { id: B, name: { ar: 'مخفي' }, unit: null, price_usd: 2, is_available: true, is_active: true, visible_online: false, available_days: null, shops: shop },
      { id: C, name: { ar: 'غريب' }, unit: null, price_usd: 3, is_available: true, is_active: true, visible_online: true, available_days: null, shops: { ...shop, tenant_id: 'other' } }];
    const tool = toolsFor('shopper', null).find(t => t.name === 'draft_basket')!;
    const asked: unknown[] = [];
    const out = await tool.run({ lines: [{ product_id: A, quantity: 2 }, { product_id: B, quantity: 1 }], choices: [{ phrase: 'x', options: [A, C] }], not_found: ['nido'] },
      { sb: { rpc: async () => ({ data: null, error: null }), from: () => ({ select: () => ({ in: async (_c: string, ids: string[]) => { asked.push(ids); return { data: rows, error: null }; } }) }) }, tenantId: 't1', mode: 'shopper', shopId: null, role: null }) as { draft: { lines: { product_id: string; quantity: number; price_usd: number; shop: { slug: string } }[]; choices: unknown[]; not_found: string[] } };
    expect(asked).toEqual([[A, B, C]]);
    expect(out.draft.lines.map(l => [l.product_id, l.quantity, l.price_usd, l.shop.slug])).toEqual([[A, 2, 1.25, 'abou-elie'], [A, 1, 1.25, 'abou-elie']]);   // hidden item dropped; a choice with one real option becomes a line
    expect(out.draft.choices).toEqual([]); expect(out.draft.not_found).toEqual(['nido']);
    expect(toolsFor('seller', 'owner').map(t => t.name)).not.toContain('draft_basket');
  });
  it('tells Arabic, Arabizi and English apart, and sends the note with the call only', async () => {
    expect(detectScript('bade khebez w labne w 2 pepsi')).toBe('arabizi');
    expect(detectScript('fi 3anna pepsi kbire?')).toBe('arabizi');
    expect(detectScript('2 man2ouche za3tar')).toBe('arabizi');
    expect(detectScript('عندك نسكافيه؟')).toBe('ar');
    expect(detectScript('مرحبا بدي ربطتين خبز و pepsi')).toBe('ar');
    expect(detectScript('do you have 2 pepsi and 1 kg sugar please')).toBeNull();
    expect(detectScript('2 bread, 3 nescafe, 500g cheese')).toBeNull();
    const { deps, calls } = rig({ replies: [say('tamem')] });
    await runTurn(deps, base);
    expect(calls.model[0].messages.at(-1)!.content).toHaveLength(2);                                   // the words + the note
    const rec = calls.adminRpc[1][1] as { p_messages: { content: unknown[] }[] };
    expect(rec.p_messages[0].content).toEqual([{ type: 'text', text: base.message }]);                  // stored: the words only
  });
  it('replies in the language asked for, else English to English and Arabic to Arabic or Arabizi', () => {
    expect(replyLanguage('bade khebez w labne')).toBe('ar');
    expect(replyLanguage('عندك نسكافيه؟')).toBe('ar');
    expect(replyLanguage('do you have pepsi')).toBe('en');
    expect(askedLanguage('b3atle l text bil arabic')).toBe('ar');
    expect(askedLanguage('b3atle bil arabe chou 3am bet2oul')).toBe('ar');
    expect(askedLanguage('please answer in English')).toBe('en');
    expect(askedLanguage('ktebe bil arabizi')).toBe('arabizi');
    expect(askedLanguage('bade khebez 3arabe')).toBeNull();
    // a request holds for the rest of the conversation, until another one
    const h = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'b3atle bil english' }] }, { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] }];
    expect(replyLanguage('fi pepsi?', h)).toBe('en');
    expect(replyLanguage('la2 bil 3arabe', h)).toBe('ar');
    expect(languageNote('fi pepsi?')).toMatch(/never mention it: write your reply in Arabic script/);
  });
  it('never shows or keeps broken characters: garbled lines and the apology are dropped, a fully garbled answer is asked again once', async () => {
    const moji = (t: string) => Buffer.from(t, 'utf8').toString('latin1');                 // "السلة" → "Ø§Ù„Ø³Ù„Ø©"
    const good = 'جهّزت لك السلة: زعتر، جبنة ولحمة.';
    expect(isGarbled(good)).toBe(false); expect(cleanReply(good)).toBe(good);
    expect(isGarbled('Total: 5 Ø dollars')).toBe(false);                                   // one odd letter is not mojibake
    const mixed = `${moji('جهّزت لك السلة من فرن الضيعة')}\n\nSorry, that came out garbled. Let me write it cleanly:\n\n${good}`;
    expect(cleanReply(mixed)).toBe(good);
    // the very text seen on prod (another code page: Ų, Ŗ, Ž)
    expect(cleanReply(`ØŖŲ… ŲØ³ŲŲØ§Ø¡ ŲØ¨ØŲ Ø§ŲŲ\nŲŲ ŲŲŲ ŲŲŲ ŲŲŲŲ\nSorry, that came out garbled.\n${good}`)).toBe(good);
    // the model corrected itself in the same reply: one call, the clean part is shown and stored
    const a = rig({ replies: [say(mixed)] });
    const ra = await runTurn(a.deps, { ...base, mode: 'shopper', shopId: null, role: null });
    expect(ra).toMatchObject({ status: 'ok', reply: good }); expect(a.calls.model.length).toBe(1);
    expect(JSON.stringify(a.calls.adminRpc.find(c => c[0] === 'yorgo_record'))).not.toMatch(/Ø|garbled/);
    // nothing readable at all: asked once more, the clean answer is the reply
    const b = rig({ replies: [say(moji(good)), say(good)] });
    const rb = await runTurn(b.deps, { ...base, mode: 'shopper', shopId: null, role: null });
    expect(rb).toMatchObject({ status: 'ok', reply: good }); expect(b.calls.model.length).toBe(2);
    expect(JSON.stringify(b.calls.model[1].messages.at(-1))).toContain('broken characters');
    expect(JSON.stringify(b.calls.adminRpc.find(c => c[0] === 'yorgo_record'))).not.toContain('Ø');
    // still broken the second time: no third call, and nothing garbled is shown
    const c = rig({ replies: [say(moji(good)), say(moji(good))] });
    const rc = await runTurn(c.deps, { ...base, mode: 'shopper', shopId: null, role: null });
    expect(c.calls.model.length).toBe(2); expect(JSON.stringify(rc)).not.toContain('Ø');
  });
  it('a short answer keeps the conversation language; a shop is found by name or by who it is known as; an added item is marked add', async () => {
    const said = (role: 'user' | 'assistant', text: string) => ({ role, content: [{ type: 'text' as const, text }] });
    expect(isShortNeutral('eh')).toBe(true); expect(isShortNeutral('330ml')).toBe(true); expect(isShortNeutral('badde pepsi')).toBe(false);
    const arabic = [said('user', 'b3atle eza 7ada 3endo laban 3iran'), said('assistant', 'إي، فرن الضيعة عندو.')];
    expect(replyLanguage('eh', arabic)).toBe('ar'); expect(replyLanguage('1', arabic)).toBe('ar'); expect(replyLanguage('yes', arabic)).toBe('ar');
    expect(replyLanguage('yes', [said('user', 'do you have pepsi cans'), said('assistant', 'Yes.')])).toBe('en');
    expect(replyLanguage('1', [...arabic, said('user', 'eh'), said('assistant', 'تمام')])).toBe('ar');          // skips the earlier short answer too
    expect(replyLanguage('can you find a store that sells pepsi', arabic)).toBe('en');                             // a real English sentence still switches
    const p = systemPrompt({ brand: 'Suq', mode: 'shopper', role: null, shops: [{ id: 'shop-9', name_ar: 'فرن الضيعة', name_en: 'Furn El Dayaa', known_as: 'إيلي المير', known_as_en: 'Elie El Mir' }] });
    expect(p).toContain('shop-9 | فرن الضيعة / Furn El Dayaa | known as: إيلي المير / Elie El Mir'); expect(p).toContain('add:true'); expect(p).not.toContain('how many would');
    expect(systemPrompt({ brand: 'Suq', mode: 'seller', role: 'cashier', shopName: 'A' })).not.toContain('known as');
    // add: the draft that reaches the screen says so, and options may be up to 6 for a customer
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const t = toolsFor('shopper', null).find(x => x.name === 'draft_basket')!;
    const rows = [1, 2, 3, 4, 5, 6].map(n => ({ id: id(n), name: { en: `P${n}` }, unit: null, price_usd: 1, is_available: true, is_active: true, visible_online: true, available_days: null, shops: { id: 's1', tenant_id: 't1', slug: 's', name: { en: 'S' }, whatsapp: null, min_order_usd: 0, pickup_enabled: true, status: 'active' } }));
    const sb = { rpc: async () => ({ data: null, error: null }), from: () => ({ select: () => ({ in: async () => ({ data: rows, error: null }) }) }) };
    const out = await t.run({ add: true, lines: [{ product_id: id(1), quantity: 2 }], choices: [{ phrase: 'pepsi', options: [1, 2, 3, 4, 5, 6].map(id) }] }, { sb, tenantId: 't1', mode: 'shopper', shopId: null, role: null }) as { draft: { add?: boolean; choices: { options: unknown[] }[] }; added_to_open_draft?: boolean };
    expect(out.draft.add).toBe(true); expect(out.added_to_open_draft).toBe(true); expect(out.draft.choices[0].options.length).toBe(6);
    const so = await toolsFor('seller', 'cashier').find(x => x.name === 'draft_order')!.run({ add: true, lines: [{ product_id: id(1), quantity: 1 }] }, { sb, tenantId: 't1', mode: 'seller', shopId: 's1', role: 'cashier' }) as { draft: { add?: boolean }; added_to_open_draft?: boolean };
    expect(so.draft.add).toBe(true); expect(so.added_to_open_draft).toBe(true);
    expect(((await t.run({ lines: [{ product_id: id(1), quantity: 1 }] }, { sb, tenantId: 't1', mode: 'shopper', shopId: null, role: null })) as { draft: { add?: boolean } }).draft.add).toBeUndefined();
  });
  it('gives each candidate its category, and counts what no shop has even when the answer is only text', async () => {
    const { deps, calls } = rig({ replies: [toolCall({ phrases: ['za3tar', 'lawze naye'] }), say('ما لقيت لوز ني.')] });
    deps.sb.rpc = async () => ({ data: [
      { phrase_no: 1, product_id: 'p1', shop_id: 's1', shop_name: { ar: 'أ' }, name: { en: 'Thyme seeds' }, unit: null, price_usd: 1, price_currency: 'usd', price_lbp: 0, is_available: true, available_days: null, score: 0.9 },
      { phrase_no: 2, product_id: 'p2', shop_id: 's1', shop_name: { ar: 'أ' }, name: { en: 'Smoked almonds' }, unit: null, price_usd: 1, price_currency: 'usd', price_lbp: 0, is_available: true, available_days: null, score: 0.3 }], error: null });
    const hist = { select: () => hist, eq: () => hist, order: () => hist, limit: async () => ({ data: [], error: null }) };
    deps.sb.from = ((tb: string) => (tb === 'products' ? { select: () => ({ in: async () => ({ data: [{ id: 'p1', section: 'Seeds' }, { id: 'p2', section: 'Nuts' }], error: null }) }) } : hist)) as never;
    const r = await runTurn(deps, { ...base, mode: 'shopper', shopId: null, role: null, message: 'badde za3tar w lawze naye' });
    expect(r).toMatchObject({ status: 'ok', missed: ['lawze naye'] });
    expect(JSON.stringify(calls.model[1].messages.at(-1))).toContain('\\"category\\":\\"Seeds\\"');
  });
});
