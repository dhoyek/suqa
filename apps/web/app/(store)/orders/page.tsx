import Link from 'next/link';
import { getTenant } from '@/lib/tenant';
import { requireUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { ui, STATUS_LABEL } from '@/lib/ui-text';
import { formatMoney, t as tr, type Order, type OrderStatus } from '@suqa/shared';

export const dynamic = 'force-dynamic';

export default async function OrdersPage() {
  const user = await requireUser('/orders');
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const { data } = await sb.from('orders').select('id,number,status,total_usd,placed_at,shop:shops(name,slug)').eq('customer_id', user.id).order('placed_at', { ascending: false }).limit(50);
  const L = tenant.default_locale;
  const list = (data as any[]) ?? [];
  return (
    <div className="stack">
      <div className="row spread">
        <h1 style={{ margin: 0, fontSize: 20 }}>{ui('myOrders', L)}</h1>
        <form action="/auth/signout" method="post"><button className="btn ghost muted" type="submit">{ui('signOut', L)}</button></form>
      </div>
      {!list.length && <div className="card muted">{ui('noOrdersYet', L)}</div>}
      {list.map(o => (
        <Link key={o.id} href={`/orders/${o.id}`} className="card shop-card">
          <div className="row spread"><strong>{tr(o.shop?.name, L)}</strong><span className={`badge ${o.status}`}>{(STATUS_LABEL[o.status as OrderStatus] as any)[L]}</span></div>
          <div className="row spread muted" style={{ fontSize: 13 }}>
            <span>{o.number} · {new Date(o.placed_at).toLocaleString(L === 'ar' ? 'ar-LB' : 'en-GB', { timeZone: tenant.timezone, dateStyle: 'medium', timeStyle: 'short' })}</span>
            <strong>{formatMoney(Number(o.total_usd), tenant.fx_lbp_rate, tenant.display_currency, L)}</strong>
          </div>
        </Link>
      ))}
    </div>
  );
}
