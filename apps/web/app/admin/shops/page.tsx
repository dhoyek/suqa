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
  const shown = ((shops as Shop[]) ?? []).filter(s => !status || s.status === status);
  // how many items each shop has: all its active items, and those of them shown on the site (counted by the database, no rows read)
  const counts = await Promise.all(shown.map(async s => {
    const [all, online] = await Promise.all([
      sb.from('products').select('id', { count: 'exact', head: true }).eq('shop_id', s.id).eq('is_active', true),
      sb.from('products').select('id', { count: 'exact', head: true }).eq('shop_id', s.id).eq('is_active', true).eq('visible_online', true),
    ]);
    return { items: all.count ?? null, online: online.count ?? null };
  }));
  const list = shown.map((s, i) => ({ ...s, categoryName: s.category_id ? catName[s.category_id] : '', items: counts[i].items, itemsOnline: counts[i].online }));
  const totalItems = counts.reduce((a, c) => a + (c.items ?? 0), 0);
  return (
    <div className="stack">
      <div className="row spread">
        <h1 style={{ margin: 0, fontSize: 20 }}>{ui('shops', L)} <small className="muted shops-total" style={{ fontSize: 14, fontWeight: 400 }}>· {list.length} · 📦 {totalItems.toLocaleString('en')} {L === 'ar' ? 'صنف' : 'items'}</small></h1>
        <Link className="btn primary" href="/admin/shops/new">+ {ui('newShop', L)}</Link>
      </div>
      <ShopsList initial={list as any} locale={L} labels={{ approve: ui('approve', L), pause: ui('pause', L), resume: ui('resume', L), disable: ui('disable', L), minOrder: ui('minOrder', L) }} />
    </div>
  );
}
