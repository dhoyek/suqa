'use client';
import { fmtLbp, fmtUsd, lineTotalCents, num, roundLbp, text, usdToLbp, waDigits, type Draft, type Order, type OrderLine, type Payment, type Shop } from '@suqa/pos-core';
import { pt, type L } from '../i18n';

/**
 * The invoice as words and as a WhatsApp link, for the preview before payment (the cart) and for a finished sale.
 * WhatsApp opens on this device with the text ready (wa.me): the cashier presses send, so it works offline-first, outside the
 * 24 h window and without a Meta template. The finished invoice also has the server send (Receipt → /api/pos/receipt).
 */

/** The cart shaped as an order + lines, so the receipt printer and the text below serve both. Nothing is saved. */
export function draftAsOrder(d: Draft, rate: number, lbpStep: number, feeCents: number, totals: { subtotal_cents: number; discount_cents: number; total_cents: number }): { order: Order; lines: OrderLine[] } {
  const total = totals.total_cents + feeCents;
  const order = {
    id: d.id, number: null, local_number: null, placed_at: new Date().toISOString(), rate_lbp_per_usd: rate,
    customer_name: d.customer_name || null, customer_phone: d.customer_phone || null,
    subtotal_cents: totals.subtotal_cents, discount_cents: totals.discount_cents, discount_reason: d.discount_reason ?? null,
    total_cents: total, total_lbp: roundLbp(usdToLbp(total, rate), lbpStep), change_usd_cents: 0, change_lbp: 0,
  } as unknown as Order;
  const lines = d.lines.filter(l => !l.voided).map(l => ({
    id: l.id, order_id: d.id, product_id: l.product_id, name: l.name, unit: l.unit ?? null, quantity: l.quantity, notes: l.notes ?? null,
    price_currency: l.price_currency, unit_price_cents: l.unit_price_cents, unit_price_lbp: l.unit_price_lbp, discount_cents: l.discount_cents,
    line_total_cents: Math.max(0, lineTotalCents(l, rate)), voided: false,
  })) as unknown as OrderLine[];
  return { order, lines };
}

/** Plain text of the invoice for WhatsApp. `draft` = before payment (marked not paid, no number). */
export function invoiceText(o: Order, lines: OrderLine[], payments: Payment[] | null, shop: Shop, L: L, opts: { draft?: boolean; feeCents?: number; url?: string; lbpStep?: number } = {}): string {
  const rate = num(o.rate_lbp_per_usd);
  const rows = lines.filter(l => !l.voided).map(l => {
    const unit = l.price_currency === 'lbp' ? fmtLbp(num(l.unit_price_lbp), L) : fmtUsd(num(l.unit_price_cents));
    return `• ${num(l.quantity)}${l.unit ? ' ' + l.unit : ''} × ${text(l.name, L)} (${unit}) = ${fmtUsd(num(l.line_total_cents))}${l.notes ? `\n   » ${l.notes}` : ''}`;
  });
  const lbp = roundLbp(num(o.total_lbp) || usdToLbp(num(o.total_cents), rate), opts.lbpStep ?? shop.lbp_rounding_step ?? 5000);
  const out = [
    `🧾 ${opts.draft ? pt('draftInvoice', L) : pt('invoice', L) + ' ' + (o.number ?? o.local_number ?? '')} — ${text(shop.name, L)}`,
    ...(opts.draft ? [`⚠️ ${pt('notPaidYet', L)}`] : []),
    '',
    ...rows,
    '',
    ...(num(o.discount_cents) ? [`${pt('discount', L)}: −${fmtUsd(num(o.discount_cents))}`] : []),
    ...(opts.feeCents ? [`${pt('deliveryFee', L)}: ${fmtUsd(opts.feeCents)}`] : []),
    `${pt('total', L)}: ${fmtUsd(num(o.total_cents))} · ${fmtLbp(lbp, L)}`,
    `${pt('rate', L)}: $1 = ${rate.toLocaleString('en-US')} ل.ل.`,
    ...(payments?.length ? [payments.map(p => `${pt(p.tender, L)}: ${p.currency === 'lbp' ? fmtLbp(num(p.amount), L) : fmtUsd(num(p.amount))}`).join(' + ')] : []),
    ...(opts.url ? ['', opts.url] : []),
    ...(shop.receipt_footer ? ['', shop.receipt_footer] : []),
  ];
  return out.join('\n');
}

/** wa.me link: to the customer's number when the cart has one, otherwise WhatsApp asks whom to send it to. */
export const waHref = (phone: string | null | undefined, body: string) =>
  `https://wa.me/${phone && phone.replace(/\D/g, '').length >= 6 ? waDigits(phone) : ''}?text=${encodeURIComponent(body)}`;
