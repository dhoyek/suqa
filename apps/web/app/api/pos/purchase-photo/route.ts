import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { loadRoute, ROUTE_COLUMNS } from '@/lib/ai/routes';
import { googleKey } from '@/lib/ai/google';
import { PHOTO_MAX_BYTES } from '@/lib/ai/photo';
import { runInvoicePhoto } from '@/lib/ai/invoice';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST (form: shop_id, image) — the purchase screen's "from a photo of the invoice".
// The shop's owner or stock keeper sends ONE photo of a supplier's invoice; the answer is the invoice as data (supplier name,
// number, date, currency, lines). The till matches the lines to the shop's own items and the person checks and posts the
// purchase themselves: NOTHING is written here — no purchase, no stock, no cost, no supplier. The photo is not stored.
// Same switch and caps as the other photo tools (yorgo_gate_tools, 106); what the reading cost is recorded on the person's Yorgo usage.
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let form: FormData; try { form = await req.formData(); } catch { return NextResponse.json({ error: 'bad_request' }, { status: 400 }); }
  const shopId = String(form.get('shop_id') ?? ''); const file = form.get('image');
  if (!/^[0-9a-f-]{36}$/i.test(shopId) || !(file instanceof Blob) || !/^image\/(jpeg|png|webp)$/.test(file.type)) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  if (file.size > PHOTO_MAX_BYTES) return NextResponse.json({ status: 'photo', reason: 'too_big' });

  const admin = supabaseAdmin(); const key = googleKey();
  if (!admin) return NextResponse.json({ status: 'photo', reason: 'off' });
  const [tenant, sb] = await Promise.all([getTenant(), supabaseServer()]);
  const [{ data: role }, { data: shop }] = await Promise.all([sb.rpc('pos_role', { p_shop: shopId }), sb.from('shops').select('tenant_id').eq('id', shopId).maybeSingle()]);
  // purchases carry costs: the shop's owner and stock keeper only — not a cashier, not the association
  if ((role !== 'owner' && role !== 'stock') || !shop || shop.tenant_id !== tenant.id) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const route = await loadRoute('photo_read', async t => (await admin.from('yorgo_ai_routes').select(ROUTE_COLUMNS).eq('task', t).maybeSingle()).data as Record<string, unknown> | null);
  if (!route?.enabled || !key) return NextResponse.json({ status: 'photo', reason: 'off' });

  let gate = await admin.rpc('yorgo_gate_tools', { p_tenant: tenant.id, p_user: user.id, p_shop: shopId });
  if (gate.error) gate = await admin.rpc('yorgo_gate', { p_tenant: tenant.id, p_user: user.id, p_mode: 'seller', p_shop: shopId });
  const g = (gate.data ?? {}) as { ok?: boolean; reason?: string };
  if (gate.error) return NextResponse.json({ status: 'photo', reason: 'failed' });
  if (!g.ok) return NextResponse.json({ status: 'photo', reason: g.reason === 'rate' ? 'rate' : g.reason === 'off' ? 'off' : 'cap' });

  const r = await runInvoicePhoto(route, key, new Uint8Array(await file.arrayBuffer()), file.type);
  if (r.status === 'too_big') return NextResponse.json({ status: 'photo', reason: 'too_big' });
  if (r.status === 'failed') { console.error('[purchase-photo]', r.error); return NextResponse.json({ status: 'photo', reason: 'failed' }); }
  const line = [{ role: 'user', content: [{ type: 'text', text: '📷 (supplier invoice read)' }], model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: r.cost_usd }];
  await admin.rpc('yorgo_record', { p_conversation: null, p_tenant: tenant.id, p_user: user.id, p_mode: 'seller', p_shop: shopId, p_channel: 'pos', p_messages: line, p_summary: null }).then(() => null, () => null);
  if (r.status === 'nothing') return NextResponse.json({ status: 'photo', reason: 'nothing' });
  return NextResponse.json({ status: 'ok', invoice: r.invoice });
}
