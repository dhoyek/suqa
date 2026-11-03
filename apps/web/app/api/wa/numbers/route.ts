import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const GRAPH = 'https://graph.facebook.com/v21.0';

// Operator tool (x-suqa-secret): GET = phone numbers + app subscription on our WhatsApp Business Account.
// POST { action: 'register', phone_number_id, pin } = register a number on the Cloud API (pin = 6-digit two-step PIN).
// POST { action: 'subscribe' } = subscribe this app to the WABA's webhooks.
function authorized(req: Request) {
  const want = process.env.SUQA_EVENTS_SECRET, got = req.headers.get('x-suqa-secret');
  return !!want && !!got && want.length === got.length && timingSafeEqual(Buffer.from(want), Buffer.from(got));
}
const H = () => ({ authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' });
async function graph(path: string, init?: RequestInit) {
  const res = await fetch(`${GRAPH}/${path}`, { ...init, headers: H() });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const waba = process.env.WHATSAPP_WABA_ID;
  const [numbers, subs] = await Promise.all([
    graph(`${waba}/phone_numbers?fields=id,display_phone_number,verified_name,name_status,code_verification_status,status,quality_rating,messaging_limit_tier,platform_type,throughput`),
    graph(`${waba}/subscribed_apps`),
  ]);
  return NextResponse.json({ current_sender: process.env.WHATSAPP_PHONE_ID, numbers: numbers.json, subscribed_apps: subs.json });
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const b = await req.json().catch(() => ({})) as { action?: string; phone_number_id?: string; pin?: string };
  if (b.action === 'register') {
    if (!b.phone_number_id || !/^\d{6}$/.test(b.pin ?? '')) return NextResponse.json({ error: 'phone_number_id and 6-digit pin required' }, { status: 400 });
    const r = await graph(`${b.phone_number_id}/register`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', pin: b.pin }) });
    return NextResponse.json(r.json, { status: r.ok ? 200 : 400 });
  }
  if (b.action === 'subscribe') {
    const r = await graph(`${process.env.WHATSAPP_WABA_ID}/subscribed_apps`, { method: 'POST' });
    return NextResponse.json(r.json, { status: r.ok ? 200 : 400 });
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
