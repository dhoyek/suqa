import { NextResponse, after } from 'next/server';
import { waVerifySignature, waSendText, waSendTemplate, waDownloadMedia } from '@/lib/server/whatsapp';
import { orderMessageTpl, tplComponents } from '@/lib/server/wa-messages';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { logWaMessage, type Party } from '@/lib/server/wa-log';
import { normalizePhone } from '@/lib/whatsapp';
import { getTenantOrNull } from '@/lib/tenant';
import { createClient } from '@supabase/supabase-js';
import { anthropicClient } from '@/lib/yorgo/model';
import { yorgoConfig } from '@/lib/yorgo/config';
import { waKind, waTextOnly, waTurn, waVoiceTurn, WA_MEMORY_HOURS, type Slim, type WaDeps } from '@/lib/yorgo/whatsapp';
import { loadRoute, ROUTE_COLUMNS } from '@/lib/ai/routes';
import { googleKey } from '@/lib/ai/google';
import { runVoice, VOICE_MAX_BYTES } from '@/lib/ai/voice';
import type { ShopHint } from '@/lib/yorgo/prompts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;                       // a Yorgo answer takes 5–20 s; Meta already has its 200 by then (see POST)

// Meta webhook verification handshake: GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
export async function GET(req: Request) {
  const u = new URL(req.url);
  const ok = u.searchParams.get('hub.mode') === 'subscribe' && u.searchParams.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN;
  return ok ? new Response(u.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('forbidden', { status: 403 });
}

type Status = { id: string; status: string; recipient_id: string; errors?: { code?: number; title?: string }[] };
type Msg = { id: string; from: string; type: string; timestamp?: string; text?: { body: string }; context?: { id?: string }; button?: { text?: string }; location?: { latitude: number; longitude: number; name?: string; address?: string }; audio?: { id?: string; mime_type?: string; voice?: boolean } };

// Incoming events: delivery statuses for our sends, and messages from customers / shops.
// A message that quotes one of our order messages — or comes from a phone with exactly one open order — is attached to
// that order (order_events note) and forwarded to the other party from the same number. A text that matches no order goes to
// Yorgo when the market switched it on (step W1, script 95): a basket draft behind a link, never an order.
// Statuses, locations, driver "ok" and order messages are handled before Meta gets its 200, exactly as before. Only a Yorgo
// answer (5–20 s) runs after the response. Each message id is taken once (wa_inbox), so Meta's retries never do the work twice.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!waVerifySignature(raw, req.headers.get('x-hub-signature-256'))) return new Response('bad signature', { status: 401 });
  const statuses: Status[] = []; const messages: { m: Msg; phoneNumberId?: string }[] = [];
  try {
    const body = JSON.parse(raw);
    for (const entry of body.entry ?? []) for (const ch of entry.changes ?? []) {
      const v = ch.value ?? {};
      const phoneNumberId: string | undefined = v.metadata?.phone_number_id;
      for (const s of (v.statuses ?? []) as Status[]) { console.log('[wa status]', s.id, s.status, s.recipient_id, s.errors?.[0]?.title ?? ''); statuses.push(s); }
      for (const m of (v.messages ?? []) as Msg[]) { console.log('[wa message]', m.from, m.type, m.text?.body?.slice(0, 120) ?? ''); messages.push({ m, phoneNumberId }); }
    }
  } catch (e) { console.error('[wa webhook] parse error', e); }
  // what the background work needs from the request, read while the request is still here
  const site = `https://${req.headers.get('x-forwarded-host') ?? new URL(req.url).host}`;
  const host = messages.length ? await getTenantOrNull().catch(() => null) : null;
  const tenant = host ? { id: host.id, brand: host.brand_name, fx_lbp_rate: host.fx_lbp_rate } : null;
  const later: (() => Promise<void>)[] = [];
  await Promise.allSettled([...statuses.map(updateStatus), ...messages.map(x => inbound(x.m, x.phoneNumberId, { site, tenant }, later))]);
  if (later.length) after(async () => { await Promise.allSettled(later.map(f => f())); });
  return NextResponse.json({ ok: true });
}

type Ctx = { site: string; tenant: { id: string; brand: string; fx_lbp_rate?: number | string | null } | null };

type Deferred = { later: () => Promise<string> };
/** One message, once: taken in wa_inbox first (a retry from Meta finds it taken and stops), then handled, then marked.
 *  What must not hold Meta's answer (a Yorgo turn) is pushed to `later` and runs after the response. */
async function inbound(m: Msg, phoneNumberId: string | undefined, ctx: Ctx, later: (() => Promise<void>)[]) {
  const sb = supabaseAdmin(); if (!sb) return;
  const from = normalizePhone(m.from) ?? m.from;
  let guarded = false;
  try {
    const { data, error } = await sb.rpc('wa_inbox_claim', { p_wamid: m.id, p_tenant: ctx.tenant?.id ?? null, p_phone: from, p_phone_number_id: phoneNumberId ?? null, p_kind: m.type, p_body: m.text?.body ?? null });
    if (!error) { guarded = true; if (data !== true) { console.log('[wa inbox] seen before', m.id); return; } }      // (before script 95 the function is missing: carry on as before, unguarded)
  } catch { /* unguarded */ }
  const done = async (as: string, err: string | null) => { if (guarded) await sb.rpc('wa_inbox_done', { p_wamid: m.id, p_as: as, p_error: err }).then(() => null, () => null); };
  try {
    const r = await handleInbound(m, phoneNumberId, ctx);
    if (typeof r === 'string') { await done(r, null); return; }
    later.push(async () => { try { const [as, ...why] = (await r.later()).split('|'); await done(as, why.join('|') || null); } catch (e) { console.error('[wa yorgo]', (e as Error).message); await done('error', (e as Error).message); } });
  } catch (e) { console.error('[wa inbound]', (e as Error).message); await done('error', (e as Error).message); }
}

async function updateStatus(s: Status) {
  const sb = supabaseAdmin(); if (!sb) return;
  await sb.from('wa_messages').update({ status: s.status, error: s.errors?.[0]?.title ?? null }).eq('wamid', s.id);
}

async function handleInbound(m: Msg, phoneNumberId: string | undefined, ctx: Ctx): Promise<string | Deferred> {
  const sb = supabaseAdmin(); if (!sb) return 'error';
  const text = m.text?.body ?? m.button?.text ?? (m.location ? `📍 ${m.location.latitude},${m.location.longitude}${m.location.name ? ' ' + m.location.name : ''}` : `[${m.type}]`);
  const from = normalizePhone(m.from) ?? m.from;

  // A shared location pins the customer's address (shop_customers) and any open delivery order of that phone (29_pos_m9).
  if (m.type === 'location' && m.location) {
    try {
      const { data } = await sb.rpc('wa_attach_location', { p_phone: from, p_phone_number_id: phoneNumberId ?? null, p_lat: m.location.latitude, p_lng: m.location.longitude, p_label: [m.location.name, m.location.address].filter(Boolean).join(' – ') || null });
      const r = (data ?? {}) as { customers?: number; orders?: number; shop_name?: Record<string, string> | null };
      console.log('[wa location]', from, r);
      if ((r.customers ?? 0) + (r.orders ?? 0) > 0) {
        try { await waSendText(from, `📍 شكراً، وصلنا موقعكم${r.shop_name ? ' — ' + (r.shop_name.ar ?? r.shop_name.en ?? '') : ''}.`, phoneNumberId ?? null); } catch {}
      }
    } catch (e) { console.error('[wa location]', e); }
  }

  // A shop driver answering his dispatch message ("ok", 👍, "جايي"…) confirms his latest unconfirmed order (52_driver_ack)
  if (m.type !== 'location') {
    try {
      const { data: acked } = await sb.rpc('driver_ack_by_phone', { p_phone: from });
      if (acked) { await logWaMessage({ wamid: m.id, order_id: acked as string, direction: 'in', party: 'courier', phone: from, phone_number_id: phoneNumberId, body: text }); return 'driver_ack'; }
    } catch (e) { console.error('[wa driver ack]', (e as Error).message); }
  }

  const { data: match } = await sb.rpc('wa_match_order', { p_phone: from, p_context_wamid: m.context?.id ?? null, p_phone_number_id: phoneNumberId ?? null });
  const hit = (Array.isArray(match) ? match[0] : match) as { order_id: string; party: Party } | undefined;
  await logWaMessage({ wamid: m.id, order_id: hit?.order_id ?? null, direction: 'in', party: hit?.party ?? 'unknown', phone: from, phone_number_id: phoneNumberId, body: text });
  if (!hit) return m.type === 'location' ? 'location' : { later: () => yorgo(m, from, phoneNumberId, ctx) };      // no order behind it: Yorgo, when the market switched it on — after Meta has its answer

  const { data: o } = await sb.from('orders').select('id,number,tenant_id,customer_phone,customer_name,shop:shops(name,whatsapp)').eq('id', hit.order_id).maybeSingle();
  if (!o) return 'order_message';
  const shop = (o as any).shop as { name: Record<string, string>; whatsapp: string | null } | null;
  const shopName = shop?.name?.ar ?? shop?.name?.en ?? '';

  // 1) order history
  await sb.from('order_events').insert({ order_id: o.id, tenant_id: o.tenant_id, actor_kind: hit.party === 'shop' ? 'shop' : 'customer', note: text });

  // 2) forward to the other side, from the same number the message came in on
  const dest = hit.party === 'shop' ? o.customer_phone : shop?.whatsapp;
  const label = hit.party === 'shop' ? `💬 ${shopName} — ${o.number}` : `💬 ${o.customer_name || 'العميل'} — ${o.number}`;
  const n = normalizePhone(dest); if (!n) return 'order_message';
  try {
    const who = hit.party === 'shop' ? shopName : (o.customer_name || 'العميل');
    const r = process.env.WHATSAPP_TEMPLATES === '1'
      ? await (() => { const tpl = orderMessageTpl(o.number, who, text); return waSendTemplate(n, tpl.name, tpl.lang, tplComponents(tpl), phoneNumberId); })()
      : await waSendText(n, `${label}:\n${text}`, phoneNumberId);
    await logWaMessage({ wamid: r.messages?.[0]?.id ?? `fwd-${m.id}`, order_id: o.id, tenant_id: o.tenant_id, direction: 'out', party: hit.party === 'shop' ? 'customer' : 'shop', phone: n, phone_number_id: phoneNumberId, body: `${label}:\n${text}`, status: 'sent' });
  } catch (e) { console.error('[wa forward]', (e as Error).message); }
  return 'order_message';
}

// ── Yorgo (step W1) ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The customer's text → a basket draft behind a link. Yorgo reads the PUBLIC catalog with the anonymous key: the phone is never
// turned into an account, nothing of anyone's orders is read, nothing is ordered. The service role is used for the switches,
// the caps, the phone's own conversation and storing the draft — as in the app chat.
async function yorgo(m: Msg, from: string, phoneNumberId: string | undefined, ctx: Ctx): Promise<string> {
  const admin = supabaseAdmin(); const kind = waKind(m.type);
  if (!admin || kind === 'silent') return 'silent';
  // the market: the number's own (wa_numbers), otherwise the site Meta called
  let tenant = ctx.tenant;
  if (phoneNumberId) {
    const { data: num } = await admin.from('wa_numbers').select('tenant_id').eq('phone_number_id', phoneNumberId).maybeSingle();
    if (num?.tenant_id && num.tenant_id !== tenant?.id) { const { data: t } = await admin.from('tenants').select('id,brand_name,fx_lbp_rate').eq('id', num.tenant_id).maybeSingle(); if (t) tenant = { id: t.id as string, brand: t.brand_name as string, fx_lbp_rate: t.fx_lbp_rate as number }; }
  }
  if (!tenant) return 'silent';
  const say = async (body: string) => {
    const r = await waSendText(from, body, phoneNumberId ?? null);
    await logWaMessage({ wamid: r.messages?.[0]?.id ?? `yorgo-${m.id}`, tenant_id: tenant!.id, direction: 'out', party: 'customer', phone: from, phone_number_id: phoneNumberId, body, status: 'sent' });
  };

  // a voice note is heard when the platform switched the 'voice' route on (script 100) and its key is there; otherwise it gets the "text only" line
  const voiceRoute = kind === 'voice' && m.audio?.id ? await loadRoute('voice', async t => (await admin.from('yorgo_ai_routes').select(ROUTE_COLUMNS).eq('task', t).maybeSingle()).data as Record<string, unknown> | null) : null;
  const voiceKey = googleKey();
  const hears = !!(voiceRoute?.enabled && voiceKey);
  if (kind === 'unsupported' || (kind === 'voice' && !hears)) {
    // a photo, or a voice note we cannot hear: one line saying text only — when Yorgo is on here, and at most once an hour per phone
    const { data: s } = await admin.from('yorgo_settings').select('enabled,shopper_enabled,whatsapp_enabled').eq('tenant_id', tenant.id).maybeSingle();
    if (!s?.enabled || !s.shopper_enabled || !s.whatsapp_enabled) return 'off';
    const { count } = await admin.from('wa_inbox').select('wamid', { count: 'exact', head: true }).eq('phone', from).eq('handled_as', 'unsupported').gt('handled_at', new Date(Date.now() - 3600_000).toISOString());
    if (!count) await say(waTextOnly());
    return 'unsupported';
  }

  const model = anthropicClient(); const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!model || !url || !anon) return 'off';
  const pub = createClient(url, anon, { db: { schema: 'suqa' }, auth: { persistSession: false, autoRefreshToken: false } });      // a visitor: the public catalog and nothing else
  const { data: sh } = await pub.from('shops').select('id,name,known_as,known_as_en,description').eq('tenant_id', tenant.id).eq('status', 'active').order('sort_order', { ascending: true }).limit(60);
  type S = { id: string; name: { ar?: string; en?: string } | null; known_as: string | null; known_as_en: string | null; description: { ar?: string; en?: string } | null };
  const shops: ShopHint[] = ((sh as S[] | null) ?? []).map(x => ({ id: x.id, name_ar: x.name?.ar ?? null, name_en: x.name?.en ?? null, known_as: x.known_as, known_as_en: x.known_as_en, about: x.description?.en || x.description?.ar || null }));

  const deps: WaDeps = {
    model, cfg: yorgoConfig(), admin: { rpc: (fn, args) => admin.rpc(fn, args) }, sb: { rpc: (fn, args) => pub.rpc(fn, args), from: t => pub.from(t) as never },
    drafts: {
      latest: async conv => { const { data } = await admin.from('yorgo_drafts').select('draft').eq('conversation_id', conv).gt('expires_at', new Date().toISOString()).gt('created_at', new Date(Date.now() - WA_MEMORY_HOURS * 3_600_000).toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle(); return (data?.draft as Slim | undefined) ?? null; },
      save: async (conv, phone, draft) => { const { data, error } = await admin.rpc('yorgo_draft_save', { p_tenant: tenant!.id, p_conversation: conv, p_phone: phone, p_draft: draft }); return error || typeof data !== 'string' ? null : data; },
    },
  };
  const out = kind === 'voice'
    ? await waVoiceTurn({ ...deps, hear: async () => {
        // the audio lives in memory for this call only: downloaded from Meta, sent to be written down, dropped
        const media = await waDownloadMedia(m.audio!.id!, VOICE_MAX_BYTES, phoneNumberId ?? null);
        if (!media) return { status: 'failed', error: 'media_unavailable' };
        if ('tooBig' in media) return { status: 'too_long' };
        return runVoice(voiceRoute!, voiceKey!, media.bytes, media.mime);
      } }, { tenant, phone: from, site: ctx.site, shops })
    : await waTurn(deps, { tenant, phone: from, text: m.text?.body ?? '', site: ctx.site, shops });
  if (out.reply) await say(out.reply);
  // asked for and not found, as counted phrases only (script 78), like the app chat
  if (out.turn?.status === 'ok') {
    const missed = [...new Map([...(out.turn.drafts as { not_found?: string[] }[]).flatMap(d => d.not_found ?? []), ...out.turn.missed].map(x => [x.trim().toLowerCase(), x.trim()])).values()].filter(x => x && !x.endsWith('(غير متوفر الآن)')).slice(0, 20);
    if (missed.length) await admin.rpc('yorgo_miss', { p_tenant: tenant.id, p_shop: null, p_phrases: missed }).then(() => null, () => null);
  }
  if (out.as === 'error') throw new Error(out.error ?? 'yorgo_error');
  return out.error ? `${out.as}|${out.error}` : out.as;      // handled, with a remark worth keeping (the fallback model did the hearing, and why)
}
