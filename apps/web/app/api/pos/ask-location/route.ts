import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { waConfigured, waSendText, waSendTemplate } from '@/lib/server/whatsapp';
import { normalizePhone } from '@/lib/whatsapp';
import { logWaMessage } from '@/lib/server/wa-log';

// POST { shop_id, phone, name?, order_id? } — asks a customer on WhatsApp to share their location pin.
// Signed-in shop member only (RLS proves membership by reading the shop). Template `location_request` when
// WHATSAPP_TEMPLATES=1, plain text otherwise. The reply (a WhatsApp location) is attached by the webhook.
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!waConfigured()) return NextResponse.json({ error: 'whatsapp_not_configured' }, { status: 503 });
  const { shop_id, phone, name = '', order_id = null } = await req.json().catch(() => ({}));
  const to = normalizePhone(String(phone ?? ''));
  if (!shop_id || !to) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const sb = await supabaseServer();
  const { data: shop } = await sb.from('shops').select('id, tenant_id, name').eq('id', shop_id).maybeSingle();
  if (!shop) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const { data: role } = await sb.rpc('pos_role', { p_shop: shop_id });
  if (!role) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const shopName = (shop.name as Record<string, string>)?.ar || (shop.name as Record<string, string>)?.en || '';
  const who = String(name || '').trim() || 'عميلنا العزيز';
  const text = `مرحباً ${who}، لتوصيل طلبكم من ${shopName} نرجو إرسال موقعكم على واتساب: اضغطوا على 📎 ثم «الموقع» وأرسلوا موقع البيت. شكراً.`;
  const admin = supabaseAdmin();
  let from: string | null = null;
  if (admin && order_id) { try { const r = await admin.rpc('wa_sender_for_order', { p_order: order_id }); from = (r.data as string | null) ?? null; } catch { from = null; } }
  let wamid: string | null = null; let error: string | null = null;
  try {
    if (process.env.WHATSAPP_TEMPLATES === '1') {
      try { wamid = (await waSendTemplate(to, 'location_request', 'ar', [{ type: 'body', parameters: [who, shopName].map(t => ({ type: 'text', text: String(t).slice(0, 200) })) }], from)).messages?.[0]?.id ?? null; }
      catch (e) { console.warn('[ask-location] template failed, falling back to text', (e as Error).message); wamid = (await waSendText(to, text, from)).messages?.[0]?.id ?? null; }
    } else wamid = (await waSendText(to, text, from)).messages?.[0]?.id ?? null;
  } catch (e) { error = (e as Error).message; }
  if (wamid) await logWaMessage({ wamid, order_id, tenant_id: shop.tenant_id, direction: 'out', party: 'customer', phone: to, phone_number_id: from, body: text });
  if (error) return NextResponse.json({ error }, { status: 502 });
  return NextResponse.json({ ok: true, wamid });
}
