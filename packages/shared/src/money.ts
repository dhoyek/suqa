import type { DisplayCurrency } from './types';

export function toLbp(usd: number, rate: number): number { return Math.round((usd * rate) / 1000) * 1000; }

export function formatMoney(usd: number, rate: number, mode: DisplayCurrency, locale = 'en'): string {
  const u = new Intl.NumberFormat(locale === 'ar' ? 'ar-LB' : 'en-US', { style: 'currency', currency: 'USD' }).format(usd);
  const l = new Intl.NumberFormat(locale === 'ar' ? 'ar-LB' : 'en-US', { maximumFractionDigits: 0 }).format(toLbp(usd, rate)) + ' LBP';
  return mode === 'usd' ? u : mode === 'lbp' ? l : `${u} · ${l}`;
}
