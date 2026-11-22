import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// WhatsApp Cloud API — server side only. Secrets live in Netlify env vars:
//   WHATSAPP_TOKEN        permanent system-user token (sending)
//   WHATSAPP_PHONE_ID     phone number id of the sending number
//   WHATSAPP_VERIFY_TOKEN shared secret Meta echoes when verifying the webhook URL
//   WHATSAPP_APP_SECRET   app secret, used to check X-Hub-Signature-256 on incoming webhooks
const GRAPH = 'https://graph.facebook.com/v21.0';

export const waConfigured = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

/** Plain text message (allowed inside a 24h customer window, and always to test recipients). */
export async function waSendText(to: string, body: string, from?: string | null) {
  return waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } }, from);
}

/** Approved template message (business-initiated). components follow Meta's template payload format. */
export async function waSendTemplate(to: string, name: string, lang: string, components?: unknown[], from?: string | null) {
  return waPost({ messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code: lang }, components } }, from);
}

/** `from` = Meta phone number id to send from (a shop's or tenant's own number); defaults to the platform number. */
async function waPost(payload: Record<string, unknown>, from?: string | null) {
  if (!waConfigured()) throw new Error('whatsapp_not_configured');
  const res = await fetch(`${GRAPH}/${from || process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`whatsapp_error ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return json as { messages?: { id: string }[] };
}

/** An inbound media file (a voice note), read into memory: Meta gives a short-lived URL for the media id, then the bytes — both with our token.
 *  Nothing is written anywhere. null when Meta has no such file; `tooBig` when it is larger than `maxBytes` (it is then not downloaded). */
export async function waDownloadMedia(mediaId: string, maxBytes: number, from?: string | null): Promise<{ bytes: Uint8Array; mime: string } | { tooBig: true } | null> {
  if (!waConfigured() || !/^[\w-]{1,120}$/.test(mediaId)) return null;
  const auth = { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const meta = await fetch(`${GRAPH}/${mediaId}${from ? `?phone_number_id=${encodeURIComponent(from)}` : ''}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
  if (!meta.ok) return null;
  const j = await meta.json().catch(() => ({})) as { url?: string; mime_type?: string; file_size?: number | string };
  if (!j.url || !/^https:\/\/[\w.-]+\.(fbcdn\.net|facebook\.com|fbsbx\.com|whatsapp\.net)\//.test(j.url)) return null;      // our token only ever goes to Meta
  if (Number(j.file_size ?? 0) > maxBytes) return { tooBig: true };
  const res = await fetch(j.url, { headers: auth, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) return { tooBig: true };
  return { bytes, mime: j.mime_type || res.headers.get('content-type') || 'audio/ogg' };
}

/** Validate Meta's webhook signature. Returns true when no app secret is configured yet (dev), with a console warning. */
export function waVerifySignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) { console.warn('[wa] WHATSAPP_APP_SECRET not set — webhook signature not verified'); return true; }
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const got = header.slice(7);
  return expected.length === got.length && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(got, 'hex'));
}
