'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { t as tr, type Locale, type Shop } from '@suqa/shared';

type Row = Shop & { categoryName: string };
const SHOP_STATUS_LABEL: Record<string, { en: string; ar: string }> = {
  pending: { en: 'Pending approval', ar: 'بانتظار الموافقة' }, active: { en: 'Active', ar: 'فعّال' }, paused: { en: 'Paused', ar: 'متوقف' }, disabled: { en: 'Disabled', ar: 'معطّل' },
};

export default function ShopsList({ initial, locale: L, labels }: { initial: Row[]; locale: Locale; labels: Record<'approve' | 'pause' | 'resume' | 'disable' | 'minOrder', string> }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [shops, setShops] = useState(initial);
  async function setStatus(s: Row, status: Shop['status']) {
    const { error } = await sb.from('shops').update({ status }).eq('id', s.id);
    if (error) { alert(error.message); return; }
    setShops(prev => prev.map(x => x.id === s.id ? { ...x, status } : x));
  }
  const badge = (st: string) => ({ pending: 'pending', active: 'ready', paused: 'accepted', disabled: 'cancelled' } as any)[st];
  return (
    <section className="card">
      {shops.map(s => (
        <div className="product" key={s.id}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Link href={`/admin/shops/${s.id}`} className="name" style={{ textDecoration: 'none' }}>{tr(s.name, L)}</Link>
            <div className="muted" style={{ fontSize: 13 }}>{s.categoryName}{s.whatsapp ? ` · ${s.whatsapp}` : ''}{s.min_order_usd > 0 ? ` · ${labels.minOrder} $${Number(s.min_order_usd).toFixed(0)}` : ''}</div>
          </div>
          <span className={`badge ${badge(s.status)}`}>{(SHOP_STATUS_LABEL[s.status] as any)[L]}</span>
          <div className="row">
            {s.status === 'pending' && <button className="btn ok" onClick={() => setStatus(s, 'active')}>{labels.approve}</button>}
            {s.status === 'active' && <button className="btn" onClick={() => setStatus(s, 'paused')}>{labels.pause}</button>}
            {s.status === 'paused' && <button className="btn ok" onClick={() => setStatus(s, 'active')}>{labels.resume}</button>}
            {s.status !== 'disabled' && s.status !== 'pending' && <button className="btn ghost muted" onClick={() => confirm(`${labels.disable}?`) && setStatus(s, 'disabled')}>{labels.disable}</button>}
            {s.status === 'disabled' && <button className="btn" onClick={() => setStatus(s, 'active')}>{labels.resume}</button>}
          </div>
        </div>
      ))}
    </section>
  );
}
