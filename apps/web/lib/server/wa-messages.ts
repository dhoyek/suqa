import { formatMoney, pointFromEwkb, t, type Locale, type LocalizedText, type DisplayCurrency } from '@suqa/shared';

// Message copy for order notifications. Arabic first for 'ar' tenants, English otherwise.
// Dev: sent as plain text. Production: the same wording goes into Meta utility templates (see docs).
export type OrderEvent = {
  event: 'order.created' | 'order.status' | 'order.edited';
  channel?: 'online' | 'walkin' | 'whatsapp' | 'phone';
  old_status?: string | null;
  order: { id: string; number: string; status: string; basket_id?: string | null; fulfillment?: 'delivery' | 'pickup'; notify_customer?: boolean; customer_name: string; customer_phone: string; customer_notes?: string | null;
    address: Record<string, unknown>; subtotal_usd: number; delivery_fee_usd: number; total_usd: number; fx_lbp_rate: number;
    reject_reason?: string | null; eta_minutes?: number | null; shop_notes?: string | null; courier_id?: string | null; driver_id?: string | null; courier_name?: string | null; needed_at?: string | null };
  driver?: { id: string; name: string; phone: string; vehicle?: string | null } | null;
  items: { name: LocalizedText; unit?: string | null; quantity: number; line_total_usd: number; notes?: string | null }[];
  shop: { id: string; slug: string; name: LocalizedText; whatsapp?: string | null; phone?: string | null; address?: string | null; location?: string | null; notify_stages?: string[] | null } | null;
  tenant: { id: string; slug: string; brand_name: string; default_locale: Locale; display_currency: DisplayCurrency; courier_enabled: boolean; delivery_mode: 'per_shop' | 'courier'; notify_stages?: string[] } | null;
  courier_phone?: string | null;
  couriers: string[];
};

const addr = (a: Record<string, unknown>) => [a.label, a.line1, a.line2, a.street, a.building, a.floor, a.area, a.city, a.notes].filter(Boolean).join(', ');
const mapUrl = (a: Record<string, unknown>) => { if (a?.map_url) return String(a.map_url); const p = (a?.lat != null && a?.lng != null) ? { lat: Number(a.lat), lng: Number(a.lng) } : pointFromEwkb(a?.location as string | undefined); return p ? `https://maps.google.com/?q=${p.lat},${p.lng}` : ''; };
const waMe = (phone: string) => `https://wa.me/${String(phone).replace(/\D/g, '')}`;
const lines = (e: OrderEvent, L: Locale) => e.items.map(i => `• ${i.quantity}${i.unit ? ' ' + i.unit : '×'} ${t(i.name, L)}${i.notes ? ` (${i.notes})` : ''}`).join('\n');
const money = (e: OrderEvent, usd: number) => formatMoney(Number(usd), Number(e.order.fx_lbp_rate), e.tenant?.display_currency ?? 'both', e.tenant?.default_locale ?? 'en');

/** New order → the shop. */
export function shopNewOrder(e: OrderEvent, origin: string): string {
  const L = e.tenant?.default_locale ?? 'ar';
  const o = e.order;
  const ar = L === 'ar';
  return [
    ar ? `🛒 *طلب جديد ${o.number}* — ${e.tenant?.brand_name ?? ''}` : `🛒 *New order ${o.number}* — ${e.tenant?.brand_name ?? ''}`,
    o.fulfillment === 'pickup' ? (ar ? '🛍️ استلام من المتجر' : '🛍️ Pickup at the shop') : null,
    '',
    lines(e, L),
    '',
    `${ar ? 'المجموع' : 'Subtotal'}: ${money(e, o.subtotal_usd)}`,
    Number(o.delivery_fee_usd) > 0 ? `${ar ? 'التوصيل' : 'Delivery'}: ${money(e, o.delivery_fee_usd)}` : null,
    `*${ar ? 'الإجمالي' : 'Total'}: ${money(e, o.total_usd)}*`,
    '',
    `${ar ? 'العميل' : 'Customer'}: ${o.customer_name || ''} ${o.customer_phone} ${waMe(o.customer_phone)}`.replace(/\s+/g, ' '),
    o.fulfillment === 'pickup' ? null : `${ar ? 'العنوان' : 'Address'}: ${[addr(o.address), mapUrl(o.address)].filter(Boolean).join(' — ') || '-'}`,
    o.customer_notes ? `${ar ? 'ملاحظات' : 'Notes'}: ${o.customer_notes}` : null,
    '',
    ar ? `للقبول أو الرفض: ${origin}/pos#orders` : `Accept or reject: ${origin}/pos#orders`,
  ].filter(x => x !== null).join('\n');
}

/** Status change → the customer. Returns null for statuses we don't notify. */
/** Which statuses message the customer (tenant setting; merchant can silence a single step with notify_customer=false). */
export function shouldNotifyCustomer(e: OrderEvent): boolean {
  if (e.order.notify_customer === false) return false;
  const stages = e.shop?.notify_stages ?? e.tenant?.notify_stages ?? ['accepted', 'ready', 'out_for_delivery', 'rejected'];
  return stages.includes(e.order.status);
}

export function customerStatus(e: OrderEvent, origin: string): string | null {
  const L = e.tenant?.default_locale ?? 'ar';
  const ar = L === 'ar';
  const o = e.order; const shop = e.shop ? t(e.shop.name, L) : '';
  const pickup = o.fulfillment === 'pickup';
  const shopWhere = [e.shop?.address, e.shop?.location ? mapUrl({ location: e.shop.location }) : ''].filter(Boolean).join(' ');
  const link = o.basket_id ? `${origin}/orders/b/${o.basket_id}` : `${origin}/orders`;
  const eta = o.eta_minutes ? (ar ? ` — الوقت المتوقع ${o.eta_minutes} دقيقة` : ` — ETA ${o.eta_minutes} min`) : '';
  const body: Record<string, string | null> = {
    accepted:         ar ? `✅ تم قبول طلبك ${o.number}: ${itemsOneLine(e, L)} — ${money(e, o.total_usd)}${pickup ? ' — استلام من المحل' : ' — توصيل'}${eta}.` : `✅ Order ${o.number} accepted: ${itemsOneLine(e, L)} — ${money(e, o.total_usd)}${pickup ? ' — pickup' : ' — delivery'}${eta}.`,
    preparing:        ar ? `👩‍🍳 ${shop} يجهّز طلبك ${o.number}.` : `👩‍🍳 ${shop} is preparing your order ${o.number}.`,
    ready:            pickup
      ? (ar ? `🛍️ طلبك ${o.number} جاهز للاستلام من ${shop}${shopWhere ? ` — ${shopWhere}` : ''}.` : `🛍️ Your order ${o.number} is ready for pickup at ${shop}${shopWhere ? ` — ${shopWhere}` : ''}.`)
      : (ar ? `📦 طلبك ${o.number} جاهز وسينطلق إليك قريباً.` : `📦 Your order ${o.number} is packed and leaving shortly.`),
    out_for_delivery: e.driver ? (ar ? `🛵 طلبك ${o.number} في الطريق مع ${e.driver.name} (${e.driver.phone}).` : `🛵 Your order ${o.number} is on its way with ${e.driver.name} (${e.driver.phone}).`)
                               : (ar ? `🛵 طلبك ${o.number} في الطريق إليك.` : `🛵 Your order ${o.number} is on its way.`),
    delivered:        ar ? `🎉 تم تسليم طلبك ${o.number} — ${money(e, o.total_usd)}. شكراً!` : `🎉 Order ${o.number} delivered — ${money(e, o.total_usd)}. Thank you!`,
    rejected:         ar ? `❌ عذراً، لم يتمكن ${shop} من قبول طلبك ${o.number}${o.reject_reason ? `: ${o.reject_reason}` : ''}.` : `❌ Sorry, ${shop} could not accept your order ${o.number}${o.reject_reason ? `: ${o.reject_reason}` : ''}.`,
    cancelled:        null,  // customer did it themselves
    pending:          null,
  };
  const text = body[o.status];
  return text ? `${text}\n${ar ? 'تابع الطلب' : 'Track'}: ${link}` : null;
}

/** Order ready → couriers (only in courier delivery mode). */
export function courierReady(e: OrderEvent, origin: string): string {
  const L = e.tenant?.default_locale ?? 'ar'; const ar = L === 'ar';
  const o = e.order; const shop = e.shop ? t(e.shop.name, L) : '';
  const shopWhere = [e.shop?.address, e.shop?.location ? mapUrl({ location: e.shop.location }) : ''].filter(Boolean).join(' ');
  const dest = [addr(o.address), mapUrl(o.address)].filter(Boolean).join(' ');
  return [
    ar ? `📦 *طلب جاهز للتوصيل ${o.number}*` : `📦 *Order ${o.number} ready for delivery*`,
    `${ar ? 'من' : 'From'}: ${shop}${shopWhere ? ` — ${shopWhere}` : ''}`,
    `${ar ? 'إلى' : 'To'}: ${o.customer_name || ''} ${o.customer_phone} ${waMe(o.customer_phone)}`.replace(/\s+/g, ' '),
    dest ? `${ar ? 'العنوان' : 'Address'}: ${dest}` : null,
    `${ar ? 'الطلب' : 'Items'}: ${itemsOneLine(e, L)} — ${ar ? 'المجموع' : 'total'} ${money(e, o.total_usd)}${Number(o.delivery_fee_usd) > 0 ? ` (${ar ? 'توصيل' : 'delivery'} ${money(e, o.delivery_fee_usd)})` : ''}`,
    o.customer_notes ? `${ar ? 'ملاحظات' : 'Notes'}: ${o.customer_notes}` : null,
    ar ? `استلمه من: ${origin}/courier` : `Take it: ${origin}/courier`,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Template variants — Meta utility templates (see docs/whatsapp-templates.md). Used when WHATSAPP_TEMPLATES=1.
// Parameters: no newlines, no runs of 4+ spaces, ≤ 1024 chars (Meta rejects otherwise).
export type Tpl = { name: string; lang: string; params: string[]; button?: string; fallback?: Tpl };
const P = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000) || '-';
const itemsOneLine = (e: OrderEvent, L: Locale) => e.items.map(i => `${i.quantity}${i.unit ? ' ' + i.unit : '×'} ${t(i.name, L)}`).join('، ');

export function shopNewOrderTpl(e: OrderEvent, origin: string): Tpl {
  const L = e.tenant?.default_locale ?? 'ar'; const o = e.order;
  return { name: 'order_new_shop', lang: 'ar', params: [P(o.number), P(e.tenant?.brand_name), P(itemsOneLine(e, L)), P(money(e, o.total_usd)), P(`${o.customer_name || ''} ${o.customer_phone} ${waMe(o.customer_phone)}`), P([addr(o.address), mapUrl(o.address)].filter(Boolean).join(' — ')), P(`${origin}/pos#orders`)] };
}
export function customerStatusTpl(e: OrderEvent, origin: string): Tpl | null {
  const text = customerStatus(e, origin); if (!text) return null;
  const o = e.order; const L = e.tenant?.default_locale ?? 'ar';
  const link = o.basket_id ? `${origin}/orders/b/${o.basket_id}` : `${origin}/r/${o.id}`;
  const shop = P(e.shop ? t(e.shop.name, L) : e.tenant?.brand_name);
  // compact template with a tracking button; the older order_status template is the fallback until v2 is approved
  return { name: 'order_update_v2', lang: 'ar', params: [shop, P(o.number), P(text.split('\n')[0])], button: o.basket_id ?? o.id,
    fallback: { name: 'order_status', lang: 'ar', params: [shop, P(o.number), P(text.split('\n')[0]), P(link)] } };
}
/** Confirmation for an order the shop typed in from the POS (WhatsApp / phone): it is already accepted, so the customer gets the accepted line. */
export function customerConfirmTpl(e: OrderEvent, origin: string): Tpl | null { return customerStatusTpl({ ...e, order: { ...e.order, status: 'accepted' } }, origin); }
export function customerConfirm(e: OrderEvent, origin: string): string | null { return customerStatus({ ...e, order: { ...e.order, status: 'accepted' } }, origin); }
/** The shop changed the order (missing item: removed / substituted / quantity) → the customer sees the new list and total. */
export function customerEdited(e: OrderEvent, origin: string): string {
  const L = e.tenant?.default_locale ?? 'ar'; const ar = L === 'ar'; const o = e.order; const shop = e.shop ? t(e.shop.name, L) : '';
  const link = o.basket_id ? `${origin}/orders/b/${o.basket_id}` : `${origin}/orders`;
  return [ar ? `✏️ تم تعديل طلبك ${o.number} من ${shop}` : `✏️ Your order ${o.number} from ${shop} was updated`, o.shop_notes ? (ar ? `السبب: ${o.shop_notes}` : `Reason: ${o.shop_notes}`) : null, '', lines(e, L), '', `*${ar ? 'الإجمالي الجديد' : 'New total'}: ${money(e, o.total_usd)}*`, '', link].filter(x => x !== null).join('\n');
}
export function customerEditedTpl(e: OrderEvent, origin: string): Tpl {
  const L = e.tenant?.default_locale ?? 'ar'; const ar = L === 'ar'; const o = e.order;
  const link = o.basket_id ? `${origin}/orders/b/${o.basket_id}` : `${origin}/orders`;
  const summary = `${ar ? '✏️ تم تعديل الطلب' : '✏️ Order updated'}${o.shop_notes ? ` (${o.shop_notes})` : ''}: ${itemsOneLine(e, L)} — ${money(e, o.total_usd)}`;
  const shop = P(e.shop ? t(e.shop.name, L) : e.tenant?.brand_name);
  return { name: 'order_update_v2', lang: 'ar', params: [shop, P(o.number), P(summary)], button: o.basket_id ?? o.id, fallback: { name: 'order_status', lang: 'ar', params: [shop, P(o.number), P(summary), P(link)] } };
}
export function courierReadyTpl(e: OrderEvent, origin: string): Tpl {
  const L = e.tenant?.default_locale ?? 'ar'; const o = e.order; const a = o.address as Record<string, unknown>;
  const shopWhere = [e.shop?.address, e.shop?.location ? mapUrl({ location: e.shop.location }) : ''].filter(Boolean).join(' ');
  return { name: 'order_ready_courier', lang: 'ar', params: [P(o.number), P(`${e.shop ? t(e.shop.name, L) : ''} ${shopWhere}`), P(`${o.customer_name || ''} ${o.customer_phone} ${waMe(o.customer_phone)} — ${[a.area ?? a.city ?? addr(o.address), mapUrl(o.address)].filter(Boolean).join(' ')} — ${itemsOneLine(e, L)} — ${money(e, o.total_usd)}`), P(`${origin}/courier`)] };
}
export function orderMessageTpl(orderNumber: string, from: string, text: string): Tpl {
  return { name: 'order_message', lang: 'ar', params: [P(orderNumber), P(from), P(text)] };
}
export const tplComponents = (tpl: Tpl) => [{ type: 'body', parameters: tpl.params.map(text => ({ type: 'text', text })) }, ...(tpl.button ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: tpl.button }] }] : [])];

/** To the shop's driver when the order is sent out with him: where to go, whom to call, what to collect. */
export function driverDispatch(e: OrderEvent, origin: string): string {
  const L = e.tenant?.default_locale ?? 'ar'; const ar = L === 'ar'; const o = e.order; const shop = e.shop ? t(e.shop.name, L) : '';
  const dest = [addr(o.address), mapUrl(o.address)].filter(Boolean).join(' ');
  const cod = o.total_usd; // POS marks COD orders unpaid until handover; the amount due is the order total
  return [
    ar ? `🛵 *طلب للتوصيل ${o.number}* — ${shop}` : `🛵 *Delivery ${o.number}* — ${shop}`,
    `${ar ? 'الزبون' : 'Customer'}: ${o.customer_name || ''} ${o.customer_phone} ${waMe(o.customer_phone)}`.replace(/\s+/g, ' '),
    dest ? `${ar ? 'العنوان' : 'Address'}: ${dest}` : null,
    `${ar ? 'الطلب' : 'Items'}: ${itemsOneLine(e, L)}`,
    `${ar ? 'المطلوب تحصيله' : 'Collect'}: ${money(e, cod)}`,
    o.customer_notes ? `${ar ? 'ملاحظات' : 'Notes'}: ${o.customer_notes}` : null,
    `${ar ? 'عند التسليم' : 'On delivery'}: ${origin}/t/${o.id}`,
  ].filter(Boolean).join('\n');
}
export function driverDispatchTpl(e: OrderEvent, origin: string): Tpl {
  const L = e.tenant?.default_locale ?? 'ar'; const o = e.order;
  const dest = [addr(o.address), mapUrl(o.address)].filter(Boolean).join(' — ');
  return { name: 'driver_dispatch', lang: 'ar', params: [P(e.shop ? t(e.shop.name, L) : e.tenant?.brand_name), P(o.number), P(`${o.customer_name || ''} ${o.customer_phone}`.trim()), P(dest || '—'), P(`${itemsOneLine(e, L)} — ${money(e, o.total_usd)}`)], button: o.id,
    fallback: { name: 'order_status', lang: 'ar', params: [P(e.shop ? t(e.shop.name, L) : e.tenant?.brand_name), P(o.number), P(`${o.customer_name || ''} ${o.customer_phone} — ${dest || ''} — ${money(e, o.total_usd)}`), P(`${origin}/t/${o.id}`)] } };
}
