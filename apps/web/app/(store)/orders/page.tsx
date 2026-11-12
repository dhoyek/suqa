import { getLocale } from '@/lib/locale';
import Link from 'next/link';
import { getTenant } from '@/lib/tenant';
import { requireUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { ui, STATUS_LABEL } from '@/lib/ui-text';
import OrdersList, { type OrderCard } from './OrdersList';
import { formatMoney, t as tr, type OrderStatus } from '@suqa/shared';

export const dynamic = 'force-dynamic';

type Item = { name: Record<string, string>; quantity: number | string };
type Row = { id: string; number: string; status: OrderStatus; fulfillment: 'delivery' | 'pickup' | null; total_usd: number | string; placed_at: string; accepted_at: string | null; delivered_at: string | null; eta_minutes: number | null;
  basket_id: string | null; shop: { name: Record<string, string>; slug: string } | null; items: Item[] };
const OPEN: OrderStatus[] = ['pending', 'accepted', 'preparing', 'ready', 'out_for_delivery'];

/** My orders: what is on its way first (with its progress), then the history — each card says what was in the order. */
export default async function OrdersPage() {
  const [user, tenant] = await Promise.all([requireUser('/orders'), getTenant()]);
  const [sb, L] = await Promise.all([supabaseServer(), getLocale(tenant)]);
  const ar = L === 'ar';
  // one query: the orders with their lines and shop (the baskets' own numbers/totals come from their parts)
  const { data } = await sb.from('orders')
    .select('id,number,status,fulfillment,total_usd,placed_at,accepted_at,delivered_at,eta_minutes,basket_id,shop:shops(name,slug),items:order_items(name,quantity)')
    .eq('customer_id', user.id).order('placed_at', { ascending: false }).limit(100);
  const rows = ((data as unknown) as Row[]) ?? [];

  type Card = { key: string; href: string; basket: boolean; number: string; placed_at: string; total: number; parts: Row[] };
  const cards: Card[] = [];
  for (const o of rows) {
    if (!o.basket_id) { cards.push({ key: o.id, href: `/orders/${o.id}`, basket: false, number: o.number, placed_at: o.placed_at, total: Number(o.total_usd), parts: [o] }); continue; }
    const g = cards.find(x => x.basket && x.key === o.basket_id);
    if (g) { g.parts.push(o); g.total += Number(o.total_usd); }
    else cards.push({ key: o.basket_id, href: `/orders/b/${o.basket_id}`, basket: true, number: o.number.replace(/-[A-Z]$/, ''), placed_at: o.placed_at, total: Number(o.total_usd), parts: [o] });
  }
  const isOpen = (c: Card) => c.parts.some(p => OPEN.includes(p.status));

  const loc = ar ? 'ar-LB-u-nu-latn' : 'en-GB';
  const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: tenant.timezone });
  const today = dayKey(new Date()), yesterday = dayKey(new Date(Date.now() - 86400000));
  const when = (iso: string) => {
    const d = new Date(iso), k = dayKey(d);
    const time = d.toLocaleTimeString(loc, { timeZone: tenant.timezone, hour: '2-digit', minute: '2-digit' });
    if (k === today) return `${ar ? 'اليوم' : 'Today'} ${time}`;
    if (k === yesterday) return `${ar ? 'أمس' : 'Yesterday'} ${time}`;
    return d.toLocaleString(loc, { timeZone: tenant.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const label = (s: OrderStatus) => (STATUS_LABEL[s] as Record<string, string>)[L];
  const statusLabels = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [k, (v as Record<string, string>)[L]])) as Record<OrderStatus, string>;
  const money = (v: number) => formatMoney(v, tenant.fx_lbp_rate, tenant.display_currency, L);
  const summary = (items: Item[]) => {
    const names = items.slice(0, 3).map(i => `${Number(i.quantity) !== 1 ? `${Number(i.quantity)}× ` : ''}${tr(i.name, L)}`).join(ar ? '، ' : ', ');
    return items.length > 3 ? `${names} +${items.length - 3}` : names;
  };
  const eta = (o: Row) => o.eta_minutes && o.accepted_at ? new Date(new Date(o.accepted_at).getTime() + o.eta_minutes * 60000).toLocaleTimeString(loc, { timeZone: tenant.timezone, hour: '2-digit', minute: '2-digit' }) : null;

  // plain data for the client list (search + filters run in the browser — no extra trips to the server)
  const view: OrderCard[] = cards.map(c => {
    const o = c.parts[0]; const items = c.parts.flatMap(p => p.items ?? []); const open = isOpen(c);
    const d = new Date(c.placed_at);
    return {
      key: c.key, href: c.href, basket: c.basket, open, number: c.number, pickup: o.fulfillment === 'pickup',
      shops: c.parts.map(p => tr(p.shop?.name, L)), parts: c.parts.map(p => ({ id: p.id, status: p.status, label: label(p.status) })),
      summary: summary(items), search: [c.number, ...c.parts.map(p => `${p.shop?.name?.ar ?? ''} ${p.shop?.name?.en ?? ''}`), ...items.map(i => `${i.name?.ar ?? ''} ${i.name?.en ?? ''}`)].join(' ').toLowerCase(),
      itemCount: items.length, when: when(c.placed_at), eta: open && !c.basket ? eta(o) : null, total: c.total, totalLabel: money(c.total),
      delivered: c.parts.some(p => p.status === 'delivered'), status: o.status,
      month: d.toLocaleDateString('en-CA', { timeZone: tenant.timezone }).slice(0, 7), monthLabel: d.toLocaleDateString(loc, { timeZone: tenant.timezone, month: 'long', year: 'numeric' }),
    };
  });

  return (
    <div className="stack">
      <div className="row spread">
        <h1 style={{ margin: 0, fontSize: 20 }}>{ui('myOrders', L)}</h1>
        <Link href="/" className="btn">{ar ? '🛒 تسوّق' : '🛒 Shop'}</Link>
      </div>
      {!cards.length ? <div className="card stack" style={{ alignItems: 'center', textAlign: 'center', padding: 28 }}>
        <div style={{ fontSize: 34 }}>🧺</div><div className="muted">{ui('noOrdersYet', L)}</div>
        <Link href="/" className="btn primary">{ar ? 'تصفّح المحلات' : 'Browse shops'}</Link>
      </div> : <OrdersList cards={view} locale={L} statusLabels={statusLabels} basketLabel={ui('basket', L)} fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency} />}
    </div>
  );
}
