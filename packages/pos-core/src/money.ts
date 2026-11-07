import type { Currency, Payment, Tender } from './types';

// All arithmetic on integers: cents (USD) and pounds (LBP). `rate` = LBP per 1 USD.

export const usdToLbp = (cents: number, rate: number): number => Math.round((cents * rate) / 100);
export const lbpToCents = (lbp: number, rate: number): number => Math.round((lbp * 100) / rate);

/** Round LBP to usable notes (step 1000 / 5000 / 10000). mode: 'nearest' for amounts due, 'down' for change given. */
export function roundLbp(lbp: number, step: number, mode: 'nearest' | 'down' | 'up' = 'nearest'): number {
  if (!step || step <= 1) return Math.round(lbp);
  const q = lbp / step;
  const n = mode === 'down' ? Math.floor(q) : mode === 'up' ? Math.ceil(q) : Math.round(q);
  return n * step;
}

/** Price of a line in cents, given its currency and the rate. qty may be fractional (weighed items). */
export function lineTotalCents(l: { price_currency: Currency; unit_price_cents: number; unit_price_lbp: number; quantity: number; discount_cents?: number }, rate: number): number {
  const gross = l.price_currency === 'usd' ? Math.round(l.unit_price_cents * l.quantity) : lbpToCents(Math.round(l.unit_price_lbp * l.quantity), rate);
  return Math.max(0, gross - (l.discount_cents ?? 0));
}

export interface Totals { subtotal_cents: number; discount_cents: number; total_cents: number; total_lbp: number; total_lbp_rounded: number }
export function totals(lines: Array<{ price_currency: Currency; unit_price_cents: number; unit_price_lbp: number; quantity: number; discount_cents?: number; voided?: boolean }>,
                       orderDiscountCents: number, rate: number, lbpStep: number): Totals {
  const subtotal = lines.filter(l => !l.voided).reduce((s, l) => s + lineTotalCents(l, rate), 0);
  const discount = Math.min(subtotal, Math.max(0, orderDiscountCents));
  const total = subtotal - discount;
  const lbp = usdToLbp(total, rate);
  return { subtotal_cents: subtotal, discount_cents: discount, total_cents: total, total_lbp: lbp, total_lbp_rounded: roundLbp(lbp, lbpStep) };
}

/** USD-equivalent cents a payment contributes. 'unpaid' contributes nothing paid. */
export function paymentCents(p: Pick<Payment, 'tender' | 'amount' | 'currency'>, rate: number): number {
  if (p.tender === 'unpaid') return 0;
  return p.currency === 'lbp' ? lbpToCents(p.amount, rate) : p.amount;
}

export interface Settlement {
  paid_cents: number;           // USD-equivalent paid (all tenders except unpaid)
  paid_usd_cents: number;       // cash USD + card + wallet in USD
  paid_lbp: number;             // cash LBP
  remaining_cents: number;      // > 0 → still due (or to be marked unpaid)
  change_cents: number;         // > 0 → give back
  change_usd_cents: number;
  change_lbp: number;           // rounded DOWN to the note step
  unpaid_cents: number;
}
/** Settle an order: given tenders, what remains, what change in the chosen currency. */
export function settle(total_cents: number, payments: Array<Pick<Payment, 'tender' | 'amount' | 'currency'>>, rate: number, lbpStep: number, changeIn: Currency): Settlement {
  const paid = payments.reduce((s, p) => s + paymentCents(p, rate), 0);
  const paid_usd_cents = payments.filter(p => p.tender !== 'unpaid' && p.currency === 'usd').reduce((s, p) => s + p.amount, 0);
  const paid_lbp = payments.filter(p => p.tender !== 'unpaid' && p.currency === 'lbp').reduce((s, p) => s + p.amount, 0);
  const unpaid_cents = payments.filter(p => p.tender === 'unpaid').reduce((s, p) => s + (p.currency === 'lbp' ? lbpToCents(p.amount, rate) : p.amount), 0);
  const diff = paid + unpaid_cents - total_cents;
  const remaining = diff < 0 ? -diff : 0;
  const change = diff > 0 ? diff : 0;
  const change_lbp = changeIn === 'lbp' ? roundLbp(usdToLbp(change, rate), lbpStep, 'down') : 0;
  const change_usd_cents = changeIn === 'usd' ? change : 0;
  return { paid_cents: paid, paid_usd_cents, paid_lbp, remaining_cents: remaining, change_cents: change, change_usd_cents, change_lbp, unpaid_cents };
}

export const tenderCurrency = (t: Tender): Currency => (t === 'cash_lbp' ? 'lbp' : 'usd');

// Display (Western digits in both languages, like the store)
const usdFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lbpFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const fmtUsd = (cents: number): string => '$' + usdFmt.format(cents / 100);
export const fmtLbp = (lbp: number, locale: 'ar' | 'en' = 'ar'): string => lbpFmt.format(lbp) + (locale === 'ar' ? ' ل.ل.' : ' LBP');
export const fmtBoth = (cents: number, rate: number, locale: 'ar' | 'en' = 'ar'): string => `${fmtUsd(cents)} · ${fmtLbp(usdToLbp(cents, rate), locale)}`;
