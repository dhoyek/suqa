// Which provider and model does which task (script 100, suqa.yorgo_ai_routes). Pure: the reader is passed in, so it is tested as is.
// Keys are never in the table: each provider's key is a secret of the site (GOOGLE_AI_API_KEY, ANTHROPIC_API_KEY).
export type Task = 'chat' | 'voice' | 'photo_read' | 'image_generate' | 'image_cleanup' | 'bulk_cleanup';
export type Provider = 'anthropic' | 'google';
export type Route = {
  task: Task; provider: Provider; model: string; fallback_provider: Provider | null; fallback_model: string | null; enabled: boolean;
  price_in_per_m: number | null; price_out_per_m: number | null; price_audio_per_m: number | null; price_per_image: number | null; notes?: string | null;
};
export const ROUTE_COLUMNS = 'task,provider,model,fallback_provider,fallback_model,enabled,price_in_per_m,price_out_per_m,price_audio_per_m,price_per_image,notes';

const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export function toRoute(r: Record<string, unknown>): Route {
  return {
    task: r.task as Task, provider: r.provider as Provider, model: String(r.model ?? ''), fallback_provider: (r.fallback_provider as Provider | null) ?? null, fallback_model: (r.fallback_model as string | null) ?? null,
    enabled: r.enabled === true, price_in_per_m: num(r.price_in_per_m), price_out_per_m: num(r.price_out_per_m), price_audio_per_m: num(r.price_audio_per_m), price_per_image: num(r.price_per_image), notes: (r.notes as string | null) ?? null,
  };
}

/** What one transcription used, as the provider reports it. */
export type VoiceUsage = { audio_tokens: number; text_tokens: number; output_tokens: number };
/** Cost in USD from the route's own prices. A missing price is charged at the dearest price the route has: the caps must never under-count. */
export function voiceCost(route: Pick<Route, 'price_in_per_m' | 'price_out_per_m' | 'price_audio_per_m'>, u: VoiceUsage): number {
  const known = [route.price_in_per_m, route.price_out_per_m, route.price_audio_per_m].filter((x): x is number => x != null);
  const top = known.length ? Math.max(...known) : 0;
  const usd = (u.audio_tokens * (route.price_audio_per_m ?? top) + u.text_tokens * (route.price_in_per_m ?? top) + u.output_tokens * (route.price_out_per_m ?? top)) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/** The route of one task, read with the service role and kept 60 s. null = not installed, or no such row. */
type Reader = (task: Task) => Promise<Record<string, unknown> | null>;
const cache = new Map<Task, { at: number; route: Route | null }>();
export async function loadRoute(task: Task, read: Reader, now = Date.now()): Promise<Route | null> {
  const hit = cache.get(task);
  if (hit && now - hit.at < 60_000) return hit.route;
  let route: Route | null = null;
  try { const r = await read(task); route = r ? toRoute(r) : null; } catch { route = null; }
  cache.set(task, { at: now, route });
  return route;
}
export const forgetRoutes = () => cache.clear();
