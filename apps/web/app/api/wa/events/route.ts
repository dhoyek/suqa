import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { waConfigured, waSendText } from '@/lib/server/whatsapp';
import { normalizePhone } from '@/lib/whatsapp';
import { shopNewOrder, customerStatus, courierReady, type OrderEvent } from '@/lib/server/wa-messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Called by the suqa.orders trigger (15_notifications.sql) through pg_net, authenticated with a shared secret.
function authorized(req: Request): boolean {
  const want = process.env.SUQA_EVENTS_SECRET, got = req.headers.get('x-suqa-secret');
  if (!want || !got || want.length !== got.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const e = (await req.json()) as OrderEvent;
  if (!waConfigured()) return NextResponse.json({ skipped: 'whatsapp_not_configured' });

  const u = new URL(req.url);
  const origin = `https://${req.headers.get('x-forwarded-host') ?? u.host}`;
  const sends: Promise<unknown>[] = [];
  const to = (raw: string | null | undefined, text: string | null) => {
    const n = normalizePhone(raw); if (!n || !text) return;
    sends.push(waSendText(n, text).catch(err => console.error('[wa events] send failed', n.slice(-4), (err as Error).message)));
  };

  if (e.event === 'order.created') {
    to(e.shop?.whatsapp, shopNewOrder(e, origin));
  } else if (e.event === 'order.status') {
    to(e.order.customer_phone, customerStatus(e, origin));
    if (e.order.status === 'ready' && e.tenant?.courier_enabled && e.tenant.delivery_mode === 'courier') {
      const msg = courierReady(e, origin);
      for (const p of new Set(e.couriers ?? [])) to(p, msg);
    }
  }
  await Promise.all(sends);
  return NextResponse.json({ ok: true, sent: sends.length });
}
