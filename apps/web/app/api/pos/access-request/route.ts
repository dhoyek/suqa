import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { waConfigured, waSendText } from '@/lib/server/whatsapp';
import { normalizePhone } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';

// POST { id } — after a signed-in non-member filed an access request (pos_request_access), ping the shop's WhatsApp
// so the owner knows to open POS → Settings → Staff and approve. Plain text (delivers inside the 24 h window; the
// request is also listed in the POS regardless).
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await req.json().catch(() => ({}));
  if (!id) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  const sb = await supabaseServer();
  const { data: r } = await sb.from('access_requests').select('id, shop_id, name, phone, note, status').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!r || r.status !== 'pending') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const { data: shop } = await sb.from('shops').select('name, whatsapp, phone').eq('id', r.shop_id).maybeSingle();
  const to = normalizePhone(String(shop?.whatsapp || shop?.phone || ''));
  if (!to || !waConfigured()) return NextResponse.json({ ok: true, notified: false });
  const origin = `https://${req.headers.get('x-forwarded-host') ?? new URL(req.url).host}`;
  const who = `${r.name || ''}${r.phone ? ` (+${r.phone})` : ''}`.trim() || 'مستخدم';
  const text = `👤 طلب وصول إلى نقطة البيع\n${who} يطلب الانضمام كموظف.${r.note ? `\n«${r.note}»` : ''}\nللموافقة أو الرفض: ${origin}/pos#settings`;
  try { await waSendText(to, text); return NextResponse.json({ ok: true, notified: true }); }
  catch (e) { return NextResponse.json({ ok: true, notified: false, error: (e as Error).message.slice(0, 160) }); }
}
