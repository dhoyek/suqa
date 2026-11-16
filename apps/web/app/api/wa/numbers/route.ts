import { NextResponse } from 'next/server';
import { operatorAuthorized } from '@/lib/server/operator-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const GRAPH = 'https://graph.facebook.com/v21.0';

// Operator tool (x-suqa-secret header, or a signed-in tenant admin): GET = phone numbers + app subscription on our WhatsApp Business Account.
// POST { action: 'register', phone_number_id, pin } = register a number on the Cloud API (pin = 6-digit two-step PIN).
// POST { action: 'subscribe' } = subscribe this app to the WABA's webhooks.
// POST { action: 'route_here' } = send this account's webhooks to this site (override); 'route_default' = remove it.
const H = () => ({ authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' });
async function graph(path: string, init?: RequestInit) {
  const res = await fetch(`${GRAPH}/${path}`, { ...init, headers: H() });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

export async function GET(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const u = new URL(req.url);
  const waba = u.searchParams.get('waba') || process.env.WHATSAPP_WABA_ID;
  const phone = u.searchParams.get('phone');
  const business = u.searchParams.get('business');
  if (business) {   // list the WhatsApp accounts a business portfolio owns / is client of
    const [owned, client] = await Promise.all([
      graph(`${business}/owned_whatsapp_business_accounts?fields=id,name,currency,timezone_id`),
      graph(`${business}/client_whatsapp_business_accounts?fields=id,name`),
    ]);
    return NextResponse.json({ owned: owned.json, client: client.json });
  }
  if (phone) {   // probe one number directly (works even if it lives in another WABA, as long as the token can see it)
    const r = await graph(`${phone}?fields=id,display_phone_number,verified_name,name_status,code_verification_status,status,quality_rating,messaging_limit_tier,platform_type`);
    return NextResponse.json(r.json, { status: r.ok ? 200 : 400 });
  }
  const [numbers, subs] = await Promise.all([
    graph(`${waba}/phone_numbers?fields=id,display_phone_number,verified_name,name_status,code_verification_status,status,quality_rating,messaging_limit_tier,platform_type,throughput`),
    graph(`${waba}/subscribed_apps`),
  ]);
  return NextResponse.json({ current_sender: process.env.WHATSAPP_PHONE_ID, numbers: numbers.json, subscribed_apps: subs.json });
}

export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const b = await req.json().catch(() => ({})) as { action?: string; phone_number_id?: string; pin?: string; waba?: string };
  if (b.action === 'register') {
    if (!b.phone_number_id || !/^\d{6}$/.test(b.pin ?? '')) return NextResponse.json({ error: 'phone_number_id and 6-digit pin required' }, { status: 400 });
    const r = await graph(`${b.phone_number_id}/register`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', pin: b.pin }) });
    return NextResponse.json(r.json, { status: r.ok ? 200 : 400 });
  }
  if (b.action === 'subscribe') {
    const r = await graph(`${b.waba || process.env.WHATSAPP_WABA_ID}/subscribed_apps`, { method: 'POST' });
    return NextResponse.json(r.json, { status: r.ok ? 200 : 400 });
  }
  // Incoming webhooks of THIS site's WhatsApp account go to THIS site, whatever the app's dashboard callback says
  // (Meta "webhook override" on the account; lets dev and prod share one Meta app, each with its own number).
  if (b.action === 'route_here') {
    const host = req.headers.get('x-forwarded-host') ?? new URL(req.url).host;
    if (!process.env.WHATSAPP_WABA_ID || !process.env.WHATSAPP_VERIFY_TOKEN) return NextResponse.json({ error: 'WHATSAPP_WABA_ID / WHATSAPP_VERIFY_TOKEN missing' }, { status: 500 });
    const url = `https://${host}/api/wa/webhook`;
    const r = await graph(`${process.env.WHATSAPP_WABA_ID}/subscribed_apps`, { method: 'POST', body: JSON.stringify({ override_callback_uri: url, verify_token: process.env.WHATSAPP_VERIFY_TOKEN }) });
    return NextResponse.json({ callback: url, result: r.json }, { status: r.ok ? 200 : 400 });
  }
  if (b.action === 'route_default') {   // drop the override: back to the app's dashboard callback (still subscribed)
    const r = await graph(`${process.env.WHATSAPP_WABA_ID}/subscribed_apps`, { method: 'POST' });
    return NextResponse.json(r.json, { status: r.ok ? 200 : 400 });
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
