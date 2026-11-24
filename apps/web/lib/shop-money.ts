import { toLbp, type DisplayCurrency } from '@suqa/shared';

// Lira on the customer side is worked out at the SHOP's own rate (script 103): the shop sets it in its POS. A shop that has
// none uses the association's. `Rates` is what suqa.shop_rates gives: { shop id: lira per dollar }.
export type Rates = Record<string, number>;
export const rateOf = (rates: Rates | null | undefined, shopId: string | null | undefined, fx: number | string | null | undefined): number =>
  Number((shopId && rates?.[shopId]) || 0) || Number(fx ?? 0);

/** A sum made of several shops' amounts: the dollars are added up; the lira is each shop's part at its own rate, added up —
 *  so the total a customer reads is the sum of what each shop will ask for. Same look as formatMoney. */
export function formatMoneySum(parts: { usd: number; rate: number }[], mode: DisplayCurrency, locale = 'en'): string {
  const usd = Math.round(parts.reduce((s, p) => s + p.usd, 0) * 100) / 100;
  const lbp = parts.reduce((s, p) => s + toLbp(p.usd, p.rate), 0);
  const u = '$' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd);
  const l = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(lbp) + (locale === 'ar' ? ' ل.ل.' : ' LBP');
  return mode === 'usd' ? u : mode === 'lbp' ? l : `${u} · ${l}`;
}
