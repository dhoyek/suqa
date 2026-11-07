import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { waConfigured, waSendText, waSendTemplate } from '@/lib/server/whatsapp';
import { normalizePhone } from '@/lib/whatsapp';
import { logWaMessage } from '@/lib/server/wa-log';

// POST { order_id, phone, locale } — sends the receipt of a POS sale to a customer on WhatsApp.
// Signed-in shop member only (RLS proves membership by reading the order). Template `receipt` when WHATSAPP_TEMPLATES=1
// (works outside the 24 h window), plain text otherwise.
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!waConfigured()) return NextResponse.json({ error: 'whatsapp_not_configured' }, { status: 503 });
  const { order_id, phone, locale = 'ar' } = await req.json().catch(() => ({}));
  const to = normalizePhone(String(phone ?? ''));
  if (!order_id || !to) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const sb = await supabaseServer();
  const { data: o } = await sb.from('orders').select('id, number, local_number, total_cents, total_lbp, shop_id, shop:shops(name, slug), items:order_items(name, quantity, voided), payments(tender, amount, currency)').eq('id', order_id).maybeSingle();
  if (!o) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const L = locale === 'en' ? 'en' : 'ar';
  const shop = (o.shop as unknown as { name: Record<string, string> } | null)?.name ?? {};
  const shopName = shop[L] || shop.ar || shop.en || '';
  const items = (o.items as Array<{ name: Record<string, string>; quantity: number | string; voided: boolean }>).filter(i => !i.voided)
    .map(i => `${Number(i.quantity)}× ${i.name?.[L] || i.name?.ar || i.name?.en || ''}`).join('، ');
  const pays = (o.payments as Array<{ tender: string; amount: number; currency: string }>).map(p => `${label(p.tender, L)} ${p.currency === 'lbp' ? Number(p.amount).toLocaleString('en-US') + ' ل.ل.' : '$' + (Number(p.amount) / 100).toFixed(2)}`).join(' + ');
  const total = `$${(Number(o.total_cents) / 100).toFixed(2)} · ${Number(o.total_lbp).toLocaleString('en-US')} ل.ل.`;
  const number = o.number ?? o.local_number ?? '';
  const url = `${new URL(req.url).origin}/r/${o.id}`;
  const text = `🧾 إيصال من ${shopName} — رقم ${number}\n${items}\nالإجمالي: ${total}\nالدفع: ${pays}\nالإيصال الكامل: ${url}\nشكراً لزيارتكم.`;

  const admin = supabaseAdmin();
  let from: string | null = null;
  if (admin) { try { const r = await admin.rpc('wa_sender_for_order', { p_order: o.id }); from = (r.data as string | null) ?? null; } catch { from = null; } }
  let wamid: string | null = null; let error: string | null = null;
  try {
    if (process.env.WHATSAPP_TEMPLATES === '1') {
      try { wamid = (await waSendTemplate(to, 'receipt', 'ar', [{ type: 'body', parameters: [shopName, number, items, total, pays, url].map(t => ({ type: 'text', text: String(t).slice(0, 1000) })) }], from)).messages?.[0]?.id ?? null; }
      catch { wamid = (await waSendText(to, text, from)).messages?.[0]?.id ?? null; }     // template not approved yet / 24 h window open → text
    } else wamid = (await waSendText(to, text, from)).messages?.[0]?.id ?? null;
  } catch (e) { error = (e as Error).message; }
  if (wamid) await logWaMessage({ direction: 'out', party: 'customer', phone: to, order_id: o.id, body: text, wamid, status: 'sent', phone_number_id: from }).catch(() => undefined);
  return NextResponse.json(error ? { ok: false, error } : { ok: true, wamid }, { status: error ? 502 : 200 });
}
const label = (t: string, L: 'ar' | 'en') => ({ cash_usd: L === 'ar' ? 'نقدي' : 'Cash', cash_lbp: L === 'ar' ? 'نقدي' : 'Cash', card: L === 'ar' ? 'بطاقة' : 'Card', wallet: 'Wallet', unpaid: L === 'ar' ? 'دين' : 'Unpaid' } as Record<string, string>)[t] ?? t;
