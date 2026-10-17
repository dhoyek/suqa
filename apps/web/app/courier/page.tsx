import { getTenant } from '@/lib/tenant';
import { requireUser } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { ui, STATUS_LABEL } from '@/lib/ui-text';
import CourierBoard from './CourierBoard';

export const dynamic = 'force-dynamic';

export default async function CourierPage() {
  const tenant = await getTenant();
  const user = await requireUser('/courier');
  const sb = await supabaseServer();
  const { data } = await sb.from('orders')
    .select('id,number,status,basket_id,basket_seq,courier_id,address,customer_name,customer_phone,customer_notes,total_usd,delivery_fee_usd,placed_at,picked_up_at,shop:shops(name,slug,phone,address_text,location)')
    .eq('tenant_id', tenant.id).in('status', ['ready', 'out_for_delivery']).order('placed_at');
  const L = tenant.default_locale;
  const statusLabels = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [k, (v as any)[L] ?? v.en]));
  const keys = ['readyForPickup', 'myDeliveries', 'pickUp', 'markDelivered', 'noDeliveries', 'call', 'navigate', 'basket', 'collectCash', 'pickupFrom', 'deliverTo', 'live', 'takenByOther'] as const;
  const labels = Object.fromEntries(keys.map(k => [k, ui(k, L)])) as Record<typeof keys[number], string>;
  return <CourierBoard tenantId={tenant.id} me={user.id} initial={(data as any[]) ?? []} locale={L} fx={tenant.fx_lbp_rate} displayCurrency={tenant.display_currency}
    courierMode={tenant.settings.delivery_mode === 'courier'} statusLabels={statusLabels as any} labels={labels} />;
}
