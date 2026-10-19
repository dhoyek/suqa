'use server';
import { getTenant } from '@/lib/tenant';
import { getTenantRole } from '@/lib/admin';
import { normalizePhone } from '@/lib/whatsapp';
import { waConfigured, waSendText } from '@/lib/server/whatsapp';

/** Admin-only: send a plain-text test message to verify the WhatsApp Cloud API configuration. */
export async function sendTestWhatsApp(phone: string): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
  const tenant = await getTenant();
  if ((await getTenantRole(tenant.id)) !== 'admin') return { ok: false, error: 'not_allowed' };
  if (!waConfigured()) return { ok: false, error: 'whatsapp_not_configured' };
  const to = normalizePhone(phone);
  if (!to) return { ok: false, error: 'invalid_phone' };
  try {
    const r = await waSendText(to, `✅ ${tenant.brand_name} — WhatsApp is connected.\nواتساب متصل بنجاح.`);
    return { ok: true, id: r.messages?.[0]?.id };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
