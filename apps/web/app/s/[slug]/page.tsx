import { notFound } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { t as tr, formatMoney, type Shop, type Product } from '@suqa/shared';

// Shop page: products grouped by section. Cart/checkout component to follow.
export default async function ShopPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const { data: shop } = await sb.from('shops').select('*').eq('tenant_id', tenant.id).eq('slug', slug).maybeSingle();
  if (!shop) notFound();
  const { data: products } = await sb.from('products').select('*').eq('shop_id', (shop as Shop).id).eq('is_active', true).order('sort_order');
  const L = tenant.default_locale;
  return (
    <main style={{ padding: 16, maxWidth: 960, margin: '0 auto' }}>
      <h1>{tr((shop as Shop).name, L)}</h1>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {(products as Product[] | null)?.map(p => (
          <li key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #eee', opacity: p.is_available ? 1 : .5 }}>
            <span>{tr(p.name, L)} {p.unit && <small>/ {p.unit}</small>}</span>
            <span>{formatMoney(p.price_usd, tenant.fx_lbp_rate, tenant.display_currency, L)}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
