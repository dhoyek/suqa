// The fixed set of typed tools the model may call. No tool takes SQL or free filters; every tool runs with the CALLER'S OWN
// Supabase client, so row-level security decides what it can see — Yorgo never has more access than the person using it.
import type { ToolDef } from './model';

export type Mode = 'shopper' | 'seller';
export type Role = 'owner' | 'cashier' | 'stock' | 'setup';
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
export type ToolCtx = { sb: { rpc: Rpc }; tenantId: string; mode: Mode; shopId: string | null; role: Role | null };
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

const ALL: Tool[] = [matchItems];

/** The tools this person may use. The model is never shown a tool outside this list, and a call to one is refused. */
export function toolsFor(mode: Mode, role: Role | null): Tool[] {
  return ALL.filter(t => t.modes.includes(mode) && (mode !== 'seller' || (role != null && (!t.roles || t.roles.includes(role)))));
}
