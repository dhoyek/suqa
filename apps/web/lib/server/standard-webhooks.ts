import { createHmac, timingSafeEqual } from 'node:crypto';

/** Standard Webhooks (https://www.standardwebhooks.com) signature check, as used by Supabase Auth hooks. */
export function verifyStandardWebhook(raw: string, h: { get(name: string): string | null }, secret: string | undefined, now = Date.now()): boolean {
  if (!secret) return false;
  const id = h.get('webhook-id'), ts = h.get('webhook-timestamp'), sig = h.get('webhook-signature');
  if (!id || !ts || !sig) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;                        // 5 min replay window
  const key = Buffer.from(secret.replace(/^v1,/, '').replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest();
  return sig.split(' ').some(part => {
    const [, b64] = part.split(',');
    if (!b64) return false;
    const got = Buffer.from(b64, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
