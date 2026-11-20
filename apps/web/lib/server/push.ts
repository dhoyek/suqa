import 'server-only';
import webpush from 'web-push';
import { supabaseAdmin } from '@/lib/server/supabase-admin';

/**
 * Web push to a shop's own devices (85_push_notifications). Keys come from the site's environment, set by the owner of the site:
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  (made once: npx web-push generate-vapid-keys)   VAPID_SUBJECT (optional, mailto: or https:)
 * Without them nothing is sent and the POS hides the button. Endpoints the push service reports gone are removed.
 */
export const pushConfigured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

let ready = false;
function init() {
  if (ready || !pushConfigured()) return ready;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@suqa.app', process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  return (ready = true);
}

export type PushPayload = { title: string; body: string; url: string; tag?: string };

export async function pushToShop(shopId: string, p: PushPayload): Promise<{ sent: number; removed: number }> {
  if (!init()) return { sent: 0, removed: 0 };
  const admin = supabaseAdmin(); if (!admin) return { sent: 0, removed: 0 };
  const { data } = await admin.from('push_subscriptions').select('id, endpoint, p256dh, auth, failures').eq('shop_id', shopId);
  let sent = 0, removed = 0;
  await Promise.all((data ?? []).map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(p), { TTL: 60 * 60, urgency: 'high' });
      sent++; await admin.from('push_subscriptions').update({ last_sent_at: new Date().toISOString(), failures: 0 }).eq('id', s.id);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410 || s.failures >= 9) { removed++; await admin.from('push_subscriptions').delete().eq('id', s.id); }
      else await admin.from('push_subscriptions').update({ failures: s.failures + 1 }).eq('id', s.id);
      console.warn('[push] failed', code, (e as Error).message.slice(0, 120));
    }
  }));
  return { sent, removed };
}
