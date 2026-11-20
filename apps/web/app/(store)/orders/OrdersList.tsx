'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useConfirm, useNotify } from '@/components/ConfirmProvider';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { friendlyError } from '@/lib/ui-text';
import StatusTimeline from '@/components/StatusTimeline';
import { formatMoney, type DisplayCurrency, type OrderStatus } from '@suqa/shared';

export type OrderCard = {
  key: string; href: string; basket: boolean; open: boolean; number: string; pickup: boolean; shops: string[];
  parts: { id: string; status: OrderStatus; label: string }[]; summary: string; search: string; itemCount: number;
  when: string; eta: string | null; total: number; totalLabel: string; delivered: boolean; status: OrderStatus; month: string; monthLabel: string;
};

/** My orders: search (shop, item, number) and filter by shop / month in the browser; open orders first, then the history. */
export default function OrdersList({ cards, locale: L, statusLabels, basketLabel, fx, displayCurrency }: { cards: OrderCard[]; locale: 'ar' | 'en'; statusLabels: Record<OrderStatus, string>; basketLabel: string; fx: number; displayCurrency: DisplayCurrency }) {
  const ar = L === 'ar';
  const [q, setQ] = useState(''); const [shop, setShop] = useState(''); const [month, setMonth] = useState('');
  const shops = useMemo(() => [...new Set(cards.flatMap(c => c.shops))].sort((a, b) => a.localeCompare(b, L)), [cards, L]);
  const months = useMemo(() => { const m = new Map<string, string>(); cards.forEach(c => m.set(c.month, c.monthLabel)); return [...m.entries()]; }, [cards]);
  const list = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return cards.filter(c => (!shop || c.shops.includes(shop)) && (!month || c.month === month) && words.every(w => c.search.includes(w)));
  }, [cards, q, shop, month]);
  const active = list.filter(c => c.open), past = list.filter(c => !c.open);
  const spent = past.filter(c => c.delivered).reduce((s, c) => s + c.total, 0);
  const filtering = !!(q.trim() || shop || month);
  const showFilters = cards.length > 4 || filtering;

  // quick actions on a single order (86): cancel while pending, "I received it" once the shop has it in hand
  const router = useRouter(); const ask = useConfirm(); const notify = useNotify(); const [busy, setBusy] = useState<string | null>(null);
  const quick = async (ev: React.MouseEvent, c: OrderCard, kind: 'cancel' | 'received') => {
    ev.preventDefault(); ev.stopPropagation();
    const id = c.parts[0]?.id; if (!id) return;
    if (!(await ask(kind === 'cancel' ? (ar ? 'إلغاء هذا الطلب؟' : 'Cancel this order?') : (ar ? 'تأكيد: استلمت هذا الطلب؟' : 'Confirm: you received this order?'), { danger: kind === 'cancel' }))) return;
    setBusy(id); const sb = supabaseBrowser();
    const { error } = kind === 'cancel' ? await sb.from('orders').update({ status: 'cancelled' }).eq('id', id) : await sb.rpc('customer_confirm_received', { p_order: id });
    setBusy(null); if (error) notify(friendlyError(error, L)); else router.refresh();
  };

  const card = (c: OrderCard) => (
    <Link key={c.key} href={c.href} className={`card shop-card order-card ${c.open ? 'open' : ''}`}>
      <div className="row spread">
        <strong>{c.basket ? `🧺 ${basketLabel} · ${c.shops.join(' · ')}` : `${c.pickup ? '🛍️' : '🛵'} ${c.shops[0] ?? ''}`}</strong>
        <span className="row" style={{ gap: 4 }}>{c.parts.map(p => <span key={p.id} className={`badge ${p.status}`}>{p.label}</span>)}</span>
      </div>
      {c.itemCount > 0 && <div className="order-items">{c.summary}</div>}
      {c.open && !c.basket && <div className="order-progress"><StatusTimeline status={c.status} labels={statusLabels} pickup={c.pickup} compact /></div>}
      <div className="row spread muted" style={{ fontSize: 13 }}>
        <span>{c.when} · <span dir="ltr">{c.number}</span>{c.eta ? <> · ⏰ <span dir="ltr">{c.eta}</span></> : null}</span>
        <strong className="order-total">{c.totalLabel}</strong>
      </div>
      <div className="row spread order-foot">
        <span className="muted">{c.itemCount} {ar ? 'صنف' : c.itemCount === 1 ? 'item' : 'items'}</span>
        {!c.basket && c.status === 'pending' && <button className="btn danger" style={{ minHeight: 0, padding: '4px 10px' }} disabled={busy === c.parts[0]?.id} onClick={e => void quick(e, c, 'cancel')}>{ar ? 'إلغاء الطلب' : 'Cancel order'}</button>}
        {!c.basket && ['accepted', 'preparing', 'ready', 'out_for_delivery'].includes(c.status) && <button className="btn" style={{ minHeight: 0, padding: '4px 10px' }} disabled={busy === c.parts[0]?.id} onClick={e => void quick(e, c, 'received')}>✅ {ar ? 'استلمت' : 'Received'}</button>}
        <span className="order-go">{c.open ? (ar ? 'تتبّع الطلب ‹' : 'Track order ›') : (ar ? 'التفاصيل ‹' : 'Details ›')}</span>
      </div>
    </Link>
  );

  return (
    <>
      {showFilters && <div className="orders-filter">
        <input className="input" type="search" placeholder={ar ? '🔍 ابحث عن محل، صنف أو رقم طلب' : '🔍 Search shop, item or order number'} value={q} onChange={e => setQ(e.target.value)} />
        {shops.length > 1 && <select className="input" value={shop} onChange={e => setShop(e.target.value)} aria-label={ar ? 'المحل' : 'Shop'}><option value="">{ar ? 'كل المحلات' : 'All shops'}</option>{shops.map(s => <option key={s} value={s}>{s}</option>)}</select>}
        {months.length > 1 && <select className="input" value={month} onChange={e => setMonth(e.target.value)} aria-label={ar ? 'الشهر' : 'Month'}><option value="">{ar ? 'كل الأشهر' : 'All months'}</option>{months.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
        {filtering && <button type="button" className="btn ghost" onClick={() => { setQ(''); setShop(''); setMonth(''); }}>✕ {ar ? 'مسح' : 'Clear'}</button>}
      </div>}
      {!list.length && <div className="card muted">{ar ? 'لا طلبات مطابقة' : 'No matching orders'}</div>}
      {active.length > 0 && <>
        <div className="section-title">{ar ? 'طلبات جارية' : 'In progress'} <span className="count-pill">{active.length}</span></div>
        {active.map(card)}
      </>}
      {past.length > 0 && <>
        <div className="section-title">{ar ? 'الطلبات السابقة' : 'Past orders'} <span className="muted" style={{ fontWeight: 400 }}>· {past.length}{spent > 0 ? ` · ${formatMoney(spent, fx, displayCurrency, L)}` : ''}</span></div>
        {past.map(card)}
      </>}
    </>
  );
}
