import type { Locale, LocalizedText } from './types';
export const RTL: Record<Locale, boolean> = { ar: true, en: false, fr: false };
export function t(text: LocalizedText | null | undefined, locale: Locale, fallback: Locale = 'en'): string {
  if (!text) return '';
  return text[locale] ?? text[fallback] ?? Object.values(text)[0] ?? '';
}
