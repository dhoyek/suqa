// The fixed set of typed tools the model may call. No tool takes SQL or free filters; every tool runs with the CALLER'S OWN
// Supabase client, so row-level security decides what it can see — Yorgo never has more access than the person using it.
import type { ToolDef } from './model';

export type Mode = 'shopper' | 'seller';
export type Role = 'owner' | 'cashier' | 'stock' | 'setup';
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type From = (t: string) => any;
export type ToolCtx = { sb: { rpc: Rpc; from?: From }; tenantId: string; mode: Mode; shopId: string | null; role: Role | null };
export type Tool = ToolDef & { modes: Mode[]; roles?: Role[]; run(input: Record<string, unknown>, ctx: ToolCtx): Promise<unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const matchItems: Tool = {
  name: 'match_items',
  description: 'Find real catalog items for what the person called them. Pass each item\'s words WITHOUT the quantity (Arabic, Arabizi or English as written). '
    + 'Returns up to 4 candidates per phrase with score (1 = exact name or alias), price and availability. This is the ONLY source of item names and prices.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['phrases'],
    properties: {
      phrases: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 80 }, description: 'One entry per item the person mentioned.' },
      shop_id: { type: 'string', description: 'Shopper mode only: limit the search to one shop. Omit to search every shop.' },
    },
  },
  modes: ['shopper', 'seller'],
  async run(input, ctx) {
    const phrases = Array.isArray(input.phrases) ? input.phrases.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).slice(0, 20).map(p => p.slice(0, 80)) : [];
    if (!phrases.length) throw new Error('phrases_required');
    // a seller only ever searches their own shop, whatever the model asks for
    const shop = ctx.mode === 'seller' ? ctx.shopId : (typeof input.shop_id === 'string' && UUID.test(input.shop_id) ? input.shop_id : null);
    const { data, error } = await ctx.sb.rpc('match_items', { p_tenant: ctx.tenantId, p_phrases: phrases, p_shop: shop, p_limit: 4 });
    if (error) throw new Error(error.message);
    type Row = { phrase_no: number; product_id: string; shop_id: string; shop_name: Record<string, string>; name: Record<string, string>; unit: string | null; price_usd: number | string; price_currency: string; price_lbp: number; is_available: boolean; available_days: number[] | null; score: number };
    return phrases.map((phrase, i) => ({
      phrase,
      candidates: ((data as Row[] | null) ?? []).filter(r => r.phrase_no === i + 1).map(r => ({
        product_id: r.product_id, name_ar: r.name?.ar ?? null, name_en: r.name?.en ?? null,
        ...(ctx.mode === 'shopper' ? { shop_id: r.shop_id, shop: r.shop_name?.ar ?? r.shop_name?.en ?? null } : {}),
        price_usd: Number(r.price_usd), ...(r.price_currency === 'lbp' ? { price_lbp: Number(r.price_lbp) } : {}), unit: r.unit,
        available: r.is_available, ...(r.available_days?.length ? { only_on_weekdays: r.available_days } : {}), score: Math.round(r.score * 100) / 100,
      })),
    }));
  },
};

// A draft is a proposal, nothing more: it carries item ids and quantities only. Names, prices and stock are filled in by the till from
// its own catalog, an id the till does not know is dropped there, and nothing is sold until a person confirms it in the cart.
export type OrderDraft = { lines: { product_id: string; quantity: number; note?: string }[]; choices: { phrase: string; quantity: number; options: string[] }[]; not_found: string[] };
const qty = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(999, Math.round(n * 1000) / 1000) : 1; };
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const draftOrder: Tool = {
  name: 'draft_order',
  description: 'Prepare a draft order for the staff member to check and confirm in the cart. Call it ONCE per customer message, after match_items, with every item the customer asked for: '
    + 'a sure match goes in "lines"; when two or more candidates could be meant, put the phrase in "choices" with the candidate ids (the staff member taps the right one); what was not found goes in "not_found". '
    + 'Use only product_id values returned by match_items. This does not sell anything.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      lines: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['product_id', 'quantity'], properties: {
        product_id: { type: 'string' }, quantity: { type: 'number', description: 'As the customer asked; 1 when not said.' }, note: { type: 'string', maxLength: 120, description: 'Only what the customer said about this item (sliced, cold…).' } } } },
      choices: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['phrase', 'options'], properties: {
        phrase: { type: 'string', maxLength: 80, description: 'The customer\'s own words for the item.' }, quantity: { type: 'number' }, options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' }, description: 'Candidate product_id values, best first.' } } } },
      not_found: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 } },
    },
  },
  modes: ['seller'], roles: ['owner', 'cashier'],
  async run(input) {
    const lines = (Array.isArray(input.lines) ? input.lines : []).slice(0, 40).map(l => l as Record<string, unknown>)
      .filter(l => typeof l.product_id === 'string' && UUID.test(l.product_id))
      .map(l => ({ product_id: (l.product_id as string).toLowerCase(), quantity: qty(l.quantity), ...(str(l.note, 120) ? { note: str(l.note, 120) } : {}) }));
    const choices = (Array.isArray(input.choices) ? input.choices : []).slice(0, 20).map(c => c as Record<string, unknown>)
      .map(c => ({ phrase: str(c.phrase, 80), quantity: qty(c.quantity), options: [...new Set((Array.isArray(c.options) ? c.options : []).filter((o): o is string => typeof o === 'string' && UUID.test(o)).map(o => o.toLowerCase()))].slice(0, 4) }))
      .filter(c => c.phrase && c.options.length);
    const not_found = (Array.isArray(input.not_found) ? input.not_found : []).map(n => str(n, 80)).filter(Boolean).slice(0, 20);
    if (!lines.length && !choices.length && !not_found.length) throw new Error('empty_draft');
    const draft: OrderDraft = { lines, choices, not_found };
    return { ok: true, shown_to_staff: true, lines: lines.length, choices: choices.length, not_found: not_found.length, draft };
  },
};

// The shopper's version: same shape, but the storefront has no catalog on the device, so the draft is filled in here — with the
// caller's own client, i.e. exactly what the public catalog shows them. An id that is not on sale online is dropped.
type ShopOut = { id: string; slug: string; name: Record<string, string>; whatsapp: string | null; min_order_usd: number; pickup_enabled: boolean };
type ItemOut = { product_id: string; name: Record<string, string>; unit: string | null; price_usd: number; days: number[] | null; shop: ShopOut };
export type BasketDraft = { lines: (ItemOut & { quantity: number; note?: string })[]; choices: { phrase: string; quantity: number; options: ItemOut[] }[]; not_found: string[] };

const draftBasket: Tool = {
  name: 'draft_basket',
  description: 'Prepare a basket draft for the customer to check and add to their cart. Call it ONCE per request, after match_items, with every item they asked for: '
    + 'a sure match goes in "lines"; when two or more candidates could be meant (size, flavour, or the same item in different shops) put the phrase in "choices" with the candidate ids so the customer taps one; what was not found goes in "not_found". '
    + 'Use only product_id values returned by match_items. This does not order anything.',
  input_schema: draftOrder.input_schema,
  modes: ['shopper'],
  async run(input, ctx) {
    const base = await draftOrder.run(input, ctx) as { draft: OrderDraft };
    const ids = [...new Set([...base.draft.lines.map(l => l.product_id), ...base.draft.choices.flatMap(c => c.options)])];
    const found = new Map<string, ItemOut>();
    if (ids.length && ctx.sb.from) {
      const { data, error } = await ctx.sb.from('products')
        .select('id,name,unit,price_usd,is_available,is_active,visible_online,available_days,shops!inner(id,tenant_id,slug,name,whatsapp,min_order_usd,pickup_enabled,status)').in('id', ids);
      if (error) throw new Error(String(error.message).slice(0, 100));
      type Row = { id: string; name: Record<string, string>; unit: string | null; price_usd: number | string; is_available: boolean; is_active: boolean; visible_online: boolean | null; available_days: number[] | null;
        shops: { id: string; tenant_id: string; slug: string; name: Record<string, string>; whatsapp: string | null; min_order_usd: number | string | null; pickup_enabled: boolean | null; status: string } };
      for (const r of (data as Row[] | null) ?? []) {
        const sh = Array.isArray(r.shops) ? (r.shops as Row['shops'][])[0] : r.shops;
        if (!sh || sh.tenant_id !== ctx.tenantId || sh.status !== 'active' || !r.is_active || !r.is_available || r.visible_online === false) continue;
        found.set(r.id, { product_id: r.id, name: r.name, unit: r.unit, price_usd: Number(r.price_usd), days: r.available_days?.length ? r.available_days : null,
          shop: { id: sh.id, slug: sh.slug, name: sh.name, whatsapp: sh.whatsapp, min_order_usd: Number(sh.min_order_usd ?? 0), pickup_enabled: sh.pickup_enabled !== false } });
      }
    }
    const not_found = [...base.draft.not_found];
    const lines = base.draft.lines.flatMap(l => { const it = found.get(l.product_id); return it ? [{ ...it, quantity: l.quantity, ...(l.note ? { note: l.note } : {}) }] : []; });
    const choices: BasketDraft['choices'] = [];
    for (const c of base.draft.choices) {
      const options = c.options.map(o => found.get(o)).filter((o): o is ItemOut => !!o);
      if (options.length > 1) choices.push({ phrase: c.phrase, quantity: c.quantity, options });
      else if (options.length === 1) lines.push({ ...options[0], quantity: c.quantity });
      else not_found.push(c.phrase);
    }
    const draft: BasketDraft = { lines, choices, not_found };
    return { ok: true, shown_to_customer: true, lines: lines.length, choices: choices.length, not_found: not_found.length, shops: [...new Set(lines.map(l => l.shop.slug))].length, draft };
  },
};

const ALL: Tool[] = [matchItems, draftOrder, draftBasket];

/** The tools this person may use. The model is never shown a tool outside this list, and a call to one is refused. */
export function toolsFor(mode: Mode, role: Role | null): Tool[] {
  return ALL.filter(t => t.modes.includes(mode) && (mode !== 'seller' || (role != null && (!t.roles || t.roles.includes(role)))));
}
