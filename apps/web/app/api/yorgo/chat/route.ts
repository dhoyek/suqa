import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { getTenant } from '@/lib/tenant';
import { getShopRates } from '@/lib/public-data';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { anthropicClient } from '@/lib/yorgo/model';
import { yorgoConfig } from '@/lib/yorgo/config';
import { runTurn, type HeardVoice } from '@/lib/yorgo/core';
import { loadRoute, ROUTE_COLUMNS } from '@/lib/ai/routes';
import { googleKey } from '@/lib/ai/google';
import { runVoice, VOICE_MAX_BYTES } from '@/lib/ai/voice';
import type { Mode, Role } from '@/lib/yorgo/tools';
import type { ShopHint } from '@/lib/yorgo/prompts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST { mode: 'shopper' | 'seller', shop_id?, conversation_id?, message } — one exchange with Yorgo, as the signed-in person.
// Everything the assistant reads goes through the caller's own Supabase client; the service role is used for the switches, caps and
// metering only (suqa.yorgo_gate / yorgo_record). Off until an association turns it on (suqa.yorgo_settings) and a key is configured.
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // a voice message from the app arrives as a form (the recording + the same fields); a typed one as JSON
  type Body = { mode?: string; shop_id?: string; shop_slug?: string; conversation_id?: string; message?: string; card?: string };
  let body: Body; let clip: Blob | null = null;
  if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    const form = await req.formData().catch(() => null);
    const f = (k: string) => { const v = form?.get(k); return typeof v === 'string' && v ? v : undefined; };
    body = { mode: f('mode'), shop_id: f('shop_id'), shop_slug: f('shop_slug'), conversation_id: f('conversation_id'), card: f('card'), message: '' };
    const a = form?.get('audio'); clip = a instanceof Blob && a.size > 0 ? a : null;
    if (!clip) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  } else body = await req.json().catch(() => ({})) as Body;
  const mode = body.mode === 'seller' ? 'seller' : body.mode === 'shopper' ? 'shopper' : null as Mode | null;
  if (!mode || typeof body.message !== 'string') return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const admin = supabaseAdmin(); const model = anthropicClient();
  if (!admin || !model) return NextResponse.json({ status: 'paused', reason: 'off' });        // not configured = off, never an error on screen

  const [tenant, sb] = await Promise.all([getTenant(), supabaseServer()]);
  let role: Role | null = null; let shopName: string | null = null; const shopId = mode === 'seller' ? (body.shop_id ?? null) : null;
  if (mode === 'seller') {
    if (!shopId) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    const [{ data: r }, { data: shop }] = await Promise.all([sb.rpc('pos_role', { p_shop: shopId }), sb.from('shops').select('name,tenant_id').eq('id', shopId).maybeSingle()]);
    if (!r || !shop || shop.tenant_id !== tenant.id) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    role = r as Role; shopName = (shop.name as { ar?: string; en?: string })?.ar ?? (shop.name as { en?: string })?.en ?? null;
  }

  // a shopper on a shop's page: tell the model which shop, nothing more (the search itself stays the public catalog)
  let focusShop: { id: string; name: string } | null = null;
  if (mode === 'shopper' && typeof body.shop_slug === 'string' && /^[\w-]{1,80}$/.test(body.shop_slug)) {
    const { data: fs } = await sb.from('shops').select('id,name').eq('tenant_id', tenant.id).eq('slug', body.shop_slug).eq('status', 'active').maybeSingle();
    if (fs) focusShop = { id: fs.id as string, name: (fs.name as { ar?: string; en?: string })?.ar ?? (fs.name as { en?: string })?.en ?? '' };
  }

  // the open shops, as the customer may call them (names + "known as"): public data, read with the caller's own access
  let shops: ShopHint[] = [];
  if (mode === 'shopper') {
    const { data: sh } = await sb.from('shops').select('id,name,known_as,known_as_en,description').eq('tenant_id', tenant.id).eq('status', 'active').order('sort_order', { ascending: true }).limit(60);
    type S = { id: string; name: { ar?: string; en?: string } | null; known_as: string | null; known_as_en: string | null; description: { ar?: string; en?: string } | null };
    shops = ((sh as S[] | null) ?? []).map(x => ({ id: x.id, name_ar: x.name?.ar ?? null, name_en: x.name?.en ?? null, known_as: x.known_as, known_as_en: x.known_as_en, about: x.description?.en || x.description?.ar || null }));
  }

  // voice: heard only when the platform switched the 'voice' route on and its key is there (script 100). The recording is read
  // in memory, sent to be written down after the caps are checked, and dropped: it is never stored.
  let hear: (() => Promise<HeardVoice>) | undefined;
  if (clip) {
    const route = await loadRoute('voice', async t => (await admin.from('yorgo_ai_routes').select(ROUTE_COLUMNS).eq('task', t).maybeSingle()).data as Record<string, unknown> | null);
    const key = googleKey();
    if (!route?.enabled || !key) return NextResponse.json({ status: 'voice', reason: 'off' });
    const audio = clip;
    hear = async () => {
      if (audio.size > VOICE_MAX_BYTES) return { status: 'too_long' };
      const h = await runVoice(route, key, new Uint8Array(await audio.arrayBuffer()), audio.type || 'audio/webm');
      if ('fallback_from' in h && h.fallback_from) console.warn('[yorgo voice] fallback —', h.fallback_from);
      return h;
    };
  }

  const result = await runTurn(
    { model, cfg: yorgoConfig(), admin: { rpc: (fn, args) => admin.rpc(fn, args) }, sb: { rpc: (fn, args) => sb.rpc(fn, args), from: t => sb.from(t) as never } },
    { tenant: { id: tenant.id, brand: tenant.brand_name, fx_lbp_rate: tenant.fx_lbp_rate }, rates: mode === 'shopper' ? await getShopRates(tenant.id).catch(() => ({})) : null, userId: user.id, mode, channel: mode === 'seller' ? 'pos' : 'app', shopId, shopName, role, conversationId: body.conversation_id ?? null, message: body.message, hear, focusShop, shops, card: body.card === 'open' || body.card === 'added' || body.card === 'discarded' ? body.card : null },
  );
  if (result.status !== 'ok') return NextResponse.json(result, { status: result.status === 'error' && result.error === 'not_staff' ? 403 : 200 });

  // for 👍 / 👎: the id of the answer just stored (the person's own conversation; the switch-keeping client reads one number)
  const { data: last } = await admin.from('yorgo_messages').select('id').eq('conversation_id', result.conversation_id).eq('role', 'assistant').order('id', { ascending: false }).limit(1).maybeSingle();
  // what was asked for and not found, as a counted phrase only (script 78; quietly skipped where it is not installed)
  // (a draft's not_found, and what the search itself came back empty for — also when the answer was only text)
  const missed = [...new Map([...(result.drafts as { not_found?: string[] }[]).flatMap(d => d.not_found ?? []), ...result.missed].map(m => [m.trim().toLowerCase(), m.trim()])).values()].filter(m => m && !m.endsWith('(غير متوفر الآن)')).slice(0, 20);      // (sold out is not a miss)
  if (missed.length) await admin.rpc('yorgo_miss', { p_tenant: tenant.id, p_shop: mode === 'seller' ? shopId : focusShop?.id ?? null, p_phrases: missed }).then(() => null, () => null);
  const { missed: _m, ...out } = result; void _m;
  return NextResponse.json({ ...out, message_id: (last?.id as number | undefined) ?? null });
}
