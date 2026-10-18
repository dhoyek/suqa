import { NextResponse } from 'next/server';
import { waVerifySignature } from '@/lib/server/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Meta webhook verification handshake: GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
export async function GET(req: Request) {
  const u = new URL(req.url);
  const ok = u.searchParams.get('hub.mode') === 'subscribe' && u.searchParams.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN;
  return ok ? new Response(u.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('forbidden', { status: 403 });
}

// Incoming events: message status updates (sent/delivered/read/failed) and customer replies.
// Phase 1: acknowledge fast and log a compact summary; persistence/reply handling comes with the notifications work.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!waVerifySignature(raw, req.headers.get('x-hub-signature-256'))) return new Response('bad signature', { status: 401 });
  try {
    const body = JSON.parse(raw);
    for (const entry of body.entry ?? []) for (const ch of entry.changes ?? []) {
      const v = ch.value ?? {};
      for (const s of v.statuses ?? []) console.log('[wa status]', s.id, s.status, s.recipient_id, s.errors?.[0]?.title ?? '');
      for (const m of v.messages ?? []) console.log('[wa message]', m.from, m.type, m.text?.body?.slice(0, 120) ?? '');
    }
  } catch (e) { console.error('[wa webhook] parse error', e); }
  return NextResponse.json({ ok: true });
}
