import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { getLocale } from '@/lib/locale';
import Demand from './Demand';

export const dynamic = 'force-dynamic';

// Demand (script 99): what people ask Yorgo for (app chat and WhatsApp) and type in the search boxes — how often, found or not,
// and who asked. The item words and the person, never the text of a message. Association admins only (the database refuses others).
export default async function AdminDemand() {
  const tenant = await getTenant();
  const [sb, L] = await Promise.all([supabaseServer(), getLocale(tenant)]);
  const { data: shops } = await sb.from('shops').select('id,slug,name').eq('tenant_id', tenant.id);
  return <Demand tenantId={tenant.id} locale={L === 'ar' ? 'ar' : 'en'} timeZone={tenant.timezone || 'UTC'}
    shops={((shops as { id: string; slug: string; name: { ar?: string; en?: string } }[] | null) ?? []).map(s => ({ id: s.id, name: (L === 'ar' ? s.name?.ar : s.name?.en) || s.name?.ar || s.name?.en || s.slug }))} />;
}
