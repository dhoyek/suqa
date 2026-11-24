// Task 'image_cleanup': an item photo in, the same item on a clean white background out, with what it cost.
// A SUGGESTION only: the screen shows it next to the original and a person chooses; nothing is saved from here.
// The model redraws the picture (it can change small print), which is why the choice is never made for the person.
import { googleCleanImage, type CleanUsage } from './google';
import { photoCost } from './photo';
import type { Route } from './routes';

export const CLEAN_MAX_BYTES = 3 * 1024 * 1024;
export type CleanResult =
  | { status: 'ok'; image: Uint8Array; mime: string; model: string; cost_usd: number; input_tokens: number; output_tokens: number; ms: number }
  | { status: 'too_big' }
  | { status: 'failed'; error: string };

type Clean = (o: { key: string; model: string; image: Uint8Array; mime: string }) => Promise<{ image: Uint8Array; mime: string; usage: CleanUsage }>;
export async function runImageCleanup(route: Route, key: string, image: Uint8Array, mime: string, clean: Clean = googleCleanImage, now: () => number = Date.now): Promise<CleanResult> {
  if (image.length > CLEAN_MAX_BYTES) return { status: 'too_big' };
  const tries = [{ provider: route.provider, model: route.model }, ...(route.fallback_provider && route.fallback_model ? [{ provider: route.fallback_provider, model: route.fallback_model }] : [])]
    .filter(t => t.provider === 'google');
  if (!tries.length) return { status: 'failed', error: 'no_image_provider' };
  let last = 'clean_failed'; const t0 = now();
  for (const t of tries) {
    try {
      const r = await clean({ key, model: t.model, image, mime });
      return { status: 'ok', image: r.image, mime: r.mime, model: t.model, cost_usd: photoCost(route, r.usage), ...r.usage, ms: now() - t0 };
    } catch (e) { last = String((e as Error).message ?? e).slice(0, 200); }
  }
  return { status: 'failed', error: last };
}
