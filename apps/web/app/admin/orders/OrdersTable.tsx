'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { formatMoney, t as tr, NEXT_STATUS, type DisplayCurrency, type Locale, type Order, type OrderItem, type OrderStatus } from '@suqa/shared';

type Row = Order & { items: OrderItem[]; shop: { name: any } };
type Labels = Record<'orders' | 'allShops' | 'allStatuses' | 'today' | 'last7days' | 'last30days' | 'total' | 'commission' | 'noOrders' | 'call', string>;
const ALL: OrderStatus[] = ['pending', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'rejected', 'cancelled'];

export default function OrdersTable(props: { orders: Row[]; shops: { id: string; name: string }[]; filters: { status: string; shop: string; range: string }; locale: Locale; fx: number; displayCurrency: DisplayCurrency; timezone: string; statusLabels: Record<OrderStatus, string>; labels: Labels }) {
  const { shops, filters, locale: L, fx, displayCurrency, timezone, statusLabels, labels } = props;
  const router = useRouter();
  const sb = useMemo(() => supabaseBrowser(), []);
  const [orders, setOrders] = useState(props.orders);
  const [open, setOpen] = useState<string | null>(null);
  const money = (v: number) => formatMoney(Number(v), fx, displayCurrency, L);
  const nav = (patch: Partial<typeof filters>) => { const f = { ...filters, ...patch }; const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as any).toString(); router.push(`/admin/orders${q ? `?${q}` : ''}`); };
  async function setStatus(o: Row, status: OrderStatus) {
    const { error } = await sb.from('orders').update({ status }).eq('id', o.id);
    if (error) { alert(error.message); return; }
    setOrders(prev => prev.map(x => x.id === o.id ? { ...x, status } : x));
  }
  const totals = orders.filter(o => o.status === 'delivered').reduce((a, o) => ({ sum: a.sum + Number(o.total_usd), comm: a.comm + Number(o.commission_usd) }), { sum: 0, comm: 0 });

  return (
    <div className="stack">
      <div className="row">
        <select className="input" style={{ width: 'auto' }} value={filters.range} onChange={e => nav({ range: e.target.value })}>
          <option value="1">{labels.today}</option><option value="7">{labels.last7days}</option><option value="30">{labels.last30days}</option></select>
        <select className="input" style={{ width: 'auto' }} value={filters.status} onChange={e => nav({ status: e.target.value })}>
          <option value="">{labels.allStatuses}</option>{ALL.map(s => <option key={s} value={s}>{statusLabels[s]}</option>)}</select>
        <select className="input" style={{ width: 'auto' }} value={filters.shop} onChange={e => nav({ shop: e.target.value })}>
          <option value="">{labels.allShops}</option>{shops.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <span className="muted" style={{ marginInlineStart: 'auto', fontSize: 13 }}>{orders.length} · {labels.total} {money(totals.sum)} · {labels.commission} {money(totals.comm)}</span>
      </div>
      <section className="card">
        {!orders.length && <div className="muted">{labels.noOrders}</div>}
        {orders.map(o => (
          <div key={o.id} style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="product" style={{ borderBottom: 0, cursor: 'pointer' }} onClick={() => setOpen(open === o.id ? null : o.id)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">{o.number} · {tr(o.shop?.name, L)}</div>
                <div className="muted" style={{ fontSize: 13 }}>{o.customer_name} · {new Date(o.placed_at).toLocaleString(L === 'ar' ? 'ar-LB' : 'en-GB', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' })}</div>
              </div>
              <span className={`badge ${o.status}`}>{statusLabels[o.status]}</span>
              <strong style={{ minWidth: 70, textAlign: 'end' }}>{money(o.total_usd)}</strong>
            </div>
            {open === o.id && (
              <div className="stack" style={{ padding: '0 0 12px', fontSize: 14 }}>
                {o.items?.map(i => <div className="row spread" key={i.id}><span><span className="qty">{Number(i.quantity)}×</span> {tr(i.name, L)}</span><span>{money(i.line_total_usd)}</span></div>)}
                <div className="muted" style={{ fontSize: 13 }}>{o.address?.line1}{o.address?.line2 ? `, ${o.address.line2}` : ''} · <a href={`tel:${o.customer_phone}`}>{o.customer_phone}</a></div>
                {o.customer_notes && <div className="muted" style={{ fontSize: 13 }}>“{o.customer_notes}”</div>}
                {o.reject_reason && <div className="error">{o.reject_reason}</div>}
                <div className="row">
                  {(NEXT_STATUS[o.status] ?? []).map(s => <button key={s} className="btn" onClick={() => setStatus(o, s)}>{statusLabels[s]}</button>)}
                  {!['delivered', 'rejected', 'cancelled'].includes(o.status) && <button className="btn danger" onClick={() => confirm(`${statusLabels.cancelled}?`) && setStatus(o, 'cancelled')}>{statusLabels.cancelled}</button>}
                </div>
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
