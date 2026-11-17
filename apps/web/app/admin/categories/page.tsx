import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import CategoriesEditor from './CategoriesEditor';

export const dynamic = 'force-dynamic';

// The association's shop categories (grocery, bakery, …): names in both languages, order on the home page, and removal of unused ones.
export default async function AdminCategories() {
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const [{ data: cats }, { data: shops }] = await Promise.all([
    sb.from('categories').select('id,slug,name,sort_order').eq('tenant_id', tenant.id).order('sort_order').order('created_at'),
    sb.from('shops').select('category_id').eq('tenant_id', tenant.id),
  ]);
  const used: Record<string, number> = {};
  for (const s of (shops as { category_id: string | null }[] | null) ?? []) if (s.category_id) used[s.category_id] = (used[s.category_id] ?? 0) + 1;
  const initial = ((cats as { id: string; slug: string; name: { ar?: string; en?: string }; sort_order: number }[] | null) ?? [])
    .map(c => ({ id: c.id, slug: String(c.slug), ar: c.name?.ar ?? '', en: c.name?.en ?? '', shops: used[c.id] ?? 0 }));
  return <CategoriesEditor tenantId={tenant.id} locale={tenant.default_locale === 'ar' ? 'ar' : 'en'} initial={initial} />;
}
