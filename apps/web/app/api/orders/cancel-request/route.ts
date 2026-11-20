import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { pushToShop } from '@/lib/server/push';
import { waConfigured, waSendText } from '@/lib/server/whatsapp';
import { normalizePhone } from '@/lib/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The customer asks to cancel an order the shop already accepted (86_customer_close_cancel). The request is written as the customer
 * (his session — the database checks it is his order); then the shop is told at once: a notification on its devices and a WhatsApp
 * line to the shop's number. The shop answers in the POS (Talabat).
 */
export async function POST(req: Request) {
  const { order_id, reason } = (await req.json().catch(() => ({}))) as { order_id?: string; reason?: string };
  if (!order_id || !/^[0-9a-f-]{36}$/i.test(order_id)) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const sb = await supabaseServer();
  const { error } = await sb.rpc('customer_request_cancel', { p_order: order_id, p_reason: (reason ?? '').slice(0, 300) || null });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const admin = supabaseAdmin();
  const { data: o } = admin ? await admin.from('orders').select('number, shop_id, customer_name, shop:shops(whatsapp, phone)').eq('id', order_id).maybeSingle() : { data: null };
  if (o) {
    const line = `⚠️ الزبون ${o.customer_name ?? ''} يطلب إلغاء الطلب ${o.number}${reason?.trim() ? ` — ${reason.trim().slice(0, 200)}` : ''}. افتح الطلبات في نقطة البيع للقبول أو الرفض.`;
    await Promise.all([
      pushToShop(o.shop_id as string, { title: `⚠️ طلب إلغاء ${o.number}`, body: `${o.customer_name ?? ''}${reason?.trim() ? ' · ' + reason.trim().slice(0, 120) : ''}`, url: '/pos#orders', tag: `cancel-${order_id}` }).catch(() => null),
      (async () => { const shop = o.shop as unknown as { whatsapp?: string | null; phone?: string | null } | null; const n = normalizePhone(shop?.whatsapp || shop?.phone);
        if (n && waConfigured()) await waSendText(n, line).catch(() => null); })(),
    ]);
  }
  return NextResponse.json({ ok: true });
}
