import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { loadRoute, ROUTE_COLUMNS } from '@/lib/ai/routes';
import { googleKey } from '@/lib/ai/google';
import { CLEAN_MAX_BYTES, runImageCleanup } from '@/lib/ai/clean';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST (form: shop_id, image) — the item editor's "remove background": ONE item photo → the same item on a clean white
// background, returned as the picture itself (image/jpeg). The person sees it next to the original and chooses; nothing is
// stored or written here — the chosen picture is uploaded by the editor like any item photo.
// Same switches and caps as Yorgo in the till (yorgo_gate, seller mode); the cost is recorded on the shop's Yorgo usage.
// Anything that is not a picture comes back as JSON { status: 'photo', reason }.
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let form: FormData; try { form = await req.formData(); } catch { return NextResponse.json({ error: 'bad_request' }, { status: 400 }); }
  const shopId = String(form.get('shop_id') ?? ''); const file = form.get('image');
  if (!/^[0-9a-f-]{36}$/i.test(shopId) || !(file instanceof Blob) || !/^image\/(jpeg|png|webp)$/.test(file.type)) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  if (file.size > CLEAN_MAX_BYTES) return NextResponse.json({ status: 'photo', reason: 'too_big' });

  const admin = supabaseAdmin(); const key = googleKey();
  if (!admin) return NextResponse.json({ status: 'photo', reason: 'off' });
  const [tenant, sb] = await Promise.all([getTenant(), supabaseServer()]);
  const [{ data: role }, { data: shop }] = await Promise.all([sb.rpc('pos_role', { p_shop: shopId }), sb.from('shops').select('tenant_id').eq('id', shopId).maybeSingle()]);
  if (!role || !shop || shop.tenant_id !== tenant.id) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const route = await loadRoute('image_cleanup', async t => (await admin.from('yorgo_ai_routes').select(ROUTE_COLUMNS).eq('task', t).maybeSingle()).data as Record<string, unknown> | null);
  if (!route?.enabled || !key) return NextResponse.json({ status: 'photo', reason: 'off' });

  const gate = await admin.rpc('yorgo_gate', { p_tenant: tenant.id, p_user: user.id, p_mode: 'seller', p_shop: shopId });
  const g = (gate.data ?? {}) as { ok?: boolean; reason?: string };
  if (gate.error) return NextResponse.json({ status: 'photo', reason: 'failed' });
  if (!g.ok) return NextResponse.json({ status: 'photo', reason: g.reason === 'rate' ? 'rate' : g.reason === 'off' ? 'off' : 'cap' });

  const r = await runImageCleanup(route, key, new Uint8Array(await file.arrayBuffer()), file.type);
  if (r.status === 'too_big') return NextResponse.json({ status: 'photo', reason: 'too_big' });
  if (r.status === 'failed') { console.error('[item-photo-clean]', r.error); return NextResponse.json({ status: 'photo', reason: 'failed' }); }
  // paid for, so counted — whichever picture the person keeps
  const line = [{ role: 'user', content: [{ type: 'text', text: '🖼 (item photo cleaned)' }], model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: r.cost_usd }];
  await admin.rpc('yorgo_record', { p_conversation: null, p_tenant: tenant.id, p_user: user.id, p_mode: 'seller', p_shop: shopId, p_channel: 'pos', p_messages: line, p_summary: null }).then(() => null, () => null);
  return new NextResponse(Buffer.from(r.image), { status: 200, headers: { 'content-type': r.mime.includes('png') ? 'image/png' : 'image/jpeg', 'cache-control': 'no-store' } });
}
