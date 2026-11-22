import { describe, expect, it } from 'vitest';
import { yorgoConfig } from './config';
import type { ModelResponse } from './model';
import { heardLine, mergeSlim, waKind, waSummary, waTextOnly, waTurn, waVoiceTurn, WA_TEXT, type HeardVoice, type Slim, type WaDeps } from './whatsapp';

const usage = { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0 };
const say = (text: string): ModelResponse => ({ content: [{ type: 'text', text }], stop: 'end', usage });
const call = (name: string, input: Record<string, unknown>): ModelResponse => ({ content: [{ type: 'tool_use', id: 'tu' + name, name, input }], stop: 'tool_use', usage });
const shop = { id: 's1', tenant_id: 't1', slug: 'elie', name: { ar: 'دكان إيلي', en: 'Elie Grocery' }, whatsapp: null, min_order_usd: 0, pickup_enabled: true, status: 'active' };
const prod = (id: string, ar: string, usd: number) => ({ id, name: { ar, en: ar }, unit: null, price_usd: usd, price_currency: 'usd', price_lbp: null, is_available: true, is_active: true, visible_online: true, available_days: null, shops: shop });
const P1 = '00000000-0000-4000-8000-000000000001', P2 = '00000000-0000-4000-8000-000000000002', P3 = '00000000-0000-4000-8000-000000000003', P4 = '00000000-0000-4000-8000-000000000004';
const PRODUCTS = [prod(P1, 'خبز عربي', 1.25), prod(P2, 'لبنة', 3.5), prod(P3, 'بيبسي 330', 0.67), prod(P4, 'بيبسي 1.25', 1.4)];

function rig(o: { gate?: unknown; replies: ModelResponse[]; open?: Slim | null; saveFails?: boolean }) {
  const admin: [string, Record<string, unknown>][] = []; const saved: { conv: string; phone: string; draft: Slim }[] = []; let n = 0;
  const deps: WaDeps = {
    cfg: yorgoConfig({}),
    model: { create: async () => { const r = o.replies[n++]; if (!r) throw new Error('model_http_500'); return r; } },
    admin: { rpc: async (fn, args) => { admin.push([fn, args]); return fn === 'yorgo_gate_wa' ? { data: o.gate ?? { ok: true, history_turns: 12, conversation_id: null, first: true }, error: null } : fn === 'yorgo_history_wa' ? { data: [], error: null } : { data: 'conv-1', error: null }; } },
    sb: {
      rpc: async () => ({ data: [], error: null }),
      from: () => { const q = { select: () => q, eq: () => q, order: () => q, limit: async () => ({ data: [], error: null }), in: async (_c: string, ids: string[]) => ({ data: PRODUCTS.filter(p => ids.includes(p.id)), error: null }) }; return q as never; },
    },
    drafts: { latest: async () => o.open ?? null, save: async (conv, phone, draft) => { if (o.saveFails) return null; saved.push({ conv, phone, draft }); return 'd-123'; } },
  };
  return { deps, admin, saved };
}
const input = { tenant: { id: 't1', brand: 'Batroun Basket', fx_lbp_rate: 90000 }, phone: '+96170000001', text: 'bade khebez w labne', site: 'https://m.example/' };

describe('yorgo on whatsapp', () => {
  it('a text becomes a stored draft (ids only) and one short reply: Yorgo\'s line, the summary, the link, the AI notice on the first answer', async () => {
    const { deps, admin, saved } = rig({ replies: [call('draft_basket', { lines: [{ product_id: P1, quantity: 2 }, { product_id: P2, quantity: 1 }], choices: [{ phrase: 'pepsi', quantity: 1, options: [P3, P4] }], not_found: ['zzz'] }), say('جهّزت لك السلة.')] });
    const r = await waTurn(deps, input);
    expect(r.as).toBe('yorgo'); expect(r.draft_id).toBe('d-123');
    expect(saved).toEqual([{ conv: 'conv-1', phone: '+96170000001', draft: { lines: [{ product_id: P1, quantity: 2 }, { product_id: P2, quantity: 1 }], choices: [{ phrase: 'pepsi', quantity: 1, options: [P3, P4] }], not_found: ['zzz'] } }]);
    expect(r.reply).toBe(['جهّزت لك السلة.', '🛒 دكان إيلي · 2 صنف · $6.00 (540,000 ل.ل.) · 1 للاختيار · 1 غير موجود', 'افتح السلة، راجعها واطلب: https://m.example/y/d-123\n(الرابط صالح 24 ساعة)', WA_TEXT.notice.ar.replace('{brand}', 'Batroun Basket')].join('\n\n'));
    // no account anywhere: the phone's own gate and record, no user id
    expect(admin.map(c => c[0])).toEqual(['yorgo_gate_wa', 'yorgo_record_wa']);
    expect(admin[1][1]).toMatchObject({ p_phone: '+96170000001', p_conversation: null });
    expect(JSON.stringify(admin)).not.toContain('p_user');
  });

  it('English gets English; no notice after the first answer; the phone\'s conversation continues', async () => {
    const { deps, admin } = rig({ gate: { ok: true, history_turns: 12, conversation_id: 'conv-0', first: false }, replies: [call('draft_basket', { lines: [{ product_id: P1, quantity: 1 }] }), say('Here is your basket.')] });
    const r = await waTurn(deps, { ...input, text: 'one bread please' });
    expect(r.reply).toBe('Here is your basket.\n\n🛒 Elie Grocery · 1 items · $1.25 (113,000 L.L.)\n\nOpen your basket, check it and order: https://m.example/y/d-123\n(the link works for 24 hours)');
    expect(admin.map(c => c[0])).toEqual(['yorgo_gate_wa', 'yorgo_history_wa', 'yorgo_record_wa']);
  });

  it('"add to it" joins the draft sent before: same item adds up, the rest is kept', async () => {
    const open: Slim = { lines: [{ product_id: P1, quantity: 2 }], choices: [{ phrase: 'pepsi', quantity: 1, options: [P3, P4] }], not_found: ['zzz'] };
    const { deps, saved } = rig({ gate: { ok: true, conversation_id: 'conv-1', first: false }, open, replies: [call('draft_basket', { add: true, lines: [{ product_id: P1, quantity: 1 }, { product_id: P2, quantity: 1 }] }), say('zedtellak.')] });
    const r = await waTurn(deps, { ...input, text: 'zid khebez w labne' });
    expect(saved[0].draft).toEqual({ lines: [{ product_id: P1, quantity: 3 }, { product_id: P2, quantity: 1 }], choices: open.choices, not_found: ['zzz'] });
    expect(r.reply).toContain('🛒 دكان إيلي · 2 صنف · $7.25 (653,000 ل.ل.) · 1 للاختيار · 1 غير موجود');   // 3 bread + 1 labne: the whole basket, not only what was added
  });

  it('an answer without a draft is sent as it is, with no link', async () => {
    const { deps, saved } = rig({ gate: { ok: true, first: false }, replies: [say('فيه بيبسي 330 بـ $0.67.')] });
    const r = await waTurn(deps, { ...input, text: 'fi pepsi?' });
    expect(r.reply).toBe('فيه بيبسي 330 بـ $0.67.'); expect(saved).toEqual([]); expect(r.draft_id).toBeNull();
  });

  it('off = silent; a cap = the paused line; too fast = the wait line; a failure = the sorry line — none of them spends a token', async () => {
    const off = await waTurn(rig({ gate: { ok: false, reason: 'off' }, replies: [] }).deps, input);
    expect(off).toMatchObject({ reply: null, as: 'off' });
    const cap = await waTurn(rig({ gate: { ok: false, reason: 'cap_user' }, replies: [] }).deps, { ...input, text: 'بدي خبز' });
    expect(cap).toMatchObject({ as: 'paused', reply: 'المساعد متوقف مؤقتاً. يمكنك الطلب مباشرة من التطبيق: https://m.example' });
    const rate = await waTurn(rig({ gate: { ok: false, reason: 'rate' }, replies: [] }).deps, input);
    expect(rate.reply).toBe(WA_TEXT.rate.en);
    const err = await waTurn(rig({ replies: [] }).deps, input);
    expect(err).toMatchObject({ as: 'error', reply: 'Sorry, something went wrong. Try again, or order in the app: https://m.example' });
  });

  it('a draft that could not be stored is never linked', async () => {
    const r = await waTurn(rig({ saveFails: true, gate: { ok: true, first: false }, replies: [call('draft_basket', { lines: [{ product_id: P1, quantity: 1 }] }), say('ok')] }).deps, input);
    expect(r.draft_id).toBeNull(); expect(r.reply).not.toContain('/y/'); expect(r.reply).toContain('عذراً');
  });

  it('kinds, the text-only line, the merge and the summary on their own', () => {
    expect([waKind('text'), waKind('audio'), waKind('image'), waKind('sticker'), waKind('reaction'), waKind('interactive'), waKind('location')]).toEqual(['text', 'voice', 'unsupported', 'unsupported', 'silent', 'silent', 'silent']);
    expect(waTextOnly()).toContain('text messages only'); expect(waTextOnly()).toContain('الرسائل المكتوبة');
    expect(mergeSlim({ lines: [{ product_id: 'a', quantity: 1, note: 'x' }], choices: [], not_found: [] }, { lines: [{ product_id: 'a', quantity: 1 }], choices: [], not_found: [] }).lines).toHaveLength(2);   // a note makes it its own line
    const it = (id: string, s: string, usd: number, q: number) => ({ product_id: id, name: { ar: id }, unit: null, price_usd: usd, days: null, quantity: q, shop: { id: s, slug: s, name: { ar: s, en: s }, whatsapp: null, min_order_usd: 0, pickup_enabled: true } });
    expect(waSummary({ lines: [it('a', 's1', 1, 2), it('b', 's2', 2.5, 1)], choices: [], not_found: [] }, 'en', null)).toBe('2 shops · 2 items · $4.50');
    expect(waSummary({ lines: [], choices: [{ phrase: 'x', quantity: 1, options: [] }], not_found: [] }, 'arabizi', 90000)).toBe('1 للاختيار');
  });

  // ── voice notes (W2) ──
  const vin = { tenant: input.tenant, phone: input.phone, site: input.site };
  const ok = (text: string): HeardVoice => ({ status: 'ok', text, model: 'g-voice', cost_usd: 0.0012, audio_tokens: 640, text_tokens: 120, output_tokens: 30 });
  it('a voice note is heard, then handled as a typed message: what was heard comes first, and its cost sits on the customer\'s line', async () => {
    const { deps, admin, saved } = rig({ replies: [call('draft_basket', { lines: [{ product_id: P1, quantity: 2 }] }), say('جهّزت لك السلة.')] });
    const r = await waVoiceTurn({ ...deps, hear: async () => ok('بدي ربطتين خبز') }, vin);
    expect(r.as).toBe('yorgo'); expect(r.heard).toBe('بدي ربطتين خبز'); expect(saved).toHaveLength(1);
    expect(r.reply!.startsWith('🎤 سمعت: «بدي ربطتين خبز»\n\nجهّزت لك السلة.')).toBe(true);
    expect(admin.map(c => c[0])).toEqual(['yorgo_gate_wa', 'yorgo_gate_wa', 'yorgo_record_wa']);
    const first = (admin[2][1].p_messages as Record<string, unknown>[])[0];
    expect(first).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'بدي ربطتين خبز' }], model: 'g-voice', cost_usd: 0.0012, input_tokens: 760, output_tokens: 30 });
    expect(r.cost_usd).toBeGreaterThan(0.0012);
  });
  it('paused, over the cap or off: nothing is heard, nothing is spent', async () => {
    for (const [reason, as] of [['cap_user', 'paused'], ['rate', 'paused'], ['off', 'off']] as const) {
      let heard = 0; const { deps, admin } = rig({ gate: { ok: false, reason }, replies: [] });
      const r = await waVoiceTurn({ ...deps, hear: async () => { heard++; return ok('x'); } }, vin);
      expect(r.as).toBe(as); expect(heard).toBe(0); expect(admin.map(c => c[0])).toEqual(['yorgo_gate_wa']);
      if (reason === 'off') expect(r.reply).toBeNull(); else expect(r.reply).toContain(reason === 'rate' ? WA_TEXT.rate.en : 'https://m.example');
    }
  });
  it('too long: asked for a shorter one, in both languages, and no drafting', async () => {
    const { deps, admin } = rig({ replies: [] });
    const r = await waVoiceTurn({ ...deps, hear: async () => ({ status: 'too_long' }) }, vin);
    expect(r.as).toBe('voice_long'); expect(r.reply).toBe(`${WA_TEXT.voiceLong.ar}\n\n${WA_TEXT.voiceLong.en}`); expect(admin.map(c => c[0])).toEqual(['yorgo_gate_wa']);
  });
  it('silence or noise: said so, no drafting, and the transcription that was paid for is recorded', async () => {
    const { deps, admin } = rig({ gate: { ok: true, conversation_id: 'conv-0', first: false }, replies: [] });
    const r = await waVoiceTurn({ ...deps, hear: async () => ({ status: 'nothing', model: 'g-voice', cost_usd: 0.0004, audio_tokens: 300, text_tokens: 120, output_tokens: 4 }) }, vin);
    expect(r.as).toBe('voice_unclear'); expect(r.reply).toContain(WA_TEXT.voiceUnclear.ar);
    expect(admin.map(c => c[0])).toEqual(['yorgo_gate_wa', 'yorgo_record_wa']);
    expect(admin[1][1]).toMatchObject({ p_conversation: 'conv-0', p_phone: '+96170000001' });
    expect((admin[1][1].p_messages as Record<string, unknown>[])[0]).toMatchObject({ role: 'user', cost_usd: 0.0004, model: 'g-voice' });
  });
  it('the provider is down: the "text only" line, nothing recorded', async () => {
    const { deps, admin } = rig({ replies: [] });
    const r = await waVoiceTurn({ ...deps, hear: async () => { throw new Error('voice_http_503'); } }, vin);
    expect(r.as).toBe('voice_failed'); expect(r.reply).toBe(waTextOnly()); expect(r.error).toBe('voice_http_503'); expect(admin.map(c => c[0])).toEqual(['yorgo_gate_wa']);
  });
  it('what was heard is one line: a long note is shortened; English gets the English line', () => {
    expect(heardLine('two bread', 'en')).toBe('🎤 I heard: "two bread"');
    const long = heardLine('ا'.repeat(400), 'ar'); expect(long.length).toBeLessThan(220); expect(long).toContain('…');
  });
});
