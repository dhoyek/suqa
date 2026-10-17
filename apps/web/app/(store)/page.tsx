import Link from 'next/link';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { ui } from '@/lib/ui-text';
import { t as tr, type Shop, type Category } from '@suqa/shared';
import { isOpenNow } from '@/lib/hours';

export const dynamic = 'force-dynamic';

// Storefront home: categories + active shops of the current tenant.
export default async function Home({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const [{ data: cats }, { data: shops }] = await Promise.all([
    sb.from('categories').select('*').eq('tenant_id', tenant.id).order('sort_order'),
    sb.from('shops').select('*').eq('tenant_id', tenant.id).eq('status', 'active').order('sort_order'),
  ]);
  const L = tenant.default_locale;
  const list = ((shops as Shop[] | null) ?? []).filter(s => !c || s.category_id === c);
  return (
    <>
      <nav className="row" style={{ marginBottom: 14 }}>
        <Link href="/" className={`chip ${!c ? 'active' : ''}`}>{ui('shops', L)}</Link>
        {(cats as Category[] | null)?.map(cat => <Link key={cat.id} href={`/?c=${cat.id}`} className={`chip ${c === cat.id ? 'active' : ''}`}>{tr(cat.name, L)}</Link>)}
      </nav>
      <section className="grid">
        {list.map(s => {
          const open = isOpenNow(s.opening_hours, s.is_open_override, tenant.timezone);
          return (
            <Link key={s.id} href={`/s/${s.slug}`} className="card shop-card">
              <div className="row spread"><strong>{tr(s.name, L)}</strong><span className={`dot ${open ? 'on' : ''}`} /></div>
              <div className="muted" style={{ fontSize: 14 }}>{tr(s.description, L)}</div>
              {s.min_order_usd > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{ui('minOrder', L)}: ${Number(s.min_order_usd).toFixed(2)}</div>}
            </Link>
          );
        })}
        {!list.length && <p className="muted">{ui('noOrders', L)}</p>}
      </section>
    </>
  );
}
