import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { getLocale } from '@/lib/locale';
import { ROUTE_COLUMNS, toRoute } from '@/lib/ai/routes';
import { googleKey } from '@/lib/ai/google';
import Providers from './Providers';

export const dynamic = 'force-dynamic';

// AI providers (script 100): which provider and model does which task. The platform's settings, not one market's:
// platform admins only — the database gives the rows to nobody else. Keys are never shown or stored here; the page only
// says whether a key is present on this site.
export default async function AdminProviders() {
  const tenant = await getTenant();
  const [sb, L] = await Promise.all([supabaseServer(), getLocale(tenant)]);
  const ar = L === 'ar';
  const { data: isAdmin } = await sb.rpc('is_platform_admin');
  if (isAdmin !== true) return <div className="card"><p className="muted" style={{ margin: 0 }}>{ar ? 'هذه الصفحة لمدير المنصّة فقط.' : 'This page is for the platform admin only.'}</p></div>;
  const { data, error } = await sb.from('yorgo_ai_routes').select(`${ROUTE_COLUMNS},updated_at`).order('task');
  if (error) return <div className="card"><p className="muted" style={{ margin: 0 }}>{ar ? 'جدول مزوّدي الذكاء الاصطناعي غير مثبّت في قاعدة البيانات بعد (السكربت 100).' : 'The AI providers table is not installed in the database yet (script 100).'}</p></div>;
  return <Providers locale={ar ? 'ar' : 'en'} keys={{ google: !!googleKey(), anthropic: !!process.env.ANTHROPIC_API_KEY }}
    routes={((data as Record<string, unknown>[] | null) ?? []).map(r => ({ ...toRoute(r), updated_at: (r.updated_at as string | null) ?? null }))} />;
}
