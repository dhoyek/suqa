import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import CategoriesEditor from './CategoriesEditor';
import { supabaseAdmin } from '@/lib/server/supabase-admin';

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
  // the shared item categories (87) and how many items use each (counted with the service key: only the category of each item is read)
  const { data: icats, error: icErr } = await sb.from('item_categories').select('id,key,name,sort_order').eq('tenant_id', tenant.id).order('sort_order').order('key');
  const usedItems: Record<string, number> = {}; const admin = supabaseAdmin();
  if (admin && !icErr) for (let from = 0; ; from += 1000) {
    const { data: page } = await admin.from('products').select('section').eq('tenant_id', tenant.id).eq('is_active', true).not('section', 'is', null).order('id').range(from, from + 999);
    for (const p of (page as { section: string }[] | null) ?? []) usedItems[p.section] = (usedItems[p.section] ?? 0) + 1;
    if (!page || page.length < 1000) break;
  }
  const itemInitial = ((icats as { id: string; key: string; name: { ar?: string; en?: string } }[] | null) ?? []).map(c => ({ id: c.id, slug: c.key, ar: c.name?.ar ?? '', en: c.name?.en ?? '', shops: usedItems[c.key] ?? 0 }));
  const locale = tenant.default_locale === 'ar' ? 'ar' : 'en';
  return (<div className="stack" style={{ gap: 28 }}>
    <CategoriesEditor tenantId={tenant.id} locale={locale} initial={initial} />
    {!icErr && <CategoriesEditor kind="items" tenantId={tenant.id} locale={locale} initial={itemInitial} />}
  </div>);
}
