// Task 'voice': audio in, the customer's own words out, with what it cost. One entry point for the webhook and the admin Test button.
// The primary model first; if it fails and the route has a fallback, the fallback once. Pure: provider call and key are passed in.
import { googleTranscribe, VOICE_NONE, type Heard } from './google';
import { voiceCost, type Route } from './routes';

export const VOICE_MAX_SECONDS = 120;          // agreed with Dan: 2 minutes
export const VOICE_MAX_BYTES = 2 * 1024 * 1024;

/** Length of an Ogg (Opus) file in seconds, from its last page: the granule position counts 48 kHz samples. null = not Ogg / cannot tell. */
export function oggSeconds(b: Uint8Array): number | null {
  for (let i = b.length - 27; i >= 0; i--) {
    if (b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53) {      // "OggS"
      let g = 0; for (let k = 7; k >= 0; k--) g = g * 256 + b[i + 6 + k];                       // 64-bit little-endian (a voice note stays far below 2^53)
      if (b.slice(i + 6, i + 14).every(x => x === 0xff)) continue;                              // a page with no finished packet: look further back
      return g > 0 ? g / 48000 : null;
    }
  }
  return null;
}

export type VoiceResult =
  | { status: 'ok'; text: string; model: string; cost_usd: number; audio_tokens: number; text_tokens: number; output_tokens: number; ms: number; hint?: 'used' | 'refused' }
  | { status: 'nothing'; model: string; cost_usd: number; audio_tokens: number; text_tokens: number; output_tokens: number; ms: number; hint?: 'used' | 'refused' }      // silence, noise, music: paid for, nothing to draft
  | { status: 'too_long' }
  | { status: 'failed'; error: string };

type Transcribe = (o: { key: string; model: string; audio: Uint8Array; mime: string }) => Promise<Heard>;

export async function runVoice(route: Route, key: string, audio: Uint8Array, mime: string, transcribe: Transcribe = googleTranscribe, now: () => number = Date.now): Promise<VoiceResult> {
  if (audio.length > VOICE_MAX_BYTES) return { status: 'too_long' };
  const secs = oggSeconds(audio);
  if (secs != null && secs > VOICE_MAX_SECONDS + 2) return { status: 'too_long' };
  const tries = [{ provider: route.provider, model: route.model }, ...(route.fallback_provider && route.fallback_model ? [{ provider: route.fallback_provider, model: route.fallback_model }] : [])]
    .filter(t => t.provider === 'google');                                                     // the only provider that takes sound today
  if (!tries.length) return { status: 'failed', error: 'no_voice_provider' };
  let last = 'voice_failed'; const t0 = now();
  for (const t of tries) {
    try {
      const h = await transcribe({ key, model: t.model, audio, mime });
      const cost = voiceCost(route, h.usage); const base = { model: t.model, cost_usd: cost, ...h.usage, ms: now() - t0, ...(h.hint ? { hint: h.hint } : {}) };
      // the provider's own count is the last word on length (32 audio tokens a second)
      if (h.usage.audio_tokens > (VOICE_MAX_SECONDS + 10) * 32) return { status: 'too_long' };
      const text = h.text.replace(/\s+/g, ' ').trim();
      if (!text || text.toUpperCase().includes(VOICE_NONE) || !/[\p{L}\p{N}]/u.test(text)) return { status: 'nothing', ...base };
      return { status: 'ok', text: text.slice(0, 2000), ...base };
    } catch (e) { last = (e as Error).message.slice(0, 160); }
  }
  return { status: 'failed', error: last };
}
