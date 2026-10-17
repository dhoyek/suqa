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
  const [{ data }, { data: baskets }] = await Promise.all([
    sb.from('orders').select('id,number,status,total_usd,placed_at,basket_id,basket_seq,shop:shops(name,slug)').eq('customer_id', user.id).order('placed_at', { ascending: false }).limit(50),
    sb.from('baskets').select('id,number,total_usd').eq('customer_id', user.id).order('placed_at', { ascending: false }).limit(50),
  ]);
  const basketById = Object.fromEntries(((baskets as any[]) ?? []).map(b => [b.id, b]));
  const L = tenant.default_locale;
  const rows = (data as any[]) ?? [];
  // group a basket's parts into one card
  const list: any[] = [];
  for (const o of rows) {
    if (!o.basket_id) { list.push({ kind: 'order', ...o }); continue; }
    const g = list.find(x => x.kind === 'basket' && x.basket_id === o.basket_id);
    if (g) g.parts.push(o); else list.push({ kind: 'basket', basket_id: o.basket_id, number: basketById[o.basket_id]?.number ?? o.number.replace(/-[A-Z]$/, ''), placed_at: o.placed_at, total_usd: Number(basketById[o.basket_id]?.total_usd ?? o.total_usd), parts: [o] });
  }
  const fmtDate = (d: string) => new Date(d).toLocaleString(L === 'ar' ? 'ar-LB' : 'en-GB', { timeZone: tenant.timezone, dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="stack">
      <div className="row spread">
        <h1 style={{ margin: 0, fontSize: 20 }}>{ui('myOrders', L)}</h1>
        <form action="/auth/signout" method="post"><button className="btn ghost muted" type="submit">{ui('signOut', L)}</button></form>
      </div>
      {!list.length && <div className="card muted">{ui('noOrdersYet', L)}</div>}
      {list.map(x => x.kind === 'basket' ? (
        <Link key={x.basket_id} href={`/orders/b/${x.basket_id}`} className="card shop-card">
          <div className="row spread"><strong>🧺 {ui('basket', L)} · {x.parts.length} {ui('basketOf', L)}</strong>
            <span className="row" style={{ gap: 4 }}>{x.parts.map((p: any) => <span key={p.id} className={`badge ${p.status}`}>{(STATUS_LABEL[p.status as OrderStatus] as any)[L]}</span>)}</span></div>
          <div className="muted" style={{ fontSize: 13 }}>{x.parts.map((p: any) => tr(p.shop?.name, L)).join(' · ')}</div>
          <div className="row spread muted" style={{ fontSize: 13 }}>
            <span>{x.number} · {fmtDate(x.placed_at)}</span>
            <strong>{formatMoney(x.total_usd, tenant.fx_lbp_rate, tenant.display_currency, L)}</strong>
          </div>
        </Link>
      ) : (
        <Link key={x.id} href={`/orders/${x.id}`} className="card shop-card">
          <div className="row spread"><strong>{tr(x.shop?.name, L)}</strong><span className={`badge ${x.status}`}>{(STATUS_LABEL[x.status as OrderStatus] as any)[L]}</span></div>
          <div className="row spread muted" style={{ fontSize: 13 }}>
            <span>{x.number} · {fmtDate(x.placed_at)}</span>
            <strong>{formatMoney(Number(x.total_usd), tenant.fx_lbp_rate, tenant.display_currency, L)}</strong>
          </div>
        </Link>
      ))}
    </div>
  );
}
