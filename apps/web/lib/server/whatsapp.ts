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
export async function waSendText(to: string, body: string) {
  return waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } });
}

/** Approved template message (business-initiated). components follow Meta's template payload format. */
export async function waSendTemplate(to: string, name: string, lang: string, components?: unknown[]) {
  return waPost({ messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code: lang }, components } });
}

async function waPost(payload: Record<string, unknown>) {
  if (!waConfigured()) throw new Error('whatsapp_not_configured');
  const res = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`whatsapp_error ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return json as { messages?: { id: string }[] };
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
