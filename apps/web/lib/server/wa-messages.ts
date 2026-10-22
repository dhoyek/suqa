import { formatMoney, t, type Locale, type LocalizedText, type DisplayCurrency } from '@suqa/shared';

// Message copy for order notifications. Arabic first for 'ar' tenants, English otherwise.
// Dev: sent as plain text. Production: the same wording goes into Meta utility templates (see docs).
export type OrderEvent = {
  event: 'order.created' | 'order.status';
  old_status?: string | null;
  order: { id: string; number: string; status: string; basket_id?: string | null; customer_name: string; customer_phone: string; customer_notes?: string | null;
    address: Record<string, unknown>; subtotal_usd: number; delivery_fee_usd: number; total_usd: number; fx_lbp_rate: number;
    reject_reason?: string | null; eta_minutes?: number | null; shop_notes?: string | null; courier_id?: string | null };
  items: { name: LocalizedText; unit?: string | null; quantity: number; line_total_usd: number; notes?: string | null }[];
  shop: { id: string; slug: string; name: LocalizedText; whatsapp?: string | null; phone?: string | null } | null;
  tenant: { id: string; slug: string; brand_name: string; default_locale: Locale; display_currency: DisplayCurrency; courier_enabled: boolean; delivery_mode: 'per_shop' | 'courier' } | null;
  courier_phone?: string | null;
  couriers: string[];
};

const addr = (a: Record<string, unknown>) => [a.label, a.street, a.building, a.floor, a.area, a.city, a.notes].filter(Boolean).join(', ');
const lines = (e: OrderEvent, L: Locale) => e.items.map(i => `• ${i.quantity}${i.unit ? ' ' + i.unit : '×'} ${t(i.name, L)}${i.notes ? ` (${i.notes})` : ''}`).join('\n');
const money = (e: OrderEvent, usd: number) => formatMoney(Number(usd), Number(e.order.fx_lbp_rate), e.tenant?.display_currency ?? 'both', e.tenant?.default_locale ?? 'en');

/** New order → the shop. */
export function shopNewOrder(e: OrderEvent, origin: string): string {
  const L = e.tenant?.default_locale ?? 'ar';
  const o = e.order;
  const ar = L === 'ar';
  return [
    ar ? `🛒 *طلب جديد ${o.number}* — ${e.tenant?.brand_name ?? ''}` : `🛒 *New order ${o.number}* — ${e.tenant?.brand_name ?? ''}`,
    '',
    lines(e, L),
    '',
    `${ar ? 'المجموع' : 'Subtotal'}: ${money(e, o.subtotal_usd)}`,
    Number(o.delivery_fee_usd) > 0 ? `${ar ? 'التوصيل' : 'Delivery'}: ${money(e, o.delivery_fee_usd)}` : null,
    `*${ar ? 'الإجمالي' : 'Total'}: ${money(e, o.total_usd)}*`,
    '',
    `${ar ? 'العميل' : 'Customer'}: ${o.customer_name} — ${o.customer_phone}`,
    `${ar ? 'العنوان' : 'Address'}: ${addr(o.address)}`,
    o.customer_notes ? `${ar ? 'ملاحظات' : 'Notes'}: ${o.customer_notes}` : null,
    '',
    ar ? `للقبول أو الرفض: ${origin}/shop` : `Accept or reject: ${origin}/shop`,
  ].filter(x => x !== null).join('\n');
}

/** Status change → the customer. Returns null for statuses we don't notify. */
export function customerStatus(e: OrderEvent, origin: string): string | null {
  const L = e.tenant?.default_locale ?? 'ar';
  const ar = L === 'ar';
  const o = e.order; const shop = e.shop ? t(e.shop.name, L) : '';
  const link = o.basket_id ? `${origin}/orders/b/${o.basket_id}` : `${origin}/orders`;
  const eta = o.eta_minutes ? (ar ? ` — الوقت المتوقع ${o.eta_minutes} دقيقة` : ` — ETA ${o.eta_minutes} min`) : '';
  const body: Record<string, string | null> = {
    accepted:         ar ? `✅ تم قبول طلبك ${o.number} من ${shop}${eta}.` : `✅ ${shop} accepted your order ${o.number}${eta}.`,
    preparing:        ar ? `👩‍🍳 ${shop} يجهّز طلبك ${o.number}.` : `👩‍🍳 ${shop} is preparing your order ${o.number}.`,
    ready:            ar ? `📦 طلبك ${o.number} جاهز وسيُسلَّم قريباً.` : `📦 Your order ${o.number} is ready and will be delivered shortly.`,
    out_for_delivery: ar ? `🛵 طلبك ${o.number} في الطريق إليك.` : `🛵 Your order ${o.number} is on its way.`,
    delivered:        ar ? `🎉 تم تسليم طلبك ${o.number}. شكراً لدعمك متاجر البلدة!` : `🎉 Your order ${o.number} was delivered. Thank you for supporting local shops!`,
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
  const o = e.order; const a = o.address as Record<string, unknown>;
  return ar
    ? `📦 طلب جاهز للتوصيل ${o.number} من ${e.shop ? t(e.shop.name, L) : ''} → ${a.area ?? a.city ?? ''}\nاستلمه من: ${origin}/courier`
    : `📦 Order ${o.number} ready for pickup at ${e.shop ? t(e.shop.name, L) : ''} → ${a.area ?? a.city ?? ''}\nTake it: ${origin}/courier`;
}

// ---------------------------------------------------------------------------------------------
// Template variants — Meta utility templates (see docs/whatsapp-templates.md). Used when WHATSAPP_TEMPLATES=1.
// Parameters: no newlines, no runs of 4+ spaces, ≤ 1024 chars (Meta rejects otherwise).
export type Tpl = { name: string; lang: string; params: string[] };
const P = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000) || '-';
const itemsOneLine = (e: OrderEvent, L: Locale) => e.items.map(i => `${i.quantity}${i.unit ? ' ' + i.unit : '×'} ${t(i.name, L)}`).join('، ');

export function shopNewOrderTpl(e: OrderEvent, origin: string): Tpl {
  const L = e.tenant?.default_locale ?? 'ar'; const o = e.order;
  return { name: 'order_new_shop', lang: 'ar', params: [P(o.number), P(e.tenant?.brand_name), P(itemsOneLine(e, L)), P(money(e, o.total_usd)), P(`${o.customer_name} ${o.customer_phone}`), P(addr(o.address) || '📍'), P(`${origin}/shop`)] };
}
export function customerStatusTpl(e: OrderEvent, origin: string): Tpl | null {
  const text = customerStatus(e, origin); if (!text) return null;
  const o = e.order; const L = e.tenant?.default_locale ?? 'ar';
  const link = o.basket_id ? `${origin}/orders/b/${o.basket_id}` : `${origin}/orders`;
  return { name: 'order_status', lang: 'ar', params: [P(e.shop ? t(e.shop.name, L) : e.tenant?.brand_name), P(o.number), P(text.split('\n')[0]), P(link)] };
}
export function courierReadyTpl(e: OrderEvent, origin: string): Tpl {
  const L = e.tenant?.default_locale ?? 'ar'; const o = e.order; const a = o.address as Record<string, unknown>;
  return { name: 'order_ready_courier', lang: 'ar', params: [P(o.number), P(e.shop ? t(e.shop.name, L) : ''), P(a.area ?? a.city ?? addr(o.address)), P(`${origin}/courier`)] };
}
export function orderMessageTpl(orderNumber: string, from: string, text: string): Tpl {
  return { name: 'order_message', lang: 'ar', params: [P(orderNumber), P(from), P(text)] };
}
export const tplComponents = (tpl: Tpl) => [{ type: 'body', parameters: tpl.params.map(text => ({ type: 'text', text })) }];
