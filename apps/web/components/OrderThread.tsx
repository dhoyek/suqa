'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

type Ev = { id: number; actor_kind: string; note: string | null; created_at: string };

// Messages exchanged over WhatsApp about this order (order_events with a note). Polls every 20 s + realtime when available.
export default function OrderThread({ orderId, labels, you }: { orderId: string; labels: { title: string; customer: string; shop: string }; you: 'customer' | 'shop' }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [events, setEvents] = useState<Ev[]>([]);
  useEffect(() => {
    const load = async () => {
      const { data } = await sb.from('order_events').select('id,actor_kind,note,created_at').eq('order_id', orderId).not('note', 'is', null).order('created_at');
      if (data) setEvents(data as Ev[]);
    };
    load();
    const ch = sb.channel(`events:${orderId}`).on('postgres_changes', { event: 'INSERT', schema: 'suqa', table: 'order_events', filter: `order_id=eq.${orderId}` }, load).subscribe();
    const t = setInterval(load, 20000);
    return () => { sb.removeChannel(ch); clearInterval(t); };
  }, [orderId, sb]);
  const msgs = events.filter(e => e.actor_kind === 'customer' || e.actor_kind === 'shop');
  if (!msgs.length) return null;
  return (
    <div className="thread">
      <div className="muted" style={{ fontSize: 12 }}>{labels.title}</div>
      {msgs.map(e => {
        const mine = e.actor_kind === you;
        return (
          <div key={e.id} className={`bubble ${mine ? 'mine' : ''}`}>
            <div className="who">{e.actor_kind === 'shop' ? labels.shop : labels.customer} · {new Date(e.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            {e.note}
          </div>
        );
      })}
    </div>
  );
}
