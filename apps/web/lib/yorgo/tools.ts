// The fixed set of typed tools the model may call. No tool takes SQL or free filters; every tool runs with the CALLER'S OWN
// Supabase client, so row-level security decides what it can see — Yorgo never has more access than the person using it.
import { usdPrice } from '@/lib/price';
import { rateOf } from '@/lib/shop-money';
import type { ToolDef } from './model';

export type Mode = 'shopper' | 'seller';
export type Role = 'owner' | 'cashier' | 'stock' | 'setup';
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type From = (t: string) => any;
export type ToolCtx = { sb: { rpc: Rpc; from?: From }; tenantId: string; mode: Mode; shopId: string | null; role: Role | null; fx?: number | null; rates?: Record<string, number> | null };   // rates: each shop's own lira rate (103), over fx   // fx: the market's lira rate, for lira-priced items
export type Tool = ToolDef & { modes: Mode[]; roles?: Role[]; run(input: Record<string, unknown>, ctx: ToolCtx): Promise<unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const matchItems: Tool = {
  name: 'match_items',
  description: 'Find real catalog items for what the person called them. Pass each item\'s words WITHOUT the quantity (Arabic, Arabizi or English as written). '
    + 'A kind of item works too ("machroub", "may", "chokola", "dekhen", "drinks"): it returns items of that kind (matched_on "kind"); with a name ("machroub pepsi") the name decides. '
    + 'Returns up to 8 candidates per phrase (the best one of each shop first when no shop is given) with score (1 = exact name or alias), category, price and availability. This is the ONLY source of item names and prices.',
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
    const { data, error } = await ctx.sb.rpc('match_items', { p_tenant: ctx.tenantId, p_phrases: phrases, p_shop: shop, p_limit: shop ? 6 : 8 });      // the whole market: room for every shop that has it (96 puts each shop's best first)
    if (error) throw new Error(error.message);
    // the item's category (shared list, 87): tells food from seeds or tools with the same word. Read with the caller's own access.
    const rows = (data as { product_id: string }[] | null) ?? []; const cat = new Map<string, string>();
    if (rows.length && ctx.sb.from) {
      try {
        const q = await ctx.sb.from('products').select('id,section').in('id', [...new Set(rows.map(r => r.product_id))]) as { data?: { id: string; section: string | null }[] | null };
        for (const r of q?.data ?? []) if (r.section) cat.set(r.id, r.section);
      } catch { /* no category this time: the search result itself stands */ }
    }
    type Row = { phrase_no: number; matched_on?: string; product_id: string; shop_id: string; shop_name: Record<string, string>; name: Record<string, string>; unit: string | null; price_usd: number | string; price_currency: string; price_lbp: number; is_available: boolean; available_days: number[] | null; score: number };
    return phrases.map((phrase, i) => ({
      phrase,
      candidates: ((data as Row[] | null) ?? []).filter(r => r.phrase_no === i + 1).map(r => ({
        product_id: r.product_id, name_ar: r.name?.ar ?? null, name_en: r.name?.en ?? null, ...(cat.get(r.product_id) ? { category: cat.get(r.product_id) } : {}),
        ...(ctx.mode === 'shopper' ? { shop_id: r.shop_id, shop: r.shop_name?.ar ?? r.shop_name?.en ?? null } : {}),
        price_usd: Math.round(usdPrice(r, ctx.mode === 'shopper' ? rateOf(ctx.rates, r.shop_id, ctx.fx) : null) * 100) / 100, ...(r.price_currency === 'lbp' ? { price_lbp: Number(r.price_lbp) } : {}), unit: r.unit,
        available: r.is_available, ...(r.available_days?.length ? { only_on_weekdays: r.available_days } : {}), score: Math.round(r.score * 100) / 100, ...(r.matched_on === 'kind' ? { matched_on: 'kind' } : {}),
      })),
    }));
  },
};

// A draft is a proposal, nothing more: it carries item ids and quantities only. Names, prices and stock are filled in by the till from
// its own catalog, an id the till does not know is dropped there, and nothing is sold until a person confirms it in the cart.
export type OrderDraft = { lines: { product_id: string; quantity: number; note?: string }[]; choices: { phrase: string; quantity: number; options: string[]; note?: string }[]; not_found: string[]; add?: boolean };
const qty = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(999, Math.round(n * 1000) / 1000) : 1; };
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** the draft as the model gave it, cleaned: real ids only, sane quantities, bounded lists */
function runDraft(input: Record<string, unknown>, maxOptions: number): { draft: OrderDraft } {
    const lines = (Array.isArray(input.lines) ? input.lines : []).slice(0, 40).map(l => l as Record<string, unknown>)
      .filter(l => typeof l.product_id === 'string' && UUID.test(l.product_id))
      .map(l => ({ product_id: (l.product_id as string).toLowerCase(), quantity: qty(l.quantity), ...(str(l.note, 120) ? { note: str(l.note, 120) } : {}) }));
    const choices = (Array.isArray(input.choices) ? input.choices : []).slice(0, 20).map(c => c as Record<string, unknown>)
      .map(c => ({ phrase: str(c.phrase, 80), quantity: qty(c.quantity), options: [...new Set((Array.isArray(c.options) ? c.options : []).filter((o): o is string => typeof o === 'string' && UUID.test(o)).map(o => o.toLowerCase()))].slice(0, maxOptions), ...(str(c.note, 120) ? { note: str(c.note, 120) } : {}) }))
      .filter(c => c.phrase && c.options.length);
    const not_found = (Array.isArray(input.not_found) ? input.not_found : []).map(n => str(n, 80)).filter(Boolean).slice(0, 20);
    if (!lines.length && !choices.length && !not_found.length) throw new Error('empty_draft');
    return { draft: { lines, choices, not_found } };
}

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
        phrase: { type: 'string', maxLength: 80, description: 'The customer\'s own words for the item.' }, quantity: { type: 'number' }, note: { type: 'string', maxLength: 120, description: 'What the customer said about this item (sliced, cold, no onions…), so it is kept whichever option is picked.' }, options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' }, description: 'Candidate product_id values, best first.' } } } },
      not_found: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 } },
      add: { type: 'boolean', description: 'true = add these items to the draft already open on screen ("zid", "kamen", "add", "also"). Omit for a new order or to replace the draft.' },
    },
  },
  modes: ['seller'], roles: ['owner', 'cashier'],
  async run(input) {
    const { lines, choices, not_found } = runDraft(input, 4).draft; const add = input.add === true;
    return { ok: true, shown_to_staff: true, ...(add ? { added_to_open_draft: true } : {}), lines: lines.length, choices: choices.length, not_found: not_found.length, draft: { lines, choices, not_found, ...(add ? { add: true } : {}) } };
  },
};

// The shopper's version: same shape, but the storefront has no catalog on the device, so the draft is filled in here — with the
// caller's own client, i.e. exactly what the public catalog shows them. An id that is not on sale online is dropped.
type ShopOut = { id: string; slug: string; name: Record<string, string>; whatsapp: string | null; min_order_usd: number; pickup_enabled: boolean };
type ItemOut = { product_id: string; name: Record<string, string>; unit: string | null; price_usd: number; days: number[] | null; shop: ShopOut };
export type BasketDraft = { lines: (ItemOut & { quantity: number; note?: string })[]; choices: { phrase: string; quantity: number; options: ItemOut[]; note?: string }[]; not_found: string[]; add?: boolean };

const draftBasket: Tool = {
  name: 'draft_basket',
  description: 'Prepare a basket draft for the customer to check and add to their cart. Call it ONCE per request, after match_items, with every item they asked for: '
    + 'a sure match goes in "lines"; when two or more candidates could be meant (size, flavour, or the same item in different shops) put the phrase in "choices" with the candidate ids so the customer taps one; what was not found goes in "not_found". '
    + 'Use only product_id values returned by match_items. This does not order anything.',
  input_schema: { ...draftOrder.input_schema, properties: { ...(draftOrder.input_schema.properties as Record<string, unknown>),
    choices: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['phrase', 'options'], properties: {
      phrase: { type: 'string', maxLength: 80, description: 'The customer\'s own words for the item.' }, quantity: { type: 'number' }, note: { type: 'string', maxLength: 120, description: 'What the customer said about this item (sliced, cold, no onions…), so it is kept whichever option is picked.' }, options: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' }, description: 'Candidate product_id values, best first.' } } } },
  } },
  modes: ['shopper'],
  async run(input, ctx) {
    const base = runDraft(input, 6);
    const { lines, choices, not_found, soldOut } = await hydrateBasket(ctx, base.draft);
    const draft: BasketDraft = { lines, choices, not_found, ...(input.add === true ? { add: true } : {}) };
    return { ok: true, shown_to_customer: true, ...(soldOut.length ? { not_available_now: soldOut } : {}), ...(input.add === true ? { added_to_open_draft: true } : {}), lines: lines.length, choices: choices.length, not_found: not_found.length, shops: [...new Set(lines.map(l => l.shop.slug))].length, draft };
  },
};

/**
 * A draft held as ids (what the model returned, or what a WhatsApp draft link stores) → the basket the customer sees: names,
 * prices, shops and availability re-read from the catalog with the given client, so it is always today's price. An id that is not
 * on sale online is dropped; one that is sold out is said in not_found.
 */
export async function hydrateBasket(ctx: Pick<ToolCtx, 'sb' | 'tenantId' | 'fx' | 'rates'>, slim: Pick<OrderDraft, 'lines' | 'choices' | 'not_found'>): Promise<{ lines: BasketDraft['lines']; choices: BasketDraft['choices']; not_found: string[]; soldOut: string[] }> {
  const ids = [...new Set([...slim.lines.map(l => l.product_id), ...slim.choices.flatMap(c => c.options)])];
    const found = new Map<string, ItemOut>();
    const soldOut = new Map<string, string>();
    if (ids.length && ctx.sb.from) {
      const { data, error } = await ctx.sb.from('products')
        .select('id,name,unit,price_usd,price_currency,price_lbp,is_available,is_active,visible_online,available_days,shops!inner(id,tenant_id,slug,name,whatsapp,min_order_usd,pickup_enabled,status)').in('id', ids);
      if (error) throw new Error(String(error.message).slice(0, 100));
      type Row = { id: string; name: Record<string, string>; unit: string | null; price_usd: number | string; price_currency?: string | null; price_lbp?: number | string | null; is_available: boolean; is_active: boolean; visible_online: boolean | null; available_days: number[] | null;
        shops: { id: string; tenant_id: string; slug: string; name: Record<string, string>; whatsapp: string | null; min_order_usd: number | string | null; pickup_enabled: boolean | null; status: string } };
      for (const r of (data as Row[] | null) ?? []) {
        const sh = Array.isArray(r.shops) ? (r.shops as Row['shops'][])[0] : r.shops;
        if (!sh || sh.tenant_id !== ctx.tenantId || sh.status !== 'active' || !r.is_active || r.visible_online === false) continue;
        if (!r.is_available) { soldOut.set(r.id, r.name?.ar || r.name?.en || ''); continue; }      // on the menu, not available now: said on the card, never dropped silently
        found.set(r.id, { product_id: r.id, name: r.name, unit: r.unit, price_usd: usdPrice(r, rateOf(ctx.rates, sh.id, ctx.fx)), days: r.available_days?.length ? r.available_days : null,
          shop: { id: sh.id, slug: sh.slug, name: sh.name, whatsapp: sh.whatsapp, min_order_usd: Number(sh.min_order_usd ?? 0), pickup_enabled: sh.pickup_enabled !== false } });
      }
    }
    const not_found = [...slim.not_found];
    const out = (id: string) => { const n = soldOut.get(id); if (n && !not_found.includes(`${n} (غير متوفر الآن)`)) not_found.push(`${n} (غير متوفر الآن)`); };
    const lines = slim.lines.flatMap(l => { const it = found.get(l.product_id); if (!it) out(l.product_id); return it ? [{ ...it, quantity: l.quantity, ...(l.note ? { note: l.note } : {}) }] : []; });
    const choices: BasketDraft['choices'] = [];
    for (const c of slim.choices) {
      const options = c.options.map(o => found.get(o)).filter((o): o is ItemOut => !!o);
      const note = c.note ? { note: c.note } : {};                                    // what was said about the item stays with it, whichever option is picked
      if (options.length > 1) choices.push({ phrase: c.phrase, quantity: c.quantity, options, ...note });
      else if (options.length === 1) lines.push({ ...options[0], quantity: c.quantity, ...note });
      else not_found.push(c.phrase);
    }
    return { lines, choices, not_found, soldOut: [...soldOut.values()] };
}

/** the reverse: what is kept of a basket draft (ids, quantities, notes, the customer's own words) — no names, no prices */
export function slimBasket(d: Pick<BasketDraft, 'lines' | 'choices' | 'not_found'>): Pick<OrderDraft, 'lines' | 'choices' | 'not_found'> {
  return { lines: d.lines.map(l => ({ product_id: l.product_id, quantity: l.quantity, ...(l.note ? { note: l.note } : {}) })), choices: d.choices.map(c => ({ phrase: c.phrase, quantity: c.quantity, options: c.options.map(o => o.product_id), ...(c.note ? { note: c.note } : {}) })), not_found: [...d.not_found] };
}

// Takes the open draft off the screen ("remove the options", "start over"). A new draft_order / draft_basket replaces it anyway.
const clearDraft: Tool = {
  name: 'clear_draft',
  description: 'Remove the draft (basket or order, with its choices) that is open on the person\'s screen, when they ask to remove it or start over. '
    + 'To change a draft, call the draft tool again instead: the new draft replaces the old one.',
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
  modes: ['shopper', 'seller'], roles: ['owner', 'cashier'],
  async run() { return { ok: true, removed_from_screen: true, draft: { cleared: true } }; },
};

// ---- stock questions in the till (owner, stock keeper, cashier). Quantities only: no cost, no price history, no supplier. ----
type StockRow = { id: string; name: Record<string, string> | null; unit: string | null; on_hand: number | string | null; reserved?: number | string | null; track_stock?: boolean | null; is_active?: boolean | null };
const n3 = (v: unknown) => Math.round(Number(v ?? 0) * 1000) / 1000;

/** "How much do I have of X?" — the shop's own items that match, with what is on the shelf. */
const stockOf: Tool = {
  name: 'stock_of',
  description: 'How much the shop has of an item RIGHT NOW ("adde 3ande pepsi?", "kam labne ba2e?", "how much X do I have", "في عندي ...؟" with a quantity in mind). '
    + 'Pass each item\'s words as written. Returns the matching items of this shop with on_hand (what is on the shelf), held_for_orders (reserved by open online orders, when any), free (on_hand minus held) and the unit. '
    + 'tracked:false means the shop does not count that item, so there is no number. Quantities only; this tool knows nothing about cost, sales or suppliers.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['phrases'],
    properties: { phrases: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', maxLength: 80 }, description: 'One entry per item asked about, a kind works too ("machroub").' } },
  },
  modes: ['seller'], roles: ['owner', 'stock', 'cashier'],
  async run(input, ctx) {
    const phrases = Array.isArray(input.phrases) ? input.phrases.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).slice(0, 10).map(p => p.slice(0, 80)) : [];
    if (!phrases.length) throw new Error('phrases_required');
    if (!ctx.shopId || !ctx.sb.from) throw new Error('no_shop');
    const { data, error } = await ctx.sb.rpc('match_items', { p_tenant: ctx.tenantId, p_phrases: phrases, p_shop: ctx.shopId, p_limit: 8 });
    if (error) throw new Error(error.message);
    const rows = (data as { phrase_no: number; product_id: string; score: number; matched_on?: string }[] | null) ?? [];
    const ids = [...new Set(rows.map(r => r.product_id))];
    const stock = new Map<string, StockRow>();
    if (ids.length) {
      const q = await ctx.sb.from('products').select('id,name,unit,on_hand,reserved,track_stock,is_active').eq('shop_id', ctx.shopId).in('id', ids) as { data?: StockRow[] | null; error?: { message: string } | null };
      if (q.error) throw new Error(q.error.message);
      for (const r of q.data ?? []) stock.set(r.id, r);
    }
    return phrases.map((phrase, i) => ({
      phrase,
      items: rows.filter(r => r.phrase_no === i + 1 && stock.has(r.product_id)).map(r => { const p = stock.get(r.product_id)!; const held = n3(p.reserved);
        return { name_ar: p.name?.ar ?? null, name_en: p.name?.en ?? null, unit: p.unit, tracked: p.track_stock !== false,
          ...(p.track_stock !== false ? { on_hand: n3(p.on_hand), ...(held > 0 ? { held_for_orders: held, free: n3(Number(p.on_hand ?? 0) - held) } : {}) } : {}),
          score: Math.round(r.score * 100) / 100, ...(r.matched_on === 'kind' ? { matched_on: 'kind' } : {}) }; }),
    }));
  },
};

/** "Shou na2es?" / "what expires soon?" / "what is not selling?" — the shop's own watch lists (123, and 108 for the stale ones). */
const stockWatch: Tool = {
  name: 'stock_watch',
  description: 'What the shop should look at in its stock: "out" (nothing left), "low" (at or under the item\'s own minimum), "expiring" (expiry within expiry_days, default 30, or already past), '
    + '"stale" (listed but not sold for the shop\'s stale period; owner and stock keeper only). Ask only for the lists the person wants ("shou na2es" = out + low; "shou 5alas" = out). '
    + 'Each list has its total count and its first lines, most urgent first. Quantities and dates only: no cost, no sales figures, no supplier.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['lists'],
    properties: {
      lists: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: ['out', 'low', 'expiring', 'stale'] } },
      expiry_days: { type: 'integer', minimum: 1, maximum: 365, description: 'For "expiring": how many days ahead (default 30).' },
    },
  },
  modes: ['seller'], roles: ['owner', 'stock', 'cashier'],
  async run(input, ctx) {
    const want = new Set((Array.isArray(input.lists) ? input.lists : []).filter((x): x is string => typeof x === 'string'));
    if (!want.size) throw new Error('lists_required');
    if (!ctx.shopId) throw new Error('no_shop');
    const out: Record<string, unknown> = {}; const TOP = 25;
    type W = { id: string; name: Record<string, string> | null; unit: string | null; on_hand: number; min_stock?: number; expiry?: string; expired?: boolean };
    const slim = (r: W) => ({ name_ar: r.name?.ar ?? null, name_en: r.name?.en ?? null, unit: r.unit, on_hand: n3(r.on_hand), ...(r.min_stock != null ? { minimum: n3(r.min_stock) } : {}), ...(r.expiry ? { expiry: r.expiry, ...(r.expired ? { expired: true } : {}) } : {}) });
    if (want.has('out') || want.has('low') || want.has('expiring')) {
      const days = Number.isFinite(Number(input.expiry_days)) ? Math.min(365, Math.max(1, Math.round(Number(input.expiry_days)))) : 30;
      const { data, error } = await ctx.sb.rpc('pos_stock_watch', { p_shop: ctx.shopId, p_expiry_days: days });
      if (error) { if (/PGRST202|schema cache|pos_stock_watch/i.test(error.message)) return { unavailable: 'The stock lists are not switched on for this shop yet.' }; throw new Error(error.message); }
      const d = (data ?? {}) as { counts?: Record<string, number>; out?: W[]; low?: W[]; expiring?: W[]; expiry_days?: number };
      for (const k of ['out', 'low', 'expiring'] as const) if (want.has(k)) out[k] = { total: d.counts?.[k] ?? 0, shown: Math.min(TOP, (d[k] ?? []).length), items: (d[k] ?? []).slice(0, TOP).map(slim), ...(k === 'expiring' ? { within_days: d.expiry_days ?? days } : {}) };
    }
    if (want.has('stale')) {
      if (ctx.role !== 'owner' && ctx.role !== 'stock') out.stale = { not_for_this_role: true };
      else {
        const { data, error } = await ctx.sb.rpc('pos_report_stale', { p_shop: ctx.shopId, p_days: null });
        if (error) throw new Error(error.message);
        const d = (data ?? {}) as { days?: number; count?: number; rows?: { name: Record<string, string> | null; last_sold_at: string | null; on_hand: number | null; track_stock: boolean; visible_online: boolean; listed_empty: boolean }[] };
        out.stale = { not_sold_for_days: d.days ?? null, total: d.count ?? 0, shown: Math.min(TOP, (d.rows ?? []).length),
          items: (d.rows ?? []).slice(0, TOP).map(r => ({ name_ar: r.name?.ar ?? null, name_en: r.name?.en ?? null, last_sold: r.last_sold_at ? r.last_sold_at.slice(0, 10) : 'never', ...(r.track_stock ? { on_hand: n3(r.on_hand) } : {}), ...(r.listed_empty ? { on_site_with_no_stock: true } : {}) })) };
      }
    }
    return out;
  },
};

const ALL: Tool[] = [matchItems, draftOrder, draftBasket, clearDraft, stockOf, stockWatch];

/** The tools this person may use. The model is never shown a tool outside this list, and a call to one is refused. */
export function toolsFor(mode: Mode, role: Role | null): Tool[] {
  return ALL.filter(t => t.modes.includes(mode) && (mode !== 'seller' || (role != null && (!t.roles || t.roles.includes(role)))));
}
