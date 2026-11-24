import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { loadRoute, ROUTE_COLUMNS } from '@/lib/ai/routes';
import { googleKey } from '@/lib/ai/google';
import { PHOTO_MAX_BYTES, runItemPhoto } from '@/lib/ai/photo';

export const dynamic = 'force-dynamic';

// POST (form: shop_id, image, categories = JSON array of category names) — the item editor's "fill from a photo".
// A staff member of the shop sends ONE photo of an item; the answer is a SUGGESTED card (names, description, category, barcode)
// that the person checks and saves in the editor. Nothing is written to the catalog here.
// The same switches and caps as Yorgo in the till (yorgo_gate, seller mode): a shop over its cap, or with Yorgo off, gets "off".
// What the reading cost is recorded on the staff member's Yorgo usage, so the caps count it. The picture is not stored.
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let form: FormData; try { form = await req.formData(); } catch { return NextResponse.json({ error: 'bad_request' }, { status: 400 }); }
  const shopId = String(form.get('shop_id') ?? ''); const file = form.get('image');
  if (!/^[0-9a-f-]{36}$/i.test(shopId) || !(file instanceof Blob) || !/^image\/(jpeg|png|webp)$/.test(file.type)) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  if (file.size > PHOTO_MAX_BYTES) return NextResponse.json({ status: 'photo', reason: 'too_big' });
  let categories: string[] = [];
  try { const c = JSON.parse(String(form.get('categories') ?? '[]')); if (Array.isArray(c)) categories = c.filter((x): x is string => typeof x === 'string').slice(0, 150); } catch { /* none */ }

  const admin = supabaseAdmin(); const key = googleKey();
  if (!admin) return NextResponse.json({ status: 'photo', reason: 'off' });
  const [tenant, sb] = await Promise.all([getTenant(), supabaseServer()]);
  const [{ data: role }, { data: shop }] = await Promise.all([sb.rpc('pos_role', { p_shop: shopId }), sb.from('shops').select('tenant_id').eq('id', shopId).maybeSingle()]);
  if (!role || !shop || shop.tenant_id !== tenant.id) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const route = await loadRoute('photo_read', async t => (await admin.from('yorgo_ai_routes').select(ROUTE_COLUMNS).eq('task', t).maybeSingle()).data as Record<string, unknown> | null);
  if (!route?.enabled || !key) return NextResponse.json({ status: 'photo', reason: 'off' });      // not set up = off, never an error on screen

  // the shop's Yorgo switch and caps decide, before anything is spent
  const gate = await admin.rpc('yorgo_gate', { p_tenant: tenant.id, p_user: user.id, p_mode: 'seller', p_shop: shopId });
  const g = (gate.data ?? {}) as { ok?: boolean; reason?: string };
  if (gate.error) return NextResponse.json({ status: 'photo', reason: 'failed' });
  if (!g.ok) return NextResponse.json({ status: 'photo', reason: g.reason === 'rate' ? 'rate' : g.reason === 'off' ? 'off' : 'cap' });

  const r = await runItemPhoto(route, key, new Uint8Array(await file.arrayBuffer()), file.type, categories);
  if (r.status === 'too_big') return NextResponse.json({ status: 'photo', reason: 'too_big' });
  if (r.status === 'failed') { console.error('[item-photo]', r.error); return NextResponse.json({ status: 'photo', reason: 'failed' }); }
  // paid for, so counted: one line in a conversation of its own (no picture, no names — only that a photo was read)
  const line = [{ role: 'user', content: [{ type: 'text', text: '📷 (item photo read)' }], model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: r.cost_usd }];
  await admin.rpc('yorgo_record', { p_conversation: null, p_tenant: tenant.id, p_user: user.id, p_mode: 'seller', p_shop: shopId, p_channel: 'pos', p_messages: line, p_summary: null }).then(() => null, () => null);
  if (r.status === 'nothing') return NextResponse.json({ status: 'photo', reason: 'nothing' });
  return NextResponse.json({ status: 'ok', card: r.card });
}
