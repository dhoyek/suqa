import { getLocale } from '@/lib/locale';
import { notFound } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { requireUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseAdmin } from '@/lib/server/supabase-admin';
import { ui, STATUS_LABEL } from '@/lib/ui-text';
import OrderTracker, { type Extra } from './OrderTracker';

export const dynamic = 'force-dynamic';

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ placed?: string }> }) {
  const [{ id }, { placed }] = await Promise.all([params, searchParams]);
  const [, tenant, sb] = await Promise.all([requireUser(`/orders/${id}`), getTenant(), supabaseServer()]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const admin = supabaseAdmin();
  // both lookups leave together: the order itself (as the signed-in customer — RLS decides whether they may see it) and
  // the two things a customer cannot read directly: who is delivering it and what has been paid. The second is used only when the first returned a row.
  const [{ data }, extraRes, L, ratingRes] = await Promise.all([
    sb.from('orders').select('*, items:order_items(*), shop:shops(id,name,slug,phone,whatsapp,address_text,min_order_usd,pickup_enabled)').eq('id', id).maybeSingle(),
    admin ? admin.from('orders').select('driver:shop_drivers(name,phone,vehicle), payments(tender,amount,currency)').eq('id', id).maybeSingle() : Promise.resolve({ data: null }),
    getLocale(tenant),
    // separate on purpose: until schema 56 is installed this one fails alone instead of taking the page with it
    sb.from('order_ratings').select('stars,comment').eq('order_id', id).maybeSingle(),
  ]);
  if (!data) notFound();
  const x = (extraRes.data ?? null) as { driver: Extra['driver'] | Extra['driver'][]; payments: Extra['payments'] } | null;
  const extra: Extra = { driver: (Array.isArray(x?.driver) ? x?.driver[0] : x?.driver) ?? null, payments: x?.payments ?? [] };
  const statusLabels = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [k, (v as Record<string, string>)[L] ?? v.en]));
  return <OrderTracker initial={data as never} extra={extra} rating={(ratingRes.data as { stars: number; comment: string | null } | null) ?? null} locale={L} fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency} timezone={tenant.timezone} justPlaced={placed === '1'}
    statusLabels={statusLabels as never}
    labels={{ orderPlaced: ui('orderPlaced', L), cancelOrder: ui('cancelOrder', L), total: ui('total', L), deliveryFee: ui('deliveryFee', L), call: ui('call', L), eta: ui('eta', L), myOrders: ui('myOrders', L), notes: ui('notes', L), threadTitle: ui('threadTitle', L), threadCustomer: ui('threadCustomer', L), threadShop: ui('threadShop', L), readyForPickup: ui('readyForPickup', L), pickedUp: ui('pickedUp', L), pickupBadge: ui('pickupBadge', L), replaceCart: ui('replaceCart', L) }} />;
}
