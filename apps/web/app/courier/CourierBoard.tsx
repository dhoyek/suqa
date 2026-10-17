'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import { telLink } from '@/lib/whatsapp';
import { formatMoney, pointFromEwkb, t as tr, type DisplayCurrency, type Locale, type OrderStatus } from '@suqa/shared';

type Row = {
  id: string; number: string; status: OrderStatus; basket_id: string | null; basket_seq: string | null; courier_id: string | null;
  address: any; customer_name: string; customer_phone: string; customer_notes: string | null; total_usd: number; delivery_fee_usd: number;
  placed_at: string; picked_up_at: string | null; shop: { name: any; slug: string; phone: string | null; address_text: string | null; location: unknown } | null;
};
type Labels = Record<'readyForPickup' | 'myDeliveries' | 'pickUp' | 'markDelivered' | 'noDeliveries' | 'call' | 'navigate' | 'basket' | 'collectCash' | 'pickupFrom' | 'deliverTo' | 'live' | 'takenByOther', string>;

const mapsLink = (p: { lat: number; lng: number } | null) => p ? `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}` : null;

export default function CourierBoard(props: { tenantId: string; me: string; initial: Row[]; locale: Locale; fx: number; displayCurrency: DisplayCurrency; courierMode: boolean; statusLabels: Record<OrderStatus, string>; labels: Labels }) {
  const { tenantId, me, locale: L, fx, displayCurrency, labels, statusLabels } = props;
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<Row[]>(props.initial);
  const [live, setLive] = useState(false);
  const money = (v: number) => formatMoney(Number(v), fx, displayCurrency, L);

  async function refresh() {
    const { data } = await sb.from('orders')
      .select('id,number,status,basket_id,basket_seq,courier_id,address,customer_name,customer_phone,customer_notes,total_usd,delivery_fee_usd,placed_at,picked_up_at,shop:shops(name,slug,phone,address_text,location)')
      .eq('tenant_id', tenantId).in('status', ['ready', 'out_for_delivery']).order('placed_at');
    if (data) setRows(data as any);
  }
  useEffect(() => {
    const ch = sb.channel(`courier:${tenantId}`)
      .on('postgres_changes', { event: '*', schema: 'suqa', table: 'orders', filter: `tenant_id=eq.${tenantId}` }, refresh)
      .subscribe(s => setLive(s === 'SUBSCRIBED'));
    const t = setInterval(refresh, 20000);
    return () => { sb.removeChannel(ch); clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function pickUp(o: Row) {
    setRows(prev => prev.map(x => x.id === o.id ? { ...x, status: 'out_for_delivery', courier_id: me } : x));
    const { error } = await sb.from('orders').update({ status: 'out_for_delivery', courier_id: me }).eq('id', o.id).eq('status', 'ready').is('courier_id', null);
    if (error) { alert(friendlyError(error, L)); refresh(); }
  }
  async function delivered(o: Row) {
    setRows(prev => prev.filter(x => x.id !== o.id));
    const { error } = await sb.from('orders').update({ status: 'delivered' }).eq('id', o.id);
    if (error) { alert(friendlyError(error, L)); refresh(); }
  }

  const ready = rows.filter(r => r.status === 'ready' && !r.courier_id);
  const mine = rows.filter(r => r.courier_id === me && r.status === 'out_for_delivery');
  const others = rows.filter(r => r.status === 'out_for_delivery' && r.courier_id && r.courier_id !== me);
  // group basket parts so the driver sees "3 shops → one address"
  const groups = (list: Row[]) => Object.values(list.reduce<Record<string, Row[]>>((acc, r) => { const k = r.basket_id ?? r.id; (acc[k] ??= []).push(r); return acc; }, {}));

  const Card = ({ parts, action }: { parts: Row[]; action: 'pickup' | 'deliver' | 'none' }) => {
    const a = parts[0]; const dest = a.address ? pointFromEwkb(a.address.location) : null;
    const total = parts.reduce((s, p) => s + Number(p.total_usd), 0);
    return (
      <section className="card stack courier-card">
        <div className="row spread">
          <strong>{a.basket_id ? `🧺 ${labels.basket} ${a.number.replace(/-[A-Z]$/, '')}` : a.number}</strong>
          <span className="muted" style={{ fontSize: 13 }}>{new Date(a.placed_at).toLocaleTimeString(L === 'ar' ? 'ar-LB' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <div className="muted" style={{ fontSize: 12 }}>{labels.pickupFrom}</div>
          {parts.map(p => {
            const sp = p.shop?.location ? pointFromEwkb(p.shop.location) : null;
            return (
              <div className="row spread" key={p.id} style={{ fontSize: 14 }}>
                <span><strong>{tr(p.shop?.name, L)}</strong>{p.basket_seq ? <span className="muted"> · {p.basket_seq}</span> : null}<span className="muted"> · {money(p.total_usd)}</span></span>
                <span className="row" style={{ gap: 4 }}>
                  {p.shop?.phone && <a className="btn ghost" href={telLink(p.shop.phone) ?? '#'}>📞</a>}
                  {sp && <a className="btn ghost" href={mapsLink(sp)!} target="_blank" rel="noopener noreferrer">🗺️</a>}
                </span>
              </div>
            );
          })}
        </div>
        <div className="stack" style={{ gap: 4, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <div className="muted" style={{ fontSize: 12 }}>{labels.deliverTo}</div>
          <div className="row spread">
            <span><strong>{a.customer_name}</strong><div style={{ fontSize: 14 }}>{a.address?.line1}{a.address?.line2 ? `, ${a.address.line2}` : ''}</div>{a.address?.notes && <div className="muted" style={{ fontSize: 13 }}>{a.address.notes}</div>}</span>
            <span className="row" style={{ gap: 4 }}>
              <a className="btn ghost" href={telLink(a.customer_phone) ?? '#'}>📞</a>
              {dest && <a className="btn ghost" href={mapsLink(dest)!} target="_blank" rel="noopener noreferrer">🗺️</a>}
            </span>
          </div>
          <div className="row spread" style={{ fontSize: 14 }}><span>💵 {labels.collectCash}</span><strong>{money(total)}</strong></div>
        </div>
        {action === 'pickup' && <button className="btn primary wide" onClick={() => parts.forEach(pickUp)}>{labels.pickUp}{parts.length > 1 ? ` (${parts.length})` : ''}</button>}
        {action === 'deliver' && <button className="btn primary wide" onClick={() => parts.forEach(delivered)}>{labels.markDelivered}</button>}
        {action === 'none' && <div className="muted" style={{ fontSize: 13 }}>{labels.takenByOther}</div>}
      </section>
    );
  };

  return (
    <div className="stack">
      <div className="row spread"><h1 style={{ margin: 0, fontSize: 20 }}>{labels.myDeliveries} <span className="badge">{mine.length}</span></h1><span className={`dot ${live ? 'on' : ''}`} title={labels.live} /></div>
      {!mine.length && <div className="card muted">{labels.noDeliveries}</div>}
      {groups(mine).map(g => <Card key={g[0].basket_id ?? g[0].id} parts={g} action="deliver" />)}
      <h2 style={{ margin: '8px 0 0', fontSize: 18 }}>{labels.readyForPickup} <span className="badge">{ready.length}</span></h2>
      {!ready.length && <div className="card muted">{labels.noDeliveries}</div>}
      {groups(ready).map(g => <Card key={g[0].basket_id ?? g[0].id} parts={g} action="pickup" />)}
      {others.length > 0 && groups(others).map(g => <Card key={g[0].basket_id ?? g[0].id} parts={g} action="none" />)}
    </div>
  );
}
