// Pure (no server-only import), so it is tested as is.
import type { Turn } from './model';

/** The conversation so far is read again on every model call of a message (search → draft → answer is three calls). Marking the
 *  last block lets calls two and three read everything before it at the cache price (a twentieth) instead of full price; the
 *  first call pays a quarter more to write it. Measured on prod on 22 Nov 2026: 2.4 calls per WhatsApp message, all at full price.
 *  Only a text or tool-result block can carry the mark; the messages themselves are not changed. */
export function withCacheMark(messages: Turn[]): unknown[] {
  const last = messages.length - 1;
  return messages.map((m, i) => {
    if (i !== last || !m.content.length) return m;
    const k = m.content.length - 1, b = m.content[k];
    if (b.type !== 'text' && b.type !== 'tool_result') return m;
    return { ...m, content: [...m.content.slice(0, k), { ...b, cache_control: { type: 'ephemeral' } }] };
  });
}
