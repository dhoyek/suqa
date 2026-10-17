import Link from 'next/link';
import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { ui, STATUS_LABEL } from '@/lib/ui-text';
import { formatMoney, t as tr, type OrderStatus } from '@suqa/shared';

export const dynamic = 'force-dynamic';

export default async function AdminHome() {
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const L = tenant.default_locale;
  const [{ data: stats }, { data: recent }] = await Promise.all([
    sb.rpc('tenant_stats', { p_tenant: tenant.id }).single(),
    sb.from('orders').select('id,number,status,total_usd,placed_at,customer_name,shop:shops(name)').eq('tenant_id', tenant.id).order('placed_at', { ascending: false }).limit(15),
  ]);
  const s = (stats as any) ?? {};
  const money = (v: number) => formatMoney(Number(v), tenant.fx_lbp_rate, tenant.display_currency, L);
  const Tile = ({ label, value, href, warn }: { label: string; value: string | number; href?: string; warn?: boolean }) => {
    const inner = <><div className="muted" style={{ fontSize: 13 }}>{label}</div><div style={{ fontSize: 26, fontWeight: 800, color: warn && Number(value) > 0 ? 'var(--warn)' : 'inherit' }}>{value}</div></>;
    return href ? <Link href={href} className="card shop-card">{inner}</Link> : <div className="card">{inner}</div>;
  };
  return (
    <div className="stack">
      <div className="grid">
        <Tile label={ui('ordersToday', L)} value={s.orders_today ?? 0} href="/admin/orders" />
        <Tile label={ui('revenueToday', L)} value={money(s.revenue_today ?? 0)} />
        <Tile label={ui('pendingNow', L)} value={s.pending_now ?? 0} href="/admin/orders?status=pending" warn />
        <Tile label={ui('activeShops', L)} value={s.active_shops ?? 0} href="/admin/shops" />
        <Tile label={ui('pendingShops', L)} value={s.pending_shops ?? 0} href="/admin/shops?status=pending" warn />
      </div>
      <section className="card">
        <div className="col-title" style={{ marginTop: 0 }}>{ui('orders', L)}</div>
        {((recent as any[]) ?? []).map(o => (
          <div className="product" key={o.id}>
            <div style={{ flex: 1 }}>
              <div className="name">{o.number} · {tr(o.shop?.name, L)}</div>
              <div className="muted" style={{ fontSize: 13 }}>{o.customer_name} · {new Date(o.placed_at).toLocaleTimeString(L === 'ar' ? 'ar-LB' : 'en-GB', { timeZone: tenant.timezone, hour: '2-digit', minute: '2-digit' })}</div>
            </div>
            <span className={`badge ${o.status}`}>{(STATUS_LABEL[o.status as OrderStatus] as any)[L]}</span>
            <strong style={{ minWidth: 70, textAlign: 'end' }}>{money(o.total_usd)}</strong>
          </div>
        ))}
      </section>
    </div>
  );
}
