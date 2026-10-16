import Link from 'next/link';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { t as tr, type Shop, type Category } from '@suqa/shared';

// Storefront home: categories + active shops of the current tenant.
export default async function Home() {
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const [{ data: cats }, { data: shops }] = await Promise.all([
    sb.from('categories').select('*').eq('tenant_id', tenant.id).order('sort_order'),
    sb.from('shops').select('*').eq('tenant_id', tenant.id).eq('status', 'active').order('sort_order'),
  ]);
  const L = tenant.default_locale;
  return (
    <main style={{ padding: 16, maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ color: 'var(--brand-primary)' }}>{tenant.brand_name}</h1>
      <nav style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(cats as Category[] | null)?.map(c => <span key={c.id} style={{ padding: '4px 10px', border: '1px solid #ddd', borderRadius: 999 }}>{tr(c.name, L)}</span>)}
      </nav>
      <section style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', marginTop: 16 }}>
        {(shops as Shop[] | null)?.map(s => (
          <Link key={s.id} href={`/s/${s.slug}`} style={{ padding: 12, border: '1px solid #eee', borderRadius: 12, textDecoration: 'none', color: 'inherit' }}>
            <strong>{tr(s.name, L)}</strong>
            <div style={{ opacity: .7, fontSize: 14 }}>{tr(s.description, L)}</div>
          </Link>
        ))}
        {!shops?.length && <p>No shops yet — onboard the first one in <Link href="/admin">/admin</Link>.</p>}
      </section>
    </main>
  );
}
