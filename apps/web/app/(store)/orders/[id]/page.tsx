import { notFound } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { requireUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { ui, STATUS_LABEL } from '@/lib/ui-text';
import OrderTracker from './OrderTracker';

export const dynamic = 'force-dynamic';

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ placed?: string }> }) {
  const { id } = await params;
  const { placed } = await searchParams;
  await requireUser(`/orders/${id}`);
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const { data } = await sb.from('orders').select('*, items:order_items(*), shop:shops(name,slug,phone,whatsapp)').eq('id', id).maybeSingle();
  if (!data) notFound();
  const L = tenant.default_locale;
  const statusLabels = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [k, (v as any)[L] ?? v.en]));
  return <OrderTracker initial={data as any} locale={L} fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency} justPlaced={placed === '1'}
    statusLabels={statusLabels as any}
    labels={{ orderPlaced: ui('orderPlaced', L), cancelOrder: ui('cancelOrder', L), total: ui('total', L), deliveryFee: ui('deliveryFee', L), call: ui('call', L), eta: ui('eta', L), myOrders: ui('myOrders', L), notes: ui('notes', L) }} />;
}
