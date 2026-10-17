import Link from 'next/link';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { ui } from '@/lib/ui-text';
import { t as tr, type Shop, type Category } from '@suqa/shared';
import ShopsList from './ShopsList';

export const dynamic = 'force-dynamic';

export default async function AdminShops({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const L = tenant.default_locale;
  const [{ data: shops }, { data: cats }] = await Promise.all([
    sb.from('shops').select('*').eq('tenant_id', tenant.id).order('status').order('sort_order'),
    sb.from('categories').select('id,name').eq('tenant_id', tenant.id).order('sort_order'),
  ]);
  const catName = Object.fromEntries(((cats as Category[]) ?? []).map(c => [c.id, tr(c.name, L)]));
  const list = ((shops as Shop[]) ?? []).filter(s => !status || s.status === status).map(s => ({ ...s, categoryName: s.category_id ? catName[s.category_id] : '' }));
  return (
    <div className="stack">
      <div className="row spread">
        <h1 style={{ margin: 0, fontSize: 20 }}>{ui('shops', L)}</h1>
        <Link className="btn primary" href="/admin/shops/new">+ {ui('newShop', L)}</Link>
      </div>
      <ShopsList initial={list as any} locale={L} labels={{ approve: ui('approve', L), pause: ui('pause', L), resume: ui('resume', L), disable: ui('disable', L), minOrder: ui('minOrder', L) }} />
    </div>
  );
}
