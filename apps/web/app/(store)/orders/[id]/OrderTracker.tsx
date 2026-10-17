'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { formatMoney, t as tr, type DisplayCurrency, type Locale, type Order, type OrderItem, type OrderStatus } from '@suqa/shared';

type Row = Order & { items: OrderItem[]; shop: { name: any; slug: string; phone: string | null; whatsapp: string | null } };
const STEPS: OrderStatus[] = ['pending', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered'];

export default function OrderTracker(props: { initial: Row; locale: Locale; fx: number; displayCurrency: DisplayCurrency; justPlaced: boolean; statusLabels: Record<OrderStatus, string>; labels: Record<'orderPlaced' | 'cancelOrder' | 'total' | 'deliveryFee' | 'call' | 'eta' | 'myOrders' | 'notes', string> }) {
  const { locale: L, fx, displayCurrency, statusLabels, labels } = props;
  const sb = useMemo(() => supabaseBrowser(), []);
  const [o, setO] = useState<Row>(props.initial);
  const money = (v: number) => formatMoney(Number(v), fx, displayCurrency, L);

  useEffect(() => {
    const refresh = async () => { const { data } = await sb.from('orders').select('*').eq('id', o.id).maybeSingle(); if (data) setO(prev => ({ ...prev, ...(data as any) })); };
    const ch = sb.channel(`order:${o.id}`).on('postgres_changes', { event: 'UPDATE', schema: 'suqa', table: 'orders', filter: `id=eq.${o.id}` }, refresh).subscribe();
    const t = setInterval(refresh, 20000);
    return () => { sb.removeChannel(ch); clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.id]);

  async function cancel() {
    if (!confirm(`${labels.cancelOrder}?`)) return;
    const { error } = await sb.from('orders').update({ status: 'cancelled' }).eq('id', o.id);
    if (error) alert(error.message); else setO(prev => ({ ...prev, status: 'cancelled' }));
  }

  const terminalBad = o.status === 'rejected' || o.status === 'cancelled';
  const idx = STEPS.indexOf(o.status);

  return (
    <div className="stack">
      {props.justPlaced && <div className="card" style={{ background: '#f0fdf4', borderColor: '#bbf7d0' }}>✅ {labels.orderPlaced}</div>}
      <div className="row spread">
        <h1 style={{ margin: 0, fontSize: 20 }}>{o.number}</h1>
        <span className={`badge ${o.status}`}>{statusLabels[o.status]}</span>
      </div>
      <section className="card">
        <div className="row spread"><strong>{tr(o.shop?.name, L)}</strong>{o.shop?.phone && <a className="btn" href={`tel:${o.shop.phone}`}>{labels.call}</a>}</div>
        {!terminalBad && (
          <ul className="timeline" style={{ marginTop: 10 }}>
            {STEPS.map((s, i) => <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''}><span className="tick" />{statusLabels[s]}</li>)}
          </ul>
        )}
        {terminalBad && o.reject_reason && <div className="error" style={{ marginTop: 8 }}>{o.reject_reason}</div>}
        {!terminalBad && o.status !== 'delivered' && o.eta_minutes != null && <div className="muted" style={{ fontSize: 13 }}>{labels.eta}: ~{o.eta_minutes} min</div>}
      </section>
      <section className="card stack">
        {o.items?.map(i => <div className="row spread" key={i.id} style={{ fontSize: 14 }}><span><span className="qty">{Number(i.quantity)}×</span> {tr(i.name, L)}</span><span>{money(i.line_total_usd)}</span></div>)}
        <div className="row spread muted" style={{ fontSize: 13 }}><span>{labels.deliveryFee}</span><span>{money(o.delivery_fee_usd)}</span></div>
        <div className="row spread" style={{ fontSize: 18 }}><strong>{labels.total}</strong><strong>{money(o.total_usd)}</strong></div>
        <div className="muted" style={{ fontSize: 13 }}>{o.address?.line1}{o.address?.line2 ? `, ${o.address.line2}` : ''}</div>
        {o.customer_notes && <div style={{ fontSize: 13 }}><span className="muted">{labels.notes}:</span> {o.customer_notes}</div>}
      </section>
      <div className="row spread">
        <Link href="/orders" className="btn">{labels.myOrders}</Link>
        {o.status === 'pending' && <button className="btn danger" onClick={cancel}>{labels.cancelOrder}</button>}
      </div>
    </div>
  );
}
