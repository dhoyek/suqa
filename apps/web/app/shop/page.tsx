import { getTenant } from '@/lib/tenant';
import { supabaseServer } from '@/lib/supabase-server';
import { currentShop } from '@/lib/current-shop';
import { ui, STATUS_LABEL } from '@/lib/ui-text';
import { t as tr } from '@suqa/shared';
import OrdersBoard, { type OrderRow } from './OrdersBoard';

export const dynamic = 'force-dynamic';

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const sp = await searchParams;
  const tenant = await getTenant();
  const shop = await currentShop(sp);
  if (!shop) return null;
  const L = tenant.default_locale;
  const sb = await supabaseServer();

  // Open orders + anything closed in the last 24h.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data } = await sb
    .from('orders')
    .select('*, items:order_items(*)')
    .eq('shop_id', shop.id)
    .or(`closed_at.is.null,closed_at.gte.${since}`)
    .order('placed_at', { ascending: false });

  const labels = {
    newOrders: ui('newOrders', L), inProgress: ui('inProgress', L), done: ui('done', L), noOrders: ui('noOrders', L),
    accept: ui('accept', L), reject: ui('reject', L), rejectReason: ui('rejectReason', L),
    startPreparing: ui('startPreparing', L), markReady: ui('markReady', L), outForDelivery: ui('outForDelivery', L),
    delivered: ui('delivered', L), cancel: ui('cancel', L), confirm: ui('confirm', L), total: ui('total', L),
    delivery: ui('delivery', L), notes: ui('notes', L), call: ui('call', L), live: ui('live', L), minsAgo: ui('minsAgo', L), threadTitle: ui('threadTitle', L), threadCustomer: ui('threadCustomer', L), threadShop: ui('threadShop', L),
  };
  const statusLabels = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [k, (v as any)[L] ?? v.en]));

  return (
    <>
      <div className="row spread" style={{ marginBottom: 10 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>{tr(shop.name, L)}</h1>
      </div>
      <OrdersBoard
        key={shop.id}
        shopId={shop.id}
        initial={(data as OrderRow[]) ?? []}
        locale={L}
        fx={tenant.fx_lbp_rate}
        displayCurrency={tenant.display_currency}
        labels={labels}
        statusLabels={statusLabels as any}
      />
    </>
  );
}
