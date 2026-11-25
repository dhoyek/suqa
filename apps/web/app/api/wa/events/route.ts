import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { waConfigured, waSendText, waSendTemplate } from '@/lib/server/whatsapp';
import { normalizePhone } from '@/lib/whatsapp';
import { shopNewOrder, customerStatus, courierReady, shopNewOrderTpl, customerStatusTpl, courierReadyTpl, customerEdited, customerEditedTpl, customerConfirm, customerConfirmTpl, driverDispatch, driverDispatchTpl, shopCustomerComing, shopCustomerComingTpl, shopDriverAck, shopDriverAckTpl, tplComponents, shouldNotifyCustomer, type OrderEvent, type Tpl } from '@/lib/server/wa-messages';
import { logWaMessage, type Party } from '@/lib/server/wa-log';
import { pushToShop } from '@/lib/server/push';

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
  const e = (await req.json()) as OrderEvent & { phone_number_id?: string | null; order: { tenant_id?: string } };
  // 🔔 a new order from the storefront (or Yorgo): a notification on every device of the shop's staff that turned it on
  // (85_push_notifications) — whether WhatsApp is set up or not. Orders typed into the shop's own POS do not notify the shop.
  const push = e.event === 'order.created' && e.shop?.id && (!e.channel || e.channel === 'online')
    ? (() => { const ar = (e.tenant?.default_locale ?? 'ar') === 'ar'; const n = e.items?.length ?? 0;
        return pushToShop(e.shop!.id, {
          title: ar ? `🛒 طلب جديد ${e.order.number}` : `🛒 New order ${e.order.number}`,
          body: [e.order.customer_name, `$${Number(e.order.total_usd ?? 0).toFixed(2)}`, n ? (ar ? `${n} صنف` : `${n} items`) : '', e.order.fulfillment === 'pickup' ? (ar ? 'استلام' : 'pickup') : (ar ? 'توصيل' : 'delivery')].filter(Boolean).join(' · '),
          url: `/pos#orders`, tag: `order-${e.order.id}`,
        }).catch(err => { console.error('[push] order', (err as Error).message); return null; }); })()
    : null;
  // 🔔 the shop's driver confirmed he got the order (120): the same devices are told, whatever the order's channel
  const pushAck = e.event === 'order.driver_ack' && e.shop?.id
    ? (() => { const ar = (e.tenant?.default_locale ?? 'ar') === 'ar';
        return pushToShop(e.shop!.id, {
          title: ar ? `🛵✅ السائق أكّد الطلب ${e.order.number}` : `🛵✅ Driver confirmed order ${e.order.number}`,
          body: [e.driver?.name, e.order.customer_name].filter(Boolean).join(' · '),
          url: `/pos#orders`, tag: `ack-${e.order.id}`,
        }).catch(err => { console.error('[push] ack', (err as Error).message); return null; }); })()
    : null;
  if (!waConfigured()) { await push; await pushAck; return NextResponse.json({ skipped: 'whatsapp_not_configured' }); }

  const u = new URL(req.url);
  const origin = `https://${req.headers.get('x-forwarded-host') ?? u.host}`;
  const sends: Promise<unknown>[] = [];
  const from = e.phone_number_id ?? null;
  const useTpl = process.env.WHATSAPP_TEMPLATES === '1';   // approved Meta templates: deliver outside the 24 h window
  const to = (raw: string | null | undefined, text: string | null, party: Party, tpl?: Tpl | null) => {
    const n = normalizePhone(raw); if (!n || !text) return;
    // Template first; if Meta refuses it (e.g. not approved yet on a new account), fall back to plain text,
    // which still delivers inside the customer's 24 h window.
    const send = useTpl && tpl
      ? waSendTemplate(n, tpl.name, tpl.lang, tplComponents(tpl), from).catch(err => {
          console.warn('[wa events] template failed', tpl.name, (err as Error).message.slice(0, 160));
          if (tpl.fallback) return waSendTemplate(n, tpl.fallback.name, tpl.fallback.lang, tplComponents(tpl.fallback), from).catch(() => waSendText(n, text, from));
          return waSendText(n, text, from);
        })
      : waSendText(n, text, from);
    sends.push(send
      .then(r => logWaMessage({ wamid: r.messages?.[0]?.id ?? `local-${Date.now()}-${n}`, order_id: e.order.id, tenant_id: e.order.tenant_id ?? e.tenant?.id, direction: 'out', party, phone: n, phone_number_id: from ?? process.env.WHATSAPP_PHONE_ID, body: text, status: 'sent' }))
      .catch(err => console.error('[wa events] send failed', n.slice(-4), (err as Error).message)));
  };

  if (e.event === 'order.created') {
    // orders the shop typed into its own POS (whatsapp/phone) don't need a shop alert
    if (!e.channel || e.channel === 'online') to(e.shop?.whatsapp, shopNewOrder(e, origin), 'shop', shopNewOrderTpl(e, origin));
    // WhatsApp/phone orders typed in at the POS start as accepted → the customer gets the confirmation right away
    else if (e.order.status === 'accepted' && shouldNotifyCustomer(e)) to(e.order.customer_phone, customerConfirm(e, origin), 'customer', customerConfirmTpl(e, origin));
  } else if (e.event === 'order.edited') {
    if (e.order.notify_customer !== false) to(e.order.customer_phone, customerEdited(e, origin), 'customer', customerEditedTpl(e, origin));
  } else if (e.event === 'order.status') {
    if (shouldNotifyCustomer(e)) to(e.order.customer_phone, customerStatus(e, origin), 'customer', customerStatusTpl(e, origin));
    // the shop's own driver (drivers-lite): assigned together with "out for delivery"
    // … unless he was already lined up (and messaged) while the order was still in the shop — see 'order.driver' below
    // … and a driver chosen together with "ready" (or an earlier step) is told to come for it
    const lined = e.driver_changed === true && ['accepted', 'preparing', 'ready'].includes(e.order.status);
    if (e.driver?.phone && (lined || (e.order.status === 'out_for_delivery' && e.old_status !== 'out_for_delivery' && e.driver_changed !== false))) to(e.driver.phone, driverDispatch(e, origin), 'courier', driverDispatchTpl(e, origin));
    if (e.order.status === 'ready' && e.order.fulfillment !== 'pickup' && e.tenant?.courier_enabled && e.tenant.delivery_mode === 'courier') {
      const msg = courierReady(e, origin); const tpl = courierReadyTpl(e, origin);
      for (const p of new Set(e.couriers ?? [])) to(p, msg, 'courier', tpl);
    }
  } else if (e.event === 'order.coming') {
    to(e.shop?.whatsapp, shopCustomerComing(e), 'shop', shopCustomerComingTpl(e, origin));
  } else if (e.event === 'order.driver_ack') {
    to(e.shop?.whatsapp, shopDriverAck(e), 'shop', shopDriverAckTpl(e, origin));
  } else if (e.event === 'order.driver') {
    // a driver chosen (or changed) without a status change: he gets the order now so he can come for it
    if (e.driver?.phone) to(e.driver.phone, driverDispatch(e, origin), 'courier', driverDispatchTpl(e, origin));
  }
  await Promise.all(sends);
  await push; await pushAck;
  return NextResponse.json({ ok: true, sent: sends.length });
}
