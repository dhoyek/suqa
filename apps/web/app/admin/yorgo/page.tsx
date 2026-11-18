import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { getLocale } from '@/lib/locale';
import YorgoAdmin from './YorgoAdmin';

export const dynamic = 'force-dynamic';

// Yorgo for the association: switches, monthly caps, and what was spent — numbers only. Nobody here can read what people wrote:
// the page works on suqa.yorgo_usage (day × shop × person) and the switches, with the admin's own access.
export default async function AdminYorgo() {
  const tenant = await getTenant();
  const [sb, L] = await Promise.all([supabaseServer(), getLocale(tenant)]);
  const tz = tenant.timezone || 'UTC';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());       // YYYY-MM-DD in the association's time zone
  const monthStart = `${today.slice(0, 8)}01`;
  const [{ data: settings, error: sErr }, { data: shops }, { data: yshops }, { data: usage }, misses] = await Promise.all([
    sb.from('yorgo_settings').select('enabled,shopper_enabled,cap_global_usd,cap_shop_usd,cap_user_usd,rate_per_min').eq('tenant_id', tenant.id).maybeSingle(),
    sb.from('shops').select('id,slug,name,status').eq('tenant_id', tenant.id).order('created_at'),
    sb.from('yorgo_shops').select('shop_id,enabled,cap_usd').eq('tenant_id', tenant.id),
    sb.from('yorgo_usage').select('day,shop_id,user_id,messages,model_calls,cost_usd').eq('tenant_id', tenant.id).gte('day', monthStart).order('day'),
    sb.from('yorgo_misses').select('id,shop_id,phrase,times,last_at').eq('tenant_id', tenant.id).is('dismissed_at', null).order('times', { ascending: false }).limit(40)
      .then(r => (r.error ? [] : r.data ?? []), () => []),                                      // not installed yet → nothing to show
  ]);
  if (sErr) return <div className="card"><p className="muted" style={{ margin: 0 }}>{L === 'ar' ? 'يورغو غير مثبّت في قاعدة البيانات بعد.' : 'Yorgo is not installed in the database yet.'}</p></div>;
  return <YorgoAdmin tenantId={tenant.id} locale={L === 'ar' ? 'ar' : 'en'} today={today} hasKey={!!process.env.ANTHROPIC_API_KEY}
    settings={settings ? { enabled: !!settings.enabled, shopper_enabled: !!settings.shopper_enabled, cap_global_usd: Number(settings.cap_global_usd), cap_shop_usd: Number(settings.cap_shop_usd), cap_user_usd: Number(settings.cap_user_usd), rate_per_min: Number(settings.rate_per_min) } : null}
    shops={((shops as { id: string; slug: string; name: { ar?: string; en?: string }; status: string }[] | null) ?? []).filter(s => s.status === 'active').map(s => ({ id: s.id, name: (L === 'ar' ? s.name?.ar : s.name?.en) || s.name?.ar || s.name?.en || s.slug }))}
    yshops={((yshops as { shop_id: string; enabled: boolean; cap_usd: number | string | null }[] | null) ?? []).map(y => ({ shop_id: y.shop_id, enabled: y.enabled, cap_usd: y.cap_usd == null ? null : Number(y.cap_usd) }))}
    usage={((usage as { day: string; shop_id: string | null; user_id: string | null; messages: number; model_calls: number; cost_usd: number | string }[] | null) ?? []).map(u => ({ ...u, cost_usd: Number(u.cost_usd) }))}
    misses={misses as { id: string; shop_id: string | null; phrase: string; times: number }[]} />;
}
