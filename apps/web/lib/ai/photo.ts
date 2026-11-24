// Task 'photo_read': a photo of one item in, a suggested catalog card out (names, short description, category, barcode), with
// what it cost. A SUGGESTION only: the person checks it in the item editor and saves; nothing is written from here.
// Pure: the provider call and the key are passed in, so it is tested as is.
import { googleReadPhoto, type PhotoUsage } from './google';
import type { Route } from './routes';

export const PHOTO_MAX_BYTES = 3 * 1024 * 1024;      // the app shrinks the picture before sending; this is the server's own limit
export type ItemCard = { name_ar: string; name_en: string; description_ar: string; description_en: string; category: string; barcode: string };
export type PhotoResult =
  | { status: 'ok'; card: ItemCard; model: string; cost_usd: number; input_tokens: number; output_tokens: number; ms: number }
  | { status: 'nothing'; model: string; cost_usd: number; input_tokens: number; output_tokens: number; ms: number }      // no product to name: paid for, nothing to fill
  | { status: 'too_big' }
  | { status: 'failed'; error: string };

/** Cost in USD from the route's own prices. A missing price is charged at the dearest the route has: the caps must never under-count. */
export function photoCost(route: Pick<Route, 'price_in_per_m' | 'price_out_per_m' | 'price_per_image'>, u: PhotoUsage): number {
  const known = [route.price_in_per_m, route.price_out_per_m].filter((x): x is number => x != null);
  const top = known.length ? Math.max(...known) : 0;
  const usd = (u.input_tokens * (route.price_in_per_m ?? top) + u.output_tokens * (route.price_out_per_m ?? top)) / 1_000_000 + (route.price_per_image ?? 0);
  return Math.round(usd * 1e6) / 1e6;
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** The model's answer → a card. Takes the first {...} in the text (models like to wrap JSON in a code fence). null = not a card. */
export function parseCard(text: string, categories: string[] = []): ItemCard | null {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j: Record<string, unknown>; try { j = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>; } catch { return null; }
  const cat = clean(j.category, 80); const known = categories.find(c => c.toLowerCase() === cat.toLowerCase());
  const digits = clean(j.barcode, 20).replace(/\D/g, '');
  return {
    name_ar: clean(j.name_ar, 120), name_en: clean(j.name_en, 120), description_ar: clean(j.description_ar, 300), description_en: clean(j.description_en, 300),
    category: known ?? '',                                             // only a category of the list, as the list spells it
    barcode: [8, 12, 13, 14].includes(digits.length) ? digits : '',      // a whole barcode or none
  };
}

type Read = (o: { key: string; model: string; image: Uint8Array; mime: string; categories?: string[] }) => Promise<{ text: string; usage: PhotoUsage }>;
export async function runItemPhoto(route: Route, key: string, image: Uint8Array, mime: string, categories: string[] = [], read: Read = googleReadPhoto, now: () => number = Date.now): Promise<PhotoResult> {
  if (image.length > PHOTO_MAX_BYTES) return { status: 'too_big' };
  const tries = [{ provider: route.provider, model: route.model }, ...(route.fallback_provider && route.fallback_model ? [{ provider: route.fallback_provider, model: route.fallback_model }] : [])]
    .filter(t => t.provider === 'google');                                                     // the provider this reader is written for
  if (!tries.length) return { status: 'failed', error: 'no_photo_provider' };
  let last = 'photo_failed'; const t0 = now();
  for (const t of tries) {
    try {
      const r = await read({ key, model: t.model, image, mime, categories });
      const base = { model: t.model, cost_usd: photoCost(route, r.usage), ...r.usage, ms: now() - t0 };
      const card = parseCard(r.text, categories);
      if (!card || !(card.name_ar || card.name_en)) return { status: 'nothing', ...base };
      return { status: 'ok', card, ...base };
    } catch (e) { last = String((e as Error).message ?? e).slice(0, 200); }
  }
  return { status: 'failed', error: last };
}
