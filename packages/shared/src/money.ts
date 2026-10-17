import type { DisplayCurrency } from './types';

export function toLbp(usd: number, rate: number): number { return Math.round((usd * rate) / 1000) * 1000; }

// Lebanese shoppers read Western digits for prices ("$1.25", "112,000 LBP") even in Arabic UI,
// so Arabic uses the Latin numbering system (ar-LB-u-nu-latn) and a plain "$" sign.
export function formatMoney(usd: number, rate: number, mode: DisplayCurrency, locale = 'en'): string {
  const u = '$' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd);
  const l = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(toLbp(usd, rate)) + (locale === 'ar' ? ' ل.ل.' : ' LBP');
  return mode === 'usd' ? u : mode === 'lbp' ? l : `${u} · ${l}`;
}
