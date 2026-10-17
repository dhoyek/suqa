import { notFound } from 'next/navigation';
import { getTenant } from '@/lib/tenant';
import { requireUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { ui, STATUS_LABEL } from '@/lib/ui-text';
import BasketTracker from './BasketTracker';

export const dynamic = 'force-dynamic';

// One checkout across several shops: the basket page lists each shop's part with its own status.
export default async function BasketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ placed?: string }> }) {
  const { id } = await params;
  const { placed } = await searchParams;
  await requireUser(`/orders/b/${id}`);
  const tenant = await getTenant();
  const sb = await supabaseServer();
  const [{ data: basket }, { data: parts }] = await Promise.all([
    sb.from('baskets').select('*').eq('id', id).maybeSingle(),
    sb.from('orders').select('*, items:order_items(*), shop:shops(name,slug,phone,whatsapp)').eq('basket_id', id).order('basket_seq'),
  ]);
  if (!basket) notFound();
  const L = tenant.default_locale;
  const statusLabels = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [k, (v as any)[L] ?? v.en]));
  return <BasketTracker basket={basket as any} initial={(parts as any[]) ?? []} locale={L} fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency} justPlaced={placed === '1'}
    statusLabels={statusLabels as any}
    labels={{ orderPlaced: ui('orderPlaced', L), cancelOrder: ui('cancelOrder', L), total: ui('total', L), deliveryFee: ui('deliveryFee', L), call: ui('call', L), eta: ui('eta', L),
      myOrders: ui('myOrders', L), notes: ui('notes', L), subtotal: ui('subtotal', L), basket: ui('basket', L), basketOf: ui('basketOf', L),
      deliveredTogether: ui('deliveredTogether', L), deliveredSeparately: ui('deliveredSeparately', L), chatWhatsapp: ui('chatWhatsapp', L) }} />;
}
