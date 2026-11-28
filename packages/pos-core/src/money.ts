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
/**
 * Totals of a cart. Lines priced in lira stay in lira: their lira amounts are added up as they are and only that SUM is turned
 * into cents, so the lira total of a lira-priced cart is exactly the sum of its prices (no per-item rounding, nothing lost in a
 * round trip through cents) and paying that lira amount closes the sale. Dollar lines and discounts are converted at the rate.
 * The note step (lbpStep) rounds the final total only — `total_lbp_rounded`; step 1 = no rounding.
 */
export function totals(lines: Array<{ price_currency: Currency; unit_price_cents: number; unit_price_lbp: number; quantity: number; discount_cents?: number; voided?: boolean }>,
                       orderDiscountCents: number, rate: number, lbpStep: number): Totals {
  const live = lines.filter(l => !l.voided);
  const perLine = live.reduce((s, l) => s + lineTotalCents(l, rate), 0);
  // lira lines whose line discount does not eat the whole line (those keep the plain per-line amount)
  const lira = live.filter(l => l.price_currency !== 'usd' && lbpToCents(Math.round(l.unit_price_lbp * l.quantity), rate) >= (l.discount_cents ?? 0));
  const liraLbp = lira.reduce((s, l) => s + Math.round(l.unit_price_lbp * l.quantity), 0);
  const liraCents = lbpToCents(liraLbp, rate);
  const subtotal = Math.max(0, perLine + liraCents - lira.reduce((s, l) => s + lbpToCents(Math.round(l.unit_price_lbp * l.quantity), rate), 0));
  const discount = Math.min(subtotal, Math.max(0, orderDiscountCents));
  const total = subtotal - discount;
  const lbp = Math.max(0, liraLbp + usdToLbp(total - liraCents, rate));
  return { subtotal_cents: subtotal, discount_cents: discount, total_cents: total, total_lbp: lbp, total_lbp_rounded: roundLbp(lbp, lbpStep) };
}
/** Cents of a saved order line. A lira-priced line is worth its lira (price × quantity at the order's rate), whatever dollar price is stored next to it. */
export function orderLineCents(l: { price_currency?: Currency | null; unit_price_lbp?: number | string | null; unit_price_cents?: number | string | null; discount_cents?: number | string | null }, quantity: number, rate: number): number {
  const n = (v: unknown) => Number(v) || 0;
  const gross = l.price_currency === 'lbp' && n(l.unit_price_lbp) > 0 && rate > 0 ? lbpToCents(Math.round(n(l.unit_price_lbp) * quantity), rate) : Math.round(n(l.unit_price_cents) * quantity);
  return l.price_currency === 'lbp' && n(l.unit_price_lbp) > 0 && rate > 0 ? Math.max(0, gross - n(l.discount_cents)) : gross - n(l.discount_cents);
}
/**
 * Re-total of a saved order after an edit, a merge or a fee change — the till's copy of the server's `_order_recalc` (script 128).
 * Lira-priced lines count by their lira: they are added up in lira and only the sum is turned into cents, so the order's lira
 * total is the exact sum of its lira prices. Dollar lines keep their stored cents; discount and fee are converted at the rate.
 */
export function orderRetotal(lines: Array<{ voided?: boolean; price_currency?: Currency | null; unit_price_lbp?: number | string | null; unit_price_cents?: number | string | null; quantity: number | string; discount_cents?: number | string | null; line_total_cents?: number | string | null }>,
                             orderDiscountCents: number, feeCents: number, rate: number): { subtotal_cents: number; discount_cents: number; total_cents: number; total_lbp: number } {
  const n = (v: unknown) => Number(v) || 0;
  const live = lines.filter(l => !l.voided);
  const isLira = (l: typeof live[number]) => rate > 0 && l.price_currency === 'lbp' && n(l.unit_price_lbp) > 0;
  const cents = (l: typeof live[number]) => (isLira(l) ? orderLineCents(l, n(l.quantity), rate) : n(l.line_total_cents));
  let sub = live.reduce((s, l) => s + cents(l), 0);
  const lira = live.filter(l => isLira(l) && cents(l) > 0);                    // a line eaten whole by its discount keeps its plain amount
  const L = lira.reduce((s, l) => s + Math.round(n(l.unit_price_lbp) * n(l.quantity)), 0);
  const perLine = lira.reduce((s, l) => s + cents(l) + n(l.discount_cents), 0);
  const lc = L > 0 ? lbpToCents(L, rate) : 0;
  if (L > 0) sub = Math.max(0, sub + lc - perLine);
  const discount = Math.min(Math.max(0, orderDiscountCents), sub);
  const total = sub - discount + feeCents;
  return { subtotal_cents: sub, discount_cents: discount, total_cents: total, total_lbp: L > 0 ? Math.max(0, L + usdToLbp(total - lc, rate)) : Math.round((total * rate) / 100) };
}
/** The lira to ask for: the order's own lira total on the note step — but never an amount that, counted back in cents, leaves the order short. */
export function dueLbp(totalCents: number, totalLbp: number | null | undefined, rate: number, lbpStep: number, mode: 'nearest' | 'up' = 'up'): number {
  const viaCents = roundLbp(usdToLbp(totalCents, rate), lbpStep, mode);
  if (!totalLbp || totalLbp <= 0) return viaCents;
  const own = roundLbp(totalLbp, lbpStep, mode);
  return mode === 'up' && lbpToCents(own, rate) < totalCents ? roundLbp(usdToLbp(totalCents, rate), lbpStep, 'up') : own;
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

/**
 * An order saved as debt, then paid at handover — the till's copy of the server's rule (scripts 127 / 129): money taken now
 * (net of the change given back) comes off the order's open debt first, and "still not paid" adds only the part of the debt
 * that is not already on the order. Returns the old debt lines that changed and the new rows as they should be kept.
 */
export function payOffOrderDebt<P extends Pick<Payment, 'tender' | 'amount' | 'currency'>, N extends Pick<Payment, 'tender' | 'amount' | 'currency'>>(
  oldDebt: P[], collectedCents: number, incoming: N[], changeCents: number, rate: number): { changed: P[]; incoming: N[] } {
  const val = (p: Pick<Payment, 'amount' | 'currency'>) => (p.currency === 'lbp' ? lbpToCents(Number(p.amount) || 0, rate) : Number(p.amount) || 0);
  const cut = <T extends Pick<Payment, 'amount' | 'currency'>>(p: T, take: number): T => ({ ...p, amount: take >= val(p) ? 0 : p.currency === 'lbp' ? Number(p.amount) - usdToLbp(take, rate) : Number(p.amount) - take });
  const open = oldDebt.filter(p => p.tender === 'unpaid' && Number(p.amount) > 0);
  let debt = Math.max(0, open.reduce((s, p) => s + val(p), 0) - Math.max(0, collectedCents));
  if (debt <= 0) return { changed: [], incoming };
  const money = incoming.filter(p => p.tender !== 'unpaid').reduce((s, p) => s + val(p), 0);
  let left = money > 0 ? Math.min(debt, Math.max(0, money - Math.max(0, changeCents))) : 0;
  debt -= left;
  const changed: P[] = [];
  for (const p of [...open].reverse()) { if (left <= 0) break; const take = Math.min(left, val(p)); changed.push(cut(p, take)); left -= take; }
  const out = incoming.map(p => { if (p.tender !== 'unpaid') return p; const take = Math.min(debt, val(p)); debt -= take; return take > 0 ? cut(p, take) : p; });
  return { changed, incoming: out };
}

export const tenderCurrency = (t: Tender): Currency => (t === 'cash_lbp' ? 'lbp' : 'usd');

// Display (Western digits in both languages, like the store)
const usdFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lbpFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const fmtUsd = (cents: number): string => '$' + usdFmt.format(cents / 100);
export const fmtLbp = (lbp: number, locale: 'ar' | 'en' = 'ar'): string => lbpFmt.format(lbp) + (locale === 'ar' ? ' ل.ل.' : ' LBP');
export const fmtBoth = (cents: number, rate: number, locale: 'ar' | 'en' = 'ar'): string => `${fmtUsd(cents)} · ${fmtLbp(usdToLbp(cents, rate), locale)}`;
