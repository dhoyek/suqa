import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { anthropicClient } from '@/lib/yorgo/model';
import { yorgoConfig } from '@/lib/yorgo/config';
import { runTurn } from '@/lib/yorgo/core';
import type { Mode, Role } from '@/lib/yorgo/tools';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST { mode: 'shopper' | 'seller', shop_id?, conversation_id?, message } — one exchange with Yorgo, as the signed-in person.
// Everything the assistant reads goes through the caller's own Supabase client; the service role is used for the switches, caps and
// metering only (suqa.yorgo_gate / yorgo_record). Off until an association turns it on (suqa.yorgo_settings) and a key is configured.
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { mode?: string; shop_id?: string; shop_slug?: string; conversation_id?: string; message?: string };
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

  const result = await runTurn(
    { model, cfg: yorgoConfig(), admin: { rpc: (fn, args) => admin.rpc(fn, args) }, sb: { rpc: (fn, args) => sb.rpc(fn, args), from: t => sb.from(t) as never } },
    { tenant: { id: tenant.id, brand: tenant.brand_name, fx_lbp_rate: tenant.fx_lbp_rate }, userId: user.id, mode, channel: mode === 'seller' ? 'pos' : 'app', shopId, shopName, role, conversationId: body.conversation_id ?? null, message: body.message, focusShop },
  );
  if (result.status !== 'ok') return NextResponse.json(result, { status: result.status === 'error' && result.error === 'not_staff' ? 403 : 200 });

  // for 👍 / 👎: the id of the answer just stored (the person's own conversation; the switch-keeping client reads one number)
  const { data: last } = await admin.from('yorgo_messages').select('id').eq('conversation_id', result.conversation_id).eq('role', 'assistant').order('id', { ascending: false }).limit(1).maybeSingle();
  // what was asked for and not found, as a counted phrase only (script 78; quietly skipped where it is not installed)
  const missed = (result.drafts as { not_found?: string[] }[]).flatMap(d => d.not_found ?? []);
  if (missed.length) await admin.rpc('yorgo_miss', { p_tenant: tenant.id, p_shop: mode === 'seller' ? shopId : focusShop?.id ?? null, p_phrases: missed }).then(() => null, () => null);
  return NextResponse.json({ ...result, message_id: (last?.id as number | undefined) ?? null });
}
