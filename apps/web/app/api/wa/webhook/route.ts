import { NextResponse } from 'next/server';
import { waVerifySignature, waSendText, waSendTemplate } from '@/lib/server/whatsapp';
import { orderMessageTpl, tplComponents } from '@/lib/server/wa-messages';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { logWaMessage, type Party } from '@/lib/server/wa-log';
import { normalizePhone } from '@/lib/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Meta webhook verification handshake: GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
export async function GET(req: Request) {
  const u = new URL(req.url);
  const ok = u.searchParams.get('hub.mode') === 'subscribe' && u.searchParams.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN;
  return ok ? new Response(u.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('forbidden', { status: 403 });
}

type Status = { id: string; status: string; recipient_id: string; errors?: { code?: number; title?: string }[] };
type Msg = { id: string; from: string; type: string; timestamp?: string; text?: { body: string }; context?: { id?: string }; button?: { text?: string } };

// Incoming events: delivery statuses for our sends, and messages from customers / shops.
// A message that quotes one of our order messages — or comes from a phone with exactly one open order — is attached to
// that order (order_events note) and forwarded to the other party from the same number. Everything is acknowledged fast.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!waVerifySignature(raw, req.headers.get('x-hub-signature-256'))) return new Response('bad signature', { status: 401 });
  const work: Promise<unknown>[] = [];
  try {
    const body = JSON.parse(raw);
    for (const entry of body.entry ?? []) for (const ch of entry.changes ?? []) {
      const v = ch.value ?? {};
      const phoneNumberId: string | undefined = v.metadata?.phone_number_id;
      for (const s of (v.statuses ?? []) as Status[]) {
        console.log('[wa status]', s.id, s.status, s.recipient_id, s.errors?.[0]?.title ?? '');
        work.push(updateStatus(s));
      }
      for (const m of (v.messages ?? []) as Msg[]) {
        console.log('[wa message]', m.from, m.type, m.text?.body?.slice(0, 120) ?? '');
        work.push(handleInbound(m, phoneNumberId));
      }
    }
  } catch (e) { console.error('[wa webhook] parse error', e); }
  await Promise.allSettled(work);
  return NextResponse.json({ ok: true });
}

async function updateStatus(s: Status) {
  const sb = supabaseAdmin(); if (!sb) return;
  await sb.from('wa_messages').update({ status: s.status, error: s.errors?.[0]?.title ?? null }).eq('wamid', s.id);
}

async function handleInbound(m: Msg, phoneNumberId?: string) {
  const sb = supabaseAdmin(); if (!sb) return;
  const text = m.text?.body ?? m.button?.text ?? `[${m.type}]`;
  const from = normalizePhone(m.from) ?? m.from;

  const { data: match } = await sb.rpc('wa_match_order', { p_phone: from, p_context_wamid: m.context?.id ?? null, p_phone_number_id: phoneNumberId ?? null });
  const hit = (Array.isArray(match) ? match[0] : match) as { order_id: string; party: Party } | undefined;
  await logWaMessage({ wamid: m.id, order_id: hit?.order_id ?? null, direction: 'in', party: hit?.party ?? 'unknown', phone: from, phone_number_id: phoneNumberId, body: text });
  if (!hit) return;                                              // Phase C keeps unmatched chatter silent (no auto-reply spam)

  const { data: o } = await sb.from('orders').select('id,number,tenant_id,customer_phone,customer_name,shop:shops(name,whatsapp)').eq('id', hit.order_id).maybeSingle();
  if (!o) return;
  const shop = (o as any).shop as { name: Record<string, string>; whatsapp: string | null } | null;
  const shopName = shop?.name?.ar ?? shop?.name?.en ?? '';

  // 1) order history
  await sb.from('order_events').insert({ order_id: o.id, tenant_id: o.tenant_id, actor_kind: hit.party === 'shop' ? 'shop' : 'customer', note: text });

  // 2) forward to the other side, from the same number the message came in on
  const dest = hit.party === 'shop' ? o.customer_phone : shop?.whatsapp;
  const label = hit.party === 'shop' ? `💬 ${shopName} — ${o.number}` : `💬 ${o.customer_name || 'العميل'} — ${o.number}`;
  const n = normalizePhone(dest); if (!n) return;
  try {
    const who = hit.party === 'shop' ? shopName : (o.customer_name || 'العميل');
    const r = process.env.WHATSAPP_TEMPLATES === '1'
      ? await (() => { const tpl = orderMessageTpl(o.number, who, text); return waSendTemplate(n, tpl.name, tpl.lang, tplComponents(tpl), phoneNumberId); })()
      : await waSendText(n, `${label}:\n${text}`, phoneNumberId);
    await logWaMessage({ wamid: r.messages?.[0]?.id ?? `fwd-${m.id}`, order_id: o.id, tenant_id: o.tenant_id, direction: 'out', party: hit.party === 'shop' ? 'customer' : 'shop', phone: n, phone_number_id: phoneNumberId, body: `${label}:\n${text}`, status: 'sent' });
  } catch (e) { console.error('[wa forward]', (e as Error).message); }
}
