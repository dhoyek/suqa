'use client';
import { useNotify } from '@/components/ConfirmProvider';
import { memo, useEffect, useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import { formatMoney, pointFromEwkb, t as tr, type DisplayCurrency, type Locale, type Order, type OrderItem, type OrderStatus } from '@suqa/shared';
import { waLink } from '@/lib/whatsapp';
import OrderThread from '@/components/OrderThread';

export type OrderRow = Order & { items: OrderItem[] };
type Labels = Record<'newOrders' | 'inProgress' | 'done' | 'noOrders' | 'accept' | 'reject' | 'rejectReason' | 'startPreparing' | 'markReady'
  | 'outForDelivery' | 'delivered' | 'cancel' | 'confirm' | 'total' | 'delivery' | 'notes' | 'call' | 'live' | 'minsAgo' | 'threadTitle' | 'threadCustomer' | 'threadShop'
  | 'pickupBadge' | 'readyForPickup' | 'pickedUp' | 'notifyCustomer', string>;

const OPEN: OrderStatus[] = ['accepted', 'preparing', 'ready', 'out_for_delivery'];

/** Short two-tone chime for a new order (no audio file needed). */
function beep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    [880, 1175].forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.17);
      o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.18);
    });
  } catch {}
}

type Ctx = {
  L: Locale; labels: Labels; statusLabels: Record<OrderStatus, string>; money: (v: number) => string; ago: (iso: string) => string;
  busy: string | null; notifyOn: Record<string, boolean>; setNotifyOn: (id: string, on: boolean) => void;
  setStatus: (o: OrderRow, status: OrderStatus, extra?: Record<string, unknown>) => void; startReject: (o: OrderRow) => void;
};

// Card / Column / Actions live OUTSIDE the board component. Defining them inside made React treat every render as a
// brand-new component type → full unmount/remount of every card on each click (the "page jumps" bug).
const Actions = memo(function Actions({ o, c }: { o: OrderRow; c: Ctx }) {
  const d = c.busy === o.id; const { labels } = c;
  const pickup = o.fulfillment === 'pickup';
  const go = (s: OrderStatus) => c.setStatus(o, s);
  switch (o.status) {
    case 'pending': return <div className="row">
      <button className="btn ok" disabled={d} onClick={() => go('accepted')}>{labels.accept}</button>
      <button className="btn danger" disabled={d} onClick={() => c.startReject(o)}>{labels.reject}</button></div>;
    case 'accepted':
    case 'preparing':
      // Steps are optional: a shop may jump straight to "on the way" / "ready for pickup" / delivered.
      return pickup
        ? <div className="row">
            <button className="btn primary" disabled={d} onClick={() => go('ready')}>{labels.readyForPickup}</button>
            <button className="btn ok" disabled={d} onClick={() => go('delivered')}>{labels.pickedUp}</button></div>
        : <div className="row">
            {o.status === 'accepted' && <button className="btn" disabled={d} onClick={() => go('preparing')}>{labels.startPreparing}</button>}
            <button className="btn primary" disabled={d} onClick={() => go('out_for_delivery')}>{labels.outForDelivery}</button>
            <button className="btn ok" disabled={d} onClick={() => go('delivered')}>{labels.delivered}</button></div>;
    case 'ready': return pickup
      ? <button className="btn ok" disabled={d} onClick={() => go('delivered')}>{labels.pickedUp}</button>
      : <div className="row">
          <button className="btn primary" disabled={d} onClick={() => go('out_for_delivery')}>{labels.outForDelivery}</button>
          <button className="btn ok" disabled={d} onClick={() => go('delivered')}>{labels.delivered}</button></div>;
    case 'out_for_delivery': return <button className="btn ok" disabled={d} onClick={() => go('delivered')}>{labels.delivered}</button>;
    default: return null;
  }
});

const Card = memo(function Card({ o, c }: { o: OrderRow; c: Ctx }) {
  const { L, labels, statusLabels, money, ago } = c;
  const pickup = o.fulfillment === 'pickup';
  const p = pointFromEwkb((o.address as any)?.location);
  const addrText = [o.address?.line1, o.address?.line2].filter(Boolean).join(', ') || (o.address?.label ?? '');
  const active = o.status === 'pending' || OPEN.includes(o.status);
  const notify = c.notifyOn[o.id] ?? (o.notify_customer !== false);
  return (
    <article className={`card order ${o.status}`}>
      <div className="row spread">
        <strong>{o.number}{pickup && <span className="badge" style={{ marginInlineStart: 6 }}>🛍️ {labels.pickupBadge}</span>}</strong>
        <span className={`badge ${o.status}`}>{statusLabels[o.status]}</span>
      </div>
      <div className="row spread muted" style={{ fontSize: 13 }}>
        <span>{o.customer_name}</span><span>{ago(o.placed_at)}</span>
      </div>
      <ul className="items">
        {o.items?.map(i => <li key={i.id}><span><span className="qty">{Number(i.quantity)}×</span> {tr(i.name, L)}</span><span>{money(Number(i.line_total_usd))}</span></li>)}
      </ul>
      <div className="row spread">{!pickup && <span className="muted">{labels.delivery}: {money(Number(o.delivery_fee_usd))}</span>}<strong>{labels.total}: {money(Number(o.total_usd))}</strong></div>
      {!pickup && (
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          📍 {addrText}{o.address?.notes ? ` — ${o.address.notes}` : ''}
          {p && <> · <a href={`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`} target="_blank" rel="noopener noreferrer">🗺️</a></>}
        </div>
      )}
      {o.customer_notes && <div style={{ fontSize: 13, marginTop: 4 }}><span className="muted">{labels.notes}:</span> {o.customer_notes}</div>}
      {o.reject_reason && <div className="error" style={{ marginTop: 4 }}>{o.reject_reason}</div>}
      <OrderThread orderId={o.id} you="shop" labels={{ title: labels.threadTitle, customer: labels.threadCustomer, shop: labels.threadShop }} />
      <div className="row spread" style={{ marginTop: 10, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span className="row" style={{ gap: 4 }}>
          <a className="btn icon" href={`tel:${o.customer_phone}`} title={labels.call} aria-label={labels.call}>📞</a>
          {waLink(o.customer_phone) && <a className="btn icon" href={waLink(o.customer_phone)!} target="_blank" rel="noopener noreferrer" title="WhatsApp" aria-label="WhatsApp">💬</a>}
        </span>
        <Actions o={o} c={c} />
      </div>
      {active && (
        <label className="notify-toggle" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={notify} onChange={e => c.setNotifyOn(o.id, e.target.checked)} /> 🔔 {labels.notifyCustomer}
        </label>
      )}
    </article>
  );
});

const Column = memo(function Column({ title, list, c }: { title: string; list: OrderRow[]; c: Ctx }) {
  return (
    <section>
      <div className="col-title">{title}<span className="count">{list.length}</span></div>
      <div className="stack">{list.length ? list.map(o => <Card key={o.id} o={o} c={c} />) : <div className="card muted">{c.labels.noOrders}</div>}</div>
    </section>
  );
});

export default function OrdersBoard(props: {
  shopId: string; initial: OrderRow[]; locale: Locale; fx: number; displayCurrency: DisplayCurrency;
  labels: Labels; statusLabels: Record<OrderStatus, string>;
}) {
  const { shopId, locale: L, fx, displayCurrency, labels, statusLabels } = props;
  const [orders, setOrders] = useState<OrderRow[]>(props.initial);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<OrderRow | null>(null);
  const [reason, setReason] = useState('');
  const [notifyOn, setNotifyOnState] = useState<Record<string, boolean>>({});
  const sb = useMemo(() => supabaseBrowser(), []);
  const notify = useNotify();

  async function reload() {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data } = await sb.from('orders').select('*, items:order_items(*)').eq('shop_id', shopId)
      .or(`closed_at.is.null,closed_at.gte.${since}`).order('placed_at', { ascending: false });
    if (data) setOrders(data as OrderRow[]);
  }

  // Realtime (requires suqa.orders in the supabase_realtime publication) + 20s polling fallback.
  useEffect(() => {
    const ch = sb.channel(`orders:${shopId}`)
      .on('postgres_changes', { event: '*', schema: 'suqa', table: 'orders', filter: `shop_id=eq.${shopId}` }, (payload) => {
        if (payload.eventType === 'INSERT') beep();
        reload();
      })
      .subscribe((status) => setLive(status === 'SUBSCRIBED'));
    const timer = setInterval(reload, 20000);
    return () => { sb.removeChannel(ch); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  async function setStatus(o: OrderRow, status: OrderStatus, extra: Record<string, unknown> = {}) {
    setBusy(o.id);
    const notify_customer = notifyOn[o.id] ?? (o.notify_customer !== false);
    const { error } = await sb.from('orders').update({ status, notify_customer, ...extra }).eq('id', o.id);
    setBusy(null);
    if (error) { notify(friendlyError(error, L)); return; }
    setOrders(prev => prev.map(x => x.id === o.id ? { ...x, status, notify_customer, ...extra } as OrderRow : x));
  }

  const ctx: Ctx = useMemo(() => ({
    L, labels, statusLabels, busy, notifyOn,
    money: (v: number) => formatMoney(v, fx, displayCurrency, L),
    ago: (iso: string) => `${Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))} ${labels.minsAgo}`,
    setNotifyOn: (id, on) => setNotifyOnState(prev => ({ ...prev, [id]: on })),
    setStatus, startReject: (o) => { setRejecting(o); setReason(''); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [L, labels, statusLabels, busy, notifyOn, fx, displayCurrency]);

  const pending = orders.filter(o => o.status === 'pending');
  const inProgress = orders.filter(o => OPEN.includes(o.status));
  const done = orders.filter(o => !OPEN.includes(o.status) && o.status !== 'pending');

  return (
    <>
      <div className="row muted" style={{ fontSize: 13, marginBottom: 8 }}><span className={`live-dot ${live ? 'on' : ''}`} /> {labels.live}</div>
      <div className="board">
        <Column title={labels.newOrders} list={pending} c={ctx} />
        <Column title={labels.inProgress} list={inProgress} c={ctx} />
        <Column title={labels.done} list={done} c={ctx} />
      </div>
      {rejecting && (
        <div className="sheet" onClick={() => setRejecting(null)}>
          <div className="panel stack" onClick={e => e.stopPropagation()}>
            <strong>{labels.reject} — {rejecting.number}</strong>
            <textarea className="input" rows={3} placeholder={labels.rejectReason} value={reason} onChange={e => setReason(e.target.value)} />
            <div className="row spread">
              <button className="btn" onClick={() => setRejecting(null)}>{labels.cancel}</button>
              <button className="btn danger" onClick={async () => { const o = rejecting; setRejecting(null); await setStatus(o, 'rejected', { reject_reason: reason || null }); }}>{labels.confirm}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
