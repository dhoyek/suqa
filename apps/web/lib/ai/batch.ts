// Google batch mode for 'image_cleanup' — a TEST helper (Dan, 25 Nov 2026: "test on dev first").
// Batch is half the normal price and answers later (Google's target: within 24 h). It exists only on the older
// generateContent API (Google's batch page, read 25 Nov 2026), so the request here is shaped for that API, not Interactions.
// Pure: the fetch is passed in, so it is tested as is. The key is the site's GOOGLE_AI_API_KEY; it is never stored or returned.
import { CLEANUP_PROMPT, bareMime } from './google';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
export type BatchPhoto = { key: string; image: Uint8Array; mime: string };

/** One inline batch request per photo: the same instruction as the live button, a square 1K picture back. */
export function batchBody(photos: BatchPhoto[], name: string) {
  return {
    batch: {
      display_name: name,
      input_config: {
        requests: {
          requests: photos.map(p => ({
            request: {
              contents: [{ role: 'user', parts: [{ text: CLEANUP_PROMPT }, { inline_data: { mime_type: bareMime(p.mime) || 'image/jpeg', data: Buffer.from(p.image).toString('base64') } }] }],
              generation_config: { response_modalities: ['IMAGE'], image_config: { aspect_ratio: '1:1', image_size: '1K' } },
            },
            metadata: { key: p.key },
          })),
        },
      },
    },
  };
}

/** Sends the batch; answers Google's job name (e.g. "batches/123"). */
export async function createCleanupBatch(o: { key: string; model: string; photos: BatchPhoto[]; name: string; fetch?: FetchLike }): Promise<string> {
  const f = o.fetch ?? (fetch as unknown as FetchLike);
  const res = await f(`${BASE}/models/${encodeURIComponent(o.model)}:batchGenerateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': o.key, 'content-type': 'application/json' },
    body: JSON.stringify(batchBody(o.photos, o.name)), signal: AbortSignal.timeout(55_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`batch_http_${res.status}: ${raw.slice(0, 400)}`);
  let j: { name?: string }; try { j = JSON.parse(raw); } catch { throw new Error('batch_bad_json'); }
  if (!j.name || !/^batches\/[\w-]+$/.test(j.name)) throw new Error(`batch_no_name: ${raw.slice(0, 200)}`);
  return j.name;
}

export type BatchItem = { key: string; image?: { data: Uint8Array; mime: string }; input_tokens: number; output_tokens: number; error?: string };
export type BatchState = { state: string; done: boolean; items: BatchItem[] };

type Part = { inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } };
type Inlined = { metadata?: { key?: string }; key?: string; error?: { message?: string }; response?: { candidates?: { content?: { parts?: Part[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } } };
type Job = { done?: boolean; state?: string; metadata?: { state?: string; output?: { inlinedResponses?: { inlinedResponses?: Inlined[] } } }; response?: { inlinedResponses?: { inlinedResponses?: Inlined[] } | Inlined[] }; dest?: { inlinedResponses?: Inlined[] }; error?: { message?: string } };

/** Google's job answer → state and pictures. The docs show the state and the results at more than one place, so every
 *  documented place is read (metadata.state or state; response.inlinedResponses, metadata.output or dest). */
export function readBatch(j: Job): BatchState {
  const state = j.metadata?.state ?? j.state ?? (j.error ? 'JOB_STATE_FAILED' : 'UNKNOWN');
  const nest = (x: unknown): Inlined[] | undefined => Array.isArray(x) ? x as Inlined[] : (x as { inlinedResponses?: Inlined[] } | undefined)?.inlinedResponses;
  const list = nest(j.response?.inlinedResponses) ?? nest(j.metadata?.output?.inlinedResponses) ?? j.dest?.inlinedResponses ?? [];
  const items = list.map((r, i): BatchItem => {
    const u = r.response?.usageMetadata;
    const part = (r.response?.candidates?.[0]?.content?.parts ?? []).map(p => p.inlineData ? { data: p.inlineData.data, mime: p.inlineData.mimeType } : p.inline_data ? { data: p.inline_data.data, mime: p.inline_data.mime_type } : null).filter(p => p?.data).pop();
    return {
      key: r.metadata?.key ?? r.key ?? String(i),
      ...(part?.data ? { image: { data: new Uint8Array(Buffer.from(part.data, 'base64')), mime: part.mime || 'image/jpeg' } } : {}),
      input_tokens: u?.promptTokenCount ?? 0, output_tokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      ...(r.error ? { error: String(r.error.message ?? 'error').slice(0, 200) } : !part?.data ? { error: 'no_image' } : {}),
    };
  });
  return { state, done: j.done === true || /SUCCEEDED|FAILED|CANCELLED|EXPIRED/.test(state), items };
}

export async function getCleanupBatch(o: { key: string; name: string; fetch?: FetchLike }): Promise<BatchState> {
  if (!/^batches\/[\w-]+$/.test(o.name)) throw new Error('batch_bad_name');
  const f = o.fetch ?? (fetch as unknown as FetchLike);
  const res = await f(`${BASE}/${o.name}`, { method: 'GET', headers: { 'x-goog-api-key': o.key }, signal: AbortSignal.timeout(30_000) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`batch_http_${res.status}: ${raw.slice(0, 400)}`);
  try { return readBatch(JSON.parse(raw)); } catch { throw new Error('batch_bad_json'); }
}
