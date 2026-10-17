'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useConfirm } from '@/components/ConfirmProvider';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import { waLink, telLink } from '@/lib/whatsapp';
import { formatMoney, t as tr, type Basket, type DisplayCurrency, type Locale, type Order, type OrderItem, type OrderStatus } from '@suqa/shared';

type Part = Order & { items: OrderItem[]; shop: { name: any; slug: string; phone: string | null; whatsapp: string | null } };
type Labels = Record<'orderPlaced' | 'cancelOrder' | 'total' | 'deliveryFee' | 'call' | 'eta' | 'myOrders' | 'notes' | 'subtotal' | 'basket' | 'basketOf'
  | 'deliveredTogether' | 'deliveredSeparately' | 'chatWhatsapp', string>;
const STEPS: OrderStatus[] = ['pending', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'delivered'];

export default function BasketTracker(props: { basket: Basket; initial: Part[]; locale: Locale; fx: number; displayCurrency: DisplayCurrency; justPlaced: boolean; statusLabels: Record<OrderStatus, string>; labels: Labels }) {
  const { basket: b, locale: L, fx, displayCurrency, statusLabels, labels } = props;
  const ask = useConfirm();
  const sb = useMemo(() => supabaseBrowser(), []);
  const [parts, setParts] = useState<Part[]>(props.initial);
  const money = (v: number) => formatMoney(Number(v), fx, displayCurrency, L);

  useEffect(() => {
    const refresh = async () => {
      const { data } = await sb.from('orders').select('*').eq('basket_id', b.id);
      if (data) setParts(prev => prev.map(p => ({ ...p, ...((data as any[]).find(d => d.id === p.id) ?? {}) })));
    };
    const ch = sb.channel(`basket:${b.id}`).on('postgres_changes', { event: 'UPDATE', schema: 'suqa', table: 'orders', filter: `basket_id=eq.${b.id}` }, refresh).subscribe();
    const t = setInterval(refresh, 20000);
    return () => { sb.removeChannel(ch); clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.id]);

  async function cancel(p: Part) {
    if (!(await ask(`${labels.cancelOrder} — ${tr(p.shop?.name, L)}?`, { danger: true }))) return;
    const { error } = await sb.from('orders').update({ status: 'cancelled' }).eq('id', p.id);
    if (error) alert(friendlyError(error, L)); else setParts(prev => prev.map(x => x.id === p.id ? { ...x, status: 'cancelled' } : x));
  }

  // live totals: cancelled/rejected parts drop out
  const live = parts.filter(p => !['rejected', 'cancelled'].includes(p.status));
  const subtotal = live.reduce((s, p) => s + Number(p.subtotal_usd), 0);
  const fee = b.delivery_mode === 'courier' ? (live.length ? Number(b.delivery_fee_usd) : 0) : live.reduce((s, p) => s + Number(p.delivery_fee_usd), 0);

  return (
    <div className="stack">
      {props.justPlaced && <div className="card" style={{ background: '#f0fdf4', borderColor: '#bbf7d0' }}>✅ {labels.orderPlaced}</div>}
      <div className="row spread">
        <h1 style={{ margin: 0, fontSize: 20 }}>{labels.basket} {b.number}</h1>
        <span className="muted" style={{ fontSize: 13 }}>{b.shop_count} {labels.basketOf}</span>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>🚚 {b.delivery_mode === 'courier' ? labels.deliveredTogether : labels.deliveredSeparately}</div>

      {parts.map(p => {
        const bad = p.status === 'rejected' || p.status === 'cancelled';
        const idx = STEPS.indexOf(p.status);
        const wa = waLink(p.shop?.whatsapp ?? p.shop?.phone, `${p.number}`); const tel = telLink(p.shop?.phone ?? p.shop?.whatsapp);
        return (
          <section className="card stack basket-part" key={p.id}>
            <div className="row spread">
              <strong>{tr(p.shop?.name, L)} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{p.number}</span></strong>
              <span className={`badge ${p.status}`}>{statusLabels[p.status]}</span>
            </div>
            {!bad && <ul className="timeline compact">{STEPS.map((s, i) => <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''}><span className="tick" />{statusLabels[s]}</li>)}</ul>}
            {bad && p.reject_reason && <div className="error">{p.reject_reason}</div>}
            {p.items?.map(i => <div className="row spread" key={i.id} style={{ fontSize: 14 }}><span><span className="qty">{Number(i.quantity)}×</span> {tr(i.name, L)}</span><span>{money(i.line_total_usd)}</span></div>)}
            <div className="row spread muted" style={{ fontSize: 13 }}>
              <span>{labels.subtotal}: {money(p.subtotal_usd)}{b.delivery_mode === 'per_shop' ? ` · ${labels.deliveryFee}: ${money(p.delivery_fee_usd)}` : ''}</span>
              {!bad && p.status !== 'delivered' && p.eta_minutes != null && <span>{labels.eta} ~{p.eta_minutes} min</span>}
            </div>
            <div className="row" style={{ gap: 8 }}>
              {wa && <a className="btn ghost wa-text" href={wa} target="_blank" rel="noopener noreferrer">💬 {labels.chatWhatsapp}</a>}
              {tel && <a className="btn ghost" href={tel}>📞 {labels.call}</a>}
              {p.status === 'pending' && <button className="btn danger" style={{ marginInlineStart: 'auto' }} onClick={() => cancel(p)}>{labels.cancelOrder}</button>}
            </div>
          </section>
        );
      })}

      <section className="card stack">
        <div className="row spread"><span>{labels.subtotal}</span><span>{money(subtotal)}</span></div>
        <div className="row spread muted" style={{ fontSize: 13 }}><span>{labels.deliveryFee}</span><span>{money(fee)}</span></div>
        <div className="row spread" style={{ fontSize: 18 }}><strong>{labels.total}</strong><strong>{money(subtotal + fee)}</strong></div>
        <div className="muted" style={{ fontSize: 13 }}>{(b.address as any)?.line1}{(b.address as any)?.line2 ? `, ${(b.address as any).line2}` : ''}</div>
        {b.customer_notes && <div style={{ fontSize: 13 }}><span className="muted">{labels.notes}:</span> {b.customer_notes}</div>}
      </section>
      <Link href="/orders" className="btn">{labels.myOrders}</Link>
    </div>
  );
}
