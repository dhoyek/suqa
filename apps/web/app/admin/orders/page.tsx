import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { ui, STATUS_LABEL } from '@/lib/ui-text';
import { t as tr, type Shop } from '@suqa/shared';
import OrdersTable from './OrdersTable';

export const dynamic = 'force-dynamic';

export default async function AdminOrders({ searchParams }: { searchParams: Promise<{ status?: string; shop?: string; range?: string }> }) {
  const sp = await searchParams;
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const L = tenant.default_locale;
  const days = sp.range === '30' ? 30 : sp.range === '7' ? 7 : 1;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  let q = sb.from('orders').select('*, items:order_items(*), shop:shops(name)').eq('tenant_id', tenant.id).gte('placed_at', since).order('placed_at', { ascending: false }).limit(300);
  if (sp.status) q = q.eq('status', sp.status);
  if (sp.shop) q = q.eq('shop_id', sp.shop);
  const [{ data: orders }, { data: shops }] = await Promise.all([q, sb.from('shops').select('id,name').eq('tenant_id', tenant.id).order('sort_order')]);
  const statusLabels = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [k, (v as any)[L] ?? v.en]));
  return <OrdersTable orders={(orders as any[]) ?? []} shops={((shops as Shop[]) ?? []).map(s => ({ id: s.id, name: tr(s.name, L) }))}
    filters={{ status: sp.status ?? '', shop: sp.shop ?? '', range: String(days) }} locale={L} fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency} timezone={tenant.timezone}
    statusLabels={statusLabels as any}
    labels={{ orders: ui('orders', L), allShops: ui('allShops', L), allStatuses: ui('allStatuses', L), today: ui('today', L), last7days: ui('last7days', L), last30days: ui('last30days', L),
      total: ui('total', L), commission: ui('commission', L), noOrders: ui('noOrders', L), call: ui('call', L) }} />;
}
