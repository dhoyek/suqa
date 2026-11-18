import 'server-only';
import { unstable_cache } from 'next/cache';
import { supabaseAdmin } from '@/lib/server/supabase-admin';

/** Is the shopper chat on for this association? Switches only (suqa.yorgo_settings) — read with the service role because the table is
 *  the association's own, cached for a minute so a page view does not cost a database trip. Off when no key is configured. */
export const yorgoShopperOn = unstable_cache(async (tenantId: string): Promise<boolean> => {
  const admin = supabaseAdmin();
  if (!admin || !process.env.ANTHROPIC_API_KEY) return false;
  const { data } = await admin.from('yorgo_settings').select('enabled,shopper_enabled').eq('tenant_id', tenantId).maybeSingle();
  return !!data?.enabled && !!data?.shopper_enabled;
}, ['yorgo-shopper-on'], { revalidate: 60 });
